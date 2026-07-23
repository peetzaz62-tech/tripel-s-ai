# Build context is the REPOSITORY ROOT (that is what RunPod's GitHub
# integration uses), so every COPY path below is written as worker/<file>.
#
# NOTE: if the build fails on the very first line, this base image tag has been
# retired — open https://hub.docker.com/r/runpod/pytorch/tags and swap in a
# current tag with cuda 12.4+ and python 3.11.
FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

WORKDIR /workspace

# ComfyUI itself. Flux.2 support is recent, so track master rather than a tag.
RUN git clone https://github.com/comfyanonymous/ComfyUI.git
WORKDIR /workspace/ComfyUI
RUN pip install --no-cache-dir -r requirements.txt

# Custom nodes the workflows depend on.
# UltimateSDUpscale is required by SSS Upscale; the Skp-to-Render graph needs no
# custom nodes because the switch/primitive nodes are resolved server-side.
RUN git clone https://github.com/ssitu/ComfyUI_UltimateSDUpscale --recursive \
      custom_nodes/ComfyUI_UltimateSDUpscale

WORKDIR /workspace
COPY worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Models are NOT baked into the image — they live on the Network Volume mounted
# at /runpod-volume. This file tells ComfyUI where to find them.
COPY worker/extra_model_paths.yaml /workspace/ComfyUI/extra_model_paths.yaml

COPY worker/handler.py .

CMD ["python3", "-u", "handler.py"]
