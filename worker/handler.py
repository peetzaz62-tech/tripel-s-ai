"""RunPod Serverless handler wrapping ComfyUI.

Receives a full API-format workflow graph + input image (base64),
runs it on the local ComfyUI instance, returns the output image as base64.

Models live on a RunPod Network Volume mounted at /runpod-volume. Rather than
relying on ComfyUI's extra_model_paths.yaml (which proved unreliable here), we
symlink the volume's model folders straight into ComfyUI/models at startup so
ComfyUI finds them through its default search paths.

input schema:
{
  "workflow": { ... },          # ComfyUI API-format graph
  "image_base64": "..."         # input image; replaces the "INPUT_IMAGE" placeholder
}
"""
import base64
import json
import os
import subprocess
import time
import uuid

import requests
import runpod

COMFYUI_URL = "http://127.0.0.1:8188"
COMFYUI_DIR = "/workspace/ComfyUI"
COMFYUI_MODELS_DIR = os.path.join(COMFYUI_DIR, "models")
COMFYUI_INPUT_DIR = os.path.join(COMFYUI_DIR, "input")
COMFYUI_OUTPUT_DIR = os.path.join(COMFYUI_DIR, "output")
VOLUME_MODELS_DIR = os.environ.get("VOLUME_MODELS_DIR", "/runpod-volume/models")
JOB_TIMEOUT_SECONDS = int(os.environ.get("COMFY_JOB_TIMEOUT", "600"))

_comfy_process = None
_models_linked = False


def inspect_volume():
    """Return a snapshot of what is actually on the volume, for diagnostics."""
    info = {
        "runpod_volume_exists": os.path.isdir("/runpod-volume"),
        "volume_models_dir": VOLUME_MODELS_DIR,
        "volume_models_exists": os.path.isdir(VOLUME_MODELS_DIR),
    }
    try:
        if os.path.isdir("/runpod-volume"):
            info["runpod_volume_top"] = sorted(os.listdir("/runpod-volume"))[:40]
        if os.path.isdir(VOLUME_MODELS_DIR):
            listing = {}
            for sub in sorted(os.listdir(VOLUME_MODELS_DIR)):
                p = os.path.join(VOLUME_MODELS_DIR, sub)
                if os.path.isdir(p):
                    listing[sub] = sorted(os.listdir(p))[:20]
            info["volume_models_tree"] = listing
    except Exception as e:  # noqa: BLE001
        info["inspect_error"] = str(e)
    return info


def link_models():
    """Symlink each model subfolder from the volume into ComfyUI/models.

    For folders that already exist in the image (vae, clip, checkpoints...),
    link the individual files in so nothing is destroyed; for new folders,
    symlink the whole directory.
    """
    global _models_linked
    if _models_linked:
        return {"already_linked": True}
    if not os.path.isdir(VOLUME_MODELS_DIR):
        return {"error": "volume models dir not found", **inspect_volume()}

    os.makedirs(COMFYUI_MODELS_DIR, exist_ok=True)
    linked = []
    for sub in os.listdir(VOLUME_MODELS_DIR):
        src = os.path.join(VOLUME_MODELS_DIR, sub)
        if not os.path.isdir(src):
            continue
        dst = os.path.join(COMFYUI_MODELS_DIR, sub)
        if os.path.islink(dst):
            os.unlink(dst)
            os.symlink(src, dst)
            linked.append(f"{sub} (relinked dir)")
        elif os.path.isdir(dst):
            for f in os.listdir(src):
                fdst = os.path.join(dst, f)
                if not os.path.exists(fdst):
                    os.symlink(os.path.join(src, f), fdst)
            linked.append(f"{sub} (merged files)")
        else:
            os.symlink(src, dst)
            linked.append(f"{sub} (new dir)")
    _models_linked = True
    return {"linked": linked}


def start_comfyui():
    global _comfy_process
    if _comfy_process is not None:
        return
    _comfy_process = subprocess.Popen(
        ["python3", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
        cwd=COMFYUI_DIR,
    )
    for _ in range(180):
        try:
            r = requests.get(f"{COMFYUI_URL}/system_stats", timeout=2)
            if r.status_code == 200:
                return
        except requests.exceptions.RequestException:
            pass
        time.sleep(1)
    raise RuntimeError("ComfyUI did not start in time — check container logs")


def save_input_image(image_b64: str) -> str:
    filename = f"input_{uuid.uuid4().hex}.png"
    os.makedirs(COMFYUI_INPUT_DIR, exist_ok=True)
    with open(os.path.join(COMFYUI_INPUT_DIR, filename), "wb") as f:
        f.write(base64.b64decode(image_b64))
    return filename


def patch_workflow(workflow: dict, image_filename: str) -> dict:
    for node in workflow.values():
        if node.get("class_type") == "LoadImage":
            node["inputs"]["image"] = image_filename
    return workflow


def queue_prompt(workflow: dict) -> str:
    resp = requests.post(
        f"{COMFYUI_URL}/prompt",
        json={"prompt": workflow, "client_id": str(uuid.uuid4())},
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ComfyUI rejected the workflow: {resp.text[:2000]}")
    return resp.json()["prompt_id"]


def wait_for_completion(prompt_id: str) -> dict:
    start = time.time()
    while time.time() - start < JOB_TIMEOUT_SECONDS:
        resp = requests.get(f"{COMFYUI_URL}/history/{prompt_id}", timeout=10)
        resp.raise_for_status()
        history = resp.json()
        if prompt_id in history:
            status = history[prompt_id].get("status", {})
            if status.get("completed"):
                return history[prompt_id]
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI run failed: {json.dumps(status)[:2000]}")
        time.sleep(2)
    raise TimeoutError(f"ComfyUI did not finish within {JOB_TIMEOUT_SECONDS}s")


def extract_output_image(history_entry: dict) -> str:
    for node_output in history_entry.get("outputs", {}).values():
        for info in node_output.get("images") or []:
            if info.get("type") != "output":
                continue
            path = os.path.join(
                COMFYUI_OUTPUT_DIR, info.get("subfolder", ""), info["filename"]
            )
            with open(path, "rb") as f:
                return base64.b64encode(f.read()).decode("utf-8")
    raise ValueError("No output image found — check the SaveImage node in the workflow")


def handler(event):
    try:
        job_input = event.get("input") or {}

        # a bare {"input": {"debug": true}} returns what the worker sees on the
        # volume without running anything — handy for setup verification
        if job_input.get("debug"):
            link_result = link_models()
            return {"debug": {"volume": inspect_volume(), "link": link_result}}

        workflow = job_input.get("workflow")
        image_b64 = job_input.get("image_base64")
        if not workflow or not image_b64:
            return {"error": "bad_request", "message": "workflow and image_base64 are required"}

        link_result = link_models()
        start_comfyui()
        image_filename = save_input_image(image_b64)
        workflow = patch_workflow(workflow, image_filename)
        try:
            prompt_id = queue_prompt(workflow)
        except RuntimeError as e:
            # most commonly a missing-model validation error — attach what the
            # worker actually sees so the cause is obvious without another round trip
            return {
                "error": "processing_failed",
                "message": str(e),
                "debug": {"volume": inspect_volume(), "link": link_result},
            }
        history_entry = wait_for_completion(prompt_id)
        output_b64 = extract_output_image(history_entry)
        return {"output_image_base64": output_b64, "prompt_id": prompt_id}

    except TimeoutError as e:
        return {"error": "timeout", "message": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"error": "processing_failed", "message": str(e)}


runpod.serverless.start({"handler": handler})
