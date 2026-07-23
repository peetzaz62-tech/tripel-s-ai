"""RunPod Serverless handler wrapping ComfyUI.

Receives a full API-format workflow graph + input image (base64),
runs it on the local ComfyUI instance, returns the output image as base64.

input schema:
{
  "workflow": { ... },          # ComfyUI API-format graph (built by the web backend)
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
COMFYUI_INPUT_DIR = os.path.join(COMFYUI_DIR, "input")
COMFYUI_OUTPUT_DIR = os.path.join(COMFYUI_DIR, "output")
# Must stay below the endpoint's Execution Timeout configured in RunPod console.
JOB_TIMEOUT_SECONDS = int(os.environ.get("COMFY_JOB_TIMEOUT", "600"))

_comfy_process = None


def start_comfyui():
    global _comfy_process
    if _comfy_process is not None:
        return
    _comfy_process = subprocess.Popen(
        ["python3", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
        cwd=COMFYUI_DIR,
    )
    for _ in range(180):  # cold start with big Flux models can be slow
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
        # surface ComfyUI validation errors (missing model, bad node) verbatim
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
        images = node_output.get("images") or []
        for info in images:
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
        workflow = job_input.get("workflow")
        image_b64 = job_input.get("image_base64")
        if not workflow or not image_b64:
            return {"error": "bad_request", "message": "workflow and image_base64 are required"}

        start_comfyui()
        image_filename = save_input_image(image_b64)
        workflow = patch_workflow(workflow, image_filename)
        prompt_id = queue_prompt(workflow)
        history_entry = wait_for_completion(prompt_id)
        output_b64 = extract_output_image(history_entry)
        return {"output_image_base64": output_b64, "prompt_id": prompt_id}

    except TimeoutError as e:
        return {"error": "timeout", "message": str(e)}
    except Exception as e:  # noqa: BLE001 — report everything back to the caller
        return {"error": "processing_failed", "message": str(e)}


runpod.serverless.start({"handler": handler})
