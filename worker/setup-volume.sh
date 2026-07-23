#!/usr/bin/env bash
# Run this INSIDE a temporary RunPod pod that has the Network Volume attached.
# It verifies the volume, creates the folder layout, and pulls the models.
#
#   export HF_TOKEN=hf_xxx
#   bash setup-volume.sh
#
# Downloads use aria2c with 16 parallel connections. Hugging Face throttles a
# single connection hard (~5 MB/s), which turns this into a 7-hour job; with
# parallel connections the same transfer usually runs 10-30x faster.
# Every download resumes, so re-running after a stop is safe.

set -u
VOL="${VOL:-/workspace}"
M="$VOL/models"

# --- volume sanity check -----------------------------------------------------
# If the Network Volume is not actually mounted here, everything downloaded is
# on the pod's ephemeral disk and disappears when the pod is terminated.
echo "=== Checking that $VOL is the Network Volume ==="
df -h "$VOL" | tail -1
AVAIL_GB=$(df -BG --output=avail "$VOL" | tail -1 | tr -dc '0-9')
echo
if [ "${AVAIL_GB:-0}" -lt 150 ]; then
  echo "!! Only ${AVAIL_GB}GB free at $VOL."
  echo "!! A 200GB Network Volume should show far more than that."
  echo "!! If the volume is mounted elsewhere, re-run as:  VOL=/its/path bash $0"
  read -r -p "Continue anyway? [y/N] " ans
  [ "${ans:-N}" = "y" ] || exit 1
else
  echo "OK — ${AVAIL_GB}GB free, looks like the volume."
fi

mkdir -p "$M"/{diffusion_models,clip,text_encoders,vae,loras,upscale_models}

# --- downloader --------------------------------------------------------------
if ! command -v aria2c >/dev/null 2>&1; then
  echo "Installing aria2..."
  apt-get update -qq && apt-get install -y -qq aria2 || echo "aria2 install failed, falling back to wget"
fi

if [ -n "${HF_TOKEN:-}" ]; then
  echo "Using HF_TOKEN for gated downloads"
else
  echo "HF_TOKEN not set — gated FLUX downloads will fail until you export it"
fi

# fetch <url> <destination>
fetch() {
  local url="$1" dest="$2" dir name
  dir="$(dirname "$dest")"; name="$(basename "$dest")"

  if [ -z "$url" ] || [[ "$url" == PASTE_* ]]; then
    echo "  TODO (no URL yet): $name"; return 0
  fi
  if [ -s "$dest" ] && [ ! -f "$dest.aria2" ]; then
    echo "  skip (already complete): $name"; return 0
  fi

  echo "  downloading: $name"
  if command -v aria2c >/dev/null 2>&1; then
    aria2c -c -x 16 -s 16 -k 1M --file-allocation=none --summary-interval=10 \
           ${HF_TOKEN:+--header="Authorization: Bearer $HF_TOKEN"} \
           -d "$dir" -o "$name" "$url" \
      || { echo "  FAILED: $name"; return 0; }
  else
    wget -q --show-progress -c ${HF_TOKEN:+--header="Authorization: Bearer $HF_TOKEN"} \
         "$url" -O "$dest" || { echo "  FAILED: $name"; rm -f "$dest"; return 0; }
  fi
}

echo
echo "=== Upscale workflow (~32 GB) ==="
fetch "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp16.safetensors" \
      "$M/clip/t5xxl_fp16.safetensors"
fetch "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors" \
      "$M/clip/clip_l.safetensors"
fetch "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth" \
      "$M/upscale_models/RealESRGAN_x4plus.pth"
# Gated — accept the licence at huggingface.co/black-forest-labs/FLUX.1-dev first
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
find "$M" -type f \( -name '*.safetensors' -o -name '*.pth' \) -printf '%10s  %p\n' \
  | awk '{printf "%8.2f GB  %s\n", $1/1073741824, $2}'
echo; echo -n "Total on volume: "; du -sh "$M" | cut -f1
echo
echo "Incomplete downloads (if any):"; find "$M" -name '*.aria2' -printf '  %p\n' || true
cat << 'NOTE'

Anything still marked TODO has to come from somewhere else:
  1. Find its Hugging Face page, copy the file URL, paste it above, re-run.
  2. Or send it from your own machine with runpodctl:
        on your PC:   runpodctl send  "C:\path\to\model.safetensors"
        in this pod:  runpodctl receive <code-it-prints>
NOTE
