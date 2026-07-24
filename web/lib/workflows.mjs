// ComfyUI API-format graph builders (server-side only).
// Node ids match the original SSS workflow exports.
// LoadImage nodes use the "INPUT_IMAGE" placeholder — the RunPod worker
// swaps in the real uploaded filename before queueing.

export function buildMagnificGraph(opts) {
  return {
    "1": { class_type: "LoadImage", inputs: { image: "INPUT_IMAGE" } },
    "2": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev-fp8.safetensors", weight_dtype: "default" } },
    "3": { class_type: "DualCLIPLoader", inputs: { clip_name1: "t5xxl_fp8_e4m3fn.safetensors", clip_name2: "clip_l.safetensors", type: "flux", device: "default" } },
    "4": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
    "5": { class_type: "UpscaleModelLoader", inputs: { model_name: "RealESRGAN_x4plus.pth" } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: opts.prompt || "", clip: ["3", 0] } },
    "7": { class_type: "FluxGuidance", inputs: { conditioning: ["6", 0], guidance: 3.5 } },
    "8": { class_type: "UltimateSDUpscale", inputs: {
      image: ["1", 0], model: ["2", 0], positive: ["7", 0], negative: ["7", 0], vae: ["4", 0], upscale_model: ["5", 0],
      upscale_by: opts.upscaleBy, seed: opts.seed, steps: opts.steps, cfg: opts.cfg,
      sampler_name: "euler", scheduler: "simple", denoise: opts.denoise,
      mode_type: "Linear", tile_width: 1024, tile_height: 1024, mask_blur: 8, tile_padding: 32,
      seam_fix_mode: "None", seam_fix_denoise: 1, seam_fix_width: 64, seam_fix_mask_blur: 8, seam_fix_padding: 16,
      force_uniform_tiles: true, tiled_decode: false, batch_size: 1,
    } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "upscale_studio" } },
  };
}

export function buildSSSGraph(opts) {
  // turbo is resolved server-side (model chain + step count picked here),
  // so the graph needs no switch custom-nodes.
  const modelRef = opts.turbo ? ["68:89", 0] : ["68:12", 0];
  const steps = opts.turbo ? 8 : 20;

  const graph = {
    "125": { class_type: "LoadImage", inputs: { image: "INPUT_IMAGE" } },
    "45": { class_type: "ImageScaleToTotalPixels", inputs: { upscale_method: "lanczos", megapixels: opts.megapixels, resolution_steps: 1, image: ["125", 0] } },

    "68:38": { class_type: "CLIPLoader", inputs: { clip_name: "mistral_3_small_flux2_bf16.safetensors", type: "flux2", device: "default" } },
    "68:12": { class_type: "UNETLoader", inputs: { unet_name: "flux2-dev.safetensors", weight_dtype: "default" } },
    "68:10": { class_type: "VAELoader", inputs: { vae_name: "full_encoder_small_decoder.safetensors" } },

    "68:6": { class_type: "CLIPTextEncode", inputs: { text: opts.prompt, clip: ["68:38", 0] } },
    "68:26": { class_type: "FluxGuidance", inputs: { guidance: opts.guidance, conditioning: ["68:6", 0] } },

    "68:44": { class_type: "VAEEncode", inputs: { pixels: ["45", 0], vae: ["68:10", 0] } },
    "68:43": { class_type: "ReferenceLatent", inputs: { conditioning: ["68:26", 0], latent: ["68:44", 0] } },
    "68:72": { class_type: "GetImageSize", inputs: { image: ["45", 0] } },
    "68:47": { class_type: "EmptyFlux2LatentImage", inputs: { width: ["68:72", 0], height: ["68:72", 1], batch_size: 1 } },
    "68:48": { class_type: "Flux2Scheduler", inputs: { steps, width: ["68:72", 0], height: ["68:72", 1] } },

    "68:25": { class_type: "RandomNoise", inputs: { noise_seed: opts.seed } },
    "68:16": { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } },
    "68:22": { class_type: "BasicGuider", inputs: { model: modelRef, conditioning: ["68:43", 0] } },
    "68:13": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["68:25", 0], guider: ["68:22", 0], sampler: ["68:16", 0], sigmas: ["68:48", 0], latent_image: ["68:47", 0] } },
    "68:8": { class_type: "VAEDecode", inputs: { samples: ["68:13", 0], vae: ["68:10", 0] } },

    "9": { class_type: "SaveImage", inputs: { images: ["68:8", 0], filename_prefix: "SSS" } },
  };

  if (opts.turbo) {
    graph["68:89"] = { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "Flux_2-Turbo-LoRA_comfyui.safetensors", strength_model: 1, model: ["68:12", 0] } };
  }
  return graph;
}
