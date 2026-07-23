FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /workspace

RUN git clone https://github.com/comfyanonymous/ComfyUI.git
WORKDIR /workspace/ComfyUI
RUN pip install --no-cache-dir -r requirements.txt

# Custom nodes required by the SSS workflows
RUN git clone https://github.com/ssitu/ComfyUI_UltimateSDUpscale --recursive custom_nodes/ComfyUI_UltimateSDUpscale

WORKDIR /workspace
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Models live on a RunPod Network Volume mounted at /runpod-volume
# (see README-DEPLOY.md for the exact folder layout expected there).
COPY extra_model_paths.yaml /workspace/ComfyUI/extra_model_paths.yaml

COPY handler.py .

CMD ["python3", "-u", "handler.py"]
