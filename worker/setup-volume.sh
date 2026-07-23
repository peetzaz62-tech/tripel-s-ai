#!/usr/bin/env bash
# Run this INSIDE a temporary RunPod pod that has the Network Volume attached.
# It creates the folder layout and pulls the models it can fetch directly.
#
#   bash setup-volume.sh
#
# Downloading from inside the pod runs at datacenter speed (often >1 Gbps),
# which is the whole point — do not upload these from a home connection if a
# public URL exists.

set -u
VOL="${VOL:-/workspace}"   # the volume mounts at /workspace on a pod
                           # (on the serverless endpoint it is /runpod-volume)
M="$VOL/models"

mkdir -p "$M"/{diffusion_models,clip,text_encoders,vae,loras,upscale_models}
echo "Folders ready under $M"

# Gated repos (FLUX.1 / FLUX.2) need a Hugging Face token with the licence
# accepted on the model page. Export it before running:  export HF_TOKEN=hf_xxx
AUTH=()
if [ -n "${HF_TOKEN:-}" ]; then
  AUTH=(--header "Authorization: Bearer $HF_TOKEN")
  echo "Using HF_TOKEN for gated downloads"
else
  echo "HF_TOKEN not set — gated FLUX downloads will fail until you export it"
fi

# fetch <url> <destination>  — skips files that are already complete
fetch() {
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then
    echo "  skip (exists): $(basename "$dest")"
    return 0
  fi
  if [ -z "$url" ] || [[ "$url" == PASTE_* ]]; then
    echo "  TODO (no URL yet): $(basename "$dest")"
    return 0
  fi
  echo "  downloading: $(basename "$dest")"
  wget -q --show-progress -c "${AUTH[@]}" "$url" -O "$dest" || {
    echo "  FAILED: $(basename "$dest") — check the URL and your HF_TOKEN"
    rm -f "$dest"
  }
}

echo
echo "=== Upscale workflow (~32 GB) ==="
# Public, no token required:
fetch "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors" \
      "$M/clip/t5xxl_fp16.safetensors"
fetch "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors" \
      "$M/clip/clip_l.safetensors"
fetch "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth" \
      "$M/upscale_models/RealESRGAN_x4plus.pth"
# Gated — accept the licence at huggingface.co/black-forest-labs/FLUX.1-dev first:
fetch "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors" \
      "$M/diffusion_models/flux1-dev.safetensors"
fetch "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors" \
      "$M/vae/ae.safetensors"

echo
echo "=== Sketchup-to-Render workflow (~96 GB) ==="
# FLUX.2 is new enough that the exact repo paths move around. Open the model's
# Hugging Face page, right-click the download arrow next to the file, copy the
# link (it looks like .../resolve/main/<filename>) and paste it below.
fetch "PASTE_FLUX2_DEV_URL" \
      "$M/diffusion_models/flux2-dev.safetensors"
fetch "PASTE_MISTRAL_URL" \
      "$M/text_encoders/mistral_3_small_flux2_bf16.safetensors"
fetch "PASTE_FLUX2_VAE_URL" \
      "$M/vae/full_encoder_small_decoder.safetensors"
fetch "PASTE_TURBO_LORA_URL" \
      "$M/loras/Flux_2-Turbo-LoRA_comfyui.safetensors"

echo
echo "=== Result ==="
du -sh "$M"/* 2>/dev/null
echo
echo "Total on volume:"; du -sh "$M"
cat << 'NOTE'

Anything still marked TODO has to come from somewhere else. Two options:
  1. Find its Hugging Face page, copy the file URL, re-run this script.
  2. Send it from your own machine with runpodctl (works around the browser
     upload limit):
        on your PC:   runpodctl send  "C:\path\to\model.safetensors"
        in this pod:  runpodctl receive <code-it-prints>
     Then move the file into the right folder above.
NOTE
