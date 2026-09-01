
function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  var el = document.getElementById('view-'+name);
  if(el) el.classList.add('active');
  window.scrollTo(0,0);
}


// ===================== APP SCRIPT =====================

// ---------------------------------------------------------------------------
// API-format prompt template for the detail engine of SSS Upscale:
// LoadImage -> 4x-UltraSharp -> ImageScaleBy(down to target)
//           -> UltimateSDUpscaleNoUpscale -> SaveImage.
//
// The ESRGAN went out on 2026-08-18 and came back on 2026-08-26. Both moves
// were measured, and they measured different things, so keep both numbers.
//
// Why it went out: on a 3904x2112 exterior, comparing native-resolution crops
// region by region, essentially all of the grain people complained about was
// made by the ESRGAN turning the source's fine pixel noise into blotchy mottle.
// Plain lanczos cut it hard on every flat man-made surface:
//   window frame  3.08 -> 0.87   balcony glass 2.84 -> 0.80
//   concrete slab 2.22 -> 0.74   block wall    2.18 -> 0.73
//   paving block  2.12 -> 1.23   road asphalt  1.19 -> 0.58
// costing 10-19% edge sharpness there. The loss recorded at the time was grass
// (sharp 127 -> 105, blades blurring together).
//
// Why it came back: that recorded loss turned out to be the thing that matters
// on planted frames. On a lake scene full of trees and reeds, the ESRGAN route
// kept the render's own foliage — same crown, same blades — where lanczos let
// the diffusion pass soften it. peetz saw both and chose the ESRGAN on
// 2026-08-26, grain and all. The grain finding above is still true; it is a
// trade, not a mistake, and Denoise is the knob that trims it back.
//
// The ESRGAN runs INSIDE UltimateSDUpscale, not as its own node ahead of it.
// That is not a style choice. Built the obvious way first — ImageUpscaleWithModel
// -> ImageScaleBy -> UltimateSDUpscaleNoUpscale — the ESRGAN step alone took
// 18 minutes on a 2560x1440 frame (03:45 to 04:03 in the ComfyUI log) where the
// same model on the same image takes 23 seconds from a cold card. The previous
// run had left flux1-dev-fp8 resident, ComfyUI logged "0 models unloaded" and
// gave RRDBNet the 0.9GB that was left, so it crawled through a 10240x5760
// intermediate in a memory budget far too small for it. UltimateSDUpscale
// sequences its own upscale against its own model loads and does the whole job
// in 421s. Do not split it back out.
// ---------------------------------------------------------------------------
function buildMagnificPrompt(opts){
  return {
    "1": { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    "2": { class_type:"UNETLoader", inputs:{ unet_name:"flux1-dev-fp8.safetensors", weight_dtype:"default" } },
    "3": { class_type:"DualCLIPLoader", inputs:{ clip_name1:"t5xxl_fp8_e4m3fn.safetensors", clip_name2:"clip_l.safetensors", type:"flux", device:"default" } },
    "4": { class_type:"VAELoader", inputs:{ vae_name:"ae.safetensors" } },
    "6": { class_type:"CLIPTextEncode", inputs:{ text: opts.prompt || "", clip:["3",0] } },
    "7": { class_type:"FluxGuidance", inputs:{ conditioning:["6",0], guidance:3.5 } },
    "5": { class_type:"UpscaleModelLoader", inputs:{ model_name:"4x-UltraSharp.pth" } },
    "8": { class_type:"UltimateSDUpscale", inputs:{
        image:["1",0], upscale_by: opts.upscaleBy, upscale_model:["5",0],
        model:["2",0], positive:["7",0], negative:["7",0], vae:["4",0],
        // CFG is pinned to 1 and is not a user control. Node "8" wires negative
        // to the same conditioning as positive, so out = neg + cfg*(pos-neg)
        // = neg at every scale — cfg cannot change this image. ComfyUI only
        // skips evaluating the uncond branch when cfg is exactly 1.0, so any
        // higher value paid for a second forward pass and threw it away.
        // Measured 2026-08-06 on one 2MP source: cfg 8 = 505s, cfg 1 = 233s,
        // and the difference image between the two is flat black.
        seed: opts.seed, steps: opts.steps, cfg: 1,
        sampler_name:"euler", scheduler:"simple", denoise: opts.denoise,
        mode_type:"Linear", tile_width:1024, tile_height:1024, mask_blur:8, tile_padding:32,
        seam_fix_mode:"None", seam_fix_denoise:1, seam_fix_width:64, seam_fix_mask_blur:8, seam_fix_padding:16,
        force_uniform_tiles:true, tiled_decode:false, batch_size:1
      } },
    "9": { class_type:"SaveImage", inputs:{ images:["8",0], filename_prefix:"upscale_studio" } }
  };
}
const SAVE_IMAGE_NODE_ID_MAGNIFIC = "9";

// ---------------------------------------------------------------------------
// The second engine behind SSS Upscale: SeedVR2 7B int8, for interiors.
//
// It is a restoration model, not a refiner. There is no text encoder anywhere
// in this graph — SeedVR2Conditioning builds both conditionings out of the VAE
// latent alone — so Extra prompt, Denoise and Steps have nothing to attach to
// and the UI hides them. One sampler step at denoise 1, and that is the whole
// run: 93s on a 2560x1440 frame against 421s for the detail engine.
//
// Measured 2026-08-26 on peetz's own frames, and the split is sharp enough to
// be the reason this is a choice rather than a replacement:
//
//   interior, hard surfaces   excellent, and 4.5x faster
//   anything planted          it redraws the planting
//
// On a lake frame it kept only 0.48 structural agreement with the render in the
// tree and the reeds (a plain ESRGAN keeps 0.76) — a different crown, different
// leaf shape, grass blades smoothed into a smear. It is doing what it was
// trained to do: treat busy texture as compression damage and rebuild it. An
// interior is nearly all flat man-made surface, where that prior is right.
//
// Two knobs were swept and neither helps, so do not reach for them again:
// more steps makes it worse (structural agreement 0.72 at 1 step, 0.59 at 8),
// and color_correction only fixes the acid-green tint, never the redrawing.
// ---------------------------------------------------------------------------
function buildSeedVR2Prompt(opts){
  return {
    "1":  { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    "2":  { class_type:"UNETLoader", inputs:{ unet_name:"seedvr2_7b_int8_convrot.safetensors", weight_dtype:"default" } },
    "3":  { class_type:"VAELoader", inputs:{ vae_name:"seedvr2_ema_vae_fp16.safetensors" } },
    // Carry LoadImage's mask channel through as alpha so PostProcessing can put
    // it back; Preprocess drops it before the model ever sees it.
    "4":  { class_type:"JoinImageWithAlpha", inputs:{ image:["1",0], alpha:["1",1] } },
    "5":  { class_type:"ResizeImageMaskNode", inputs:{
        resize_type:"scale by multiplier", "resize_type.multiplier": opts.upscaleBy,
        scale_method:"lanczos", input:["4",0] } },
    "6":  { class_type:"SeedVR2Preprocess", inputs:{ resized_images:["5",0] } },
    "7":  { class_type:"VAEEncodeTiled", inputs:{ tile_size:512, overlap:128, temporal_size:4096, temporal_overlap:8, pixels:["6",0], vae:["3",0] } },
    "8":  { class_type:"SeedVR2Conditioning", inputs:{ model:["2",0], vae_conditioning:["7",0] } },
    "12": { class_type:"KSampler", inputs:{
        seed: opts.seed, steps:1, cfg:1, sampler_name:"euler", scheduler:"simple", denoise:1,
        model:["2",0], positive:["8",0], negative:["8",1], latent_image:["7",0] } },
    "13": { class_type:"VAEDecodeTiled", inputs:{ tile_size:512, overlap:128, temporal_size:4096, temporal_overlap:8, samples:["12",0], vae:["3",0] } },
    // 'lab' matches the result's colours back to the source in CIELAB. The
    // ComfyUI template ships this as 'none', which lets the greens come back
    // 38% more saturated than the render; the node's own default is 'lab'.
    "14": { class_type:"SeedVR2PostProcessing", inputs:{ color_correction_method:"lab", images:["13",0], original_resized_images:["5",0] } },
    "15": { class_type:"SaveImage", inputs:{ images:["14",0], filename_prefix:"upscale_studio" } }
  };
}
const SAVE_IMAGE_NODE_ID_SEEDVR2 = "15";

// Which engine the Upscale card is set to, and the model family it loads.
// SeedVR2 is a third family alongside flux1 and flux2, so freeIfModelSwitch has
// to be told about it or a stale FLUX load would sit in VRAM beside it.
function upscaleEngine(){
  const el = $('pEngine');
  return el && el.value === 'seedvr2' ? 'seedvr2' : 'usdu';
}
function buildUpscalePrompt(opts){
  return upscaleEngine() === 'seedvr2' ? buildSeedVR2Prompt(opts) : buildMagnificPrompt(opts);
}
function upscaleSaveNodeId(){
  return upscaleEngine() === 'seedvr2' ? SAVE_IMAGE_NODE_ID_SEEDVR2 : SAVE_IMAGE_NODE_ID_MAGNIFIC;
}
function upscaleModelKind(){
  return upscaleEngine() === 'seedvr2' ? 'seedvr2' : 'flux1';
}

// FLUX.2 Dev is gone from this file. It served Skp to Render, Add People and
// Sketch to Add until 2026-09-02, when peetz moved every mode onto Klein 9B.
// Three things it knew that are worth not rediscovering:
//
//  - Its Denoise slider was a step count wearing a percentage. SplitSigmasDenoise
//    cuts on whole steps, so on Turbo's 8 the whole slider collapsed into three
//    bands: <=0.80 kept the render look, 0.85-0.93 became a photograph, >=0.95
//    was identical to 1. Values inside a band were pixel-identical.
//  - Its Turbo LoRA lightened dark materials — it is what turned a dark grey
//    fridge stainless — so it was left out of the graph rather than switched.
//  - Its mask worked at the latent level, which Klein's cannot: see
//    buildKleinSketchPrompt for what replaced it.
//
// Klein is 5-10x faster on every mode measured. The one place FLUX.2 was still
// ahead is Add People, where it held the approved photograph to 6.64 mean
// difference against Klein's 14.46 — peetz took the speed anyway on 2026-09-02.

// Skp to Render on Flux.2 Klein 9B distilled.
//
// Measured against the 18 real Before/After pairs on 2026-08-31: 5.5x faster
// than flux2-dev (33s against 181s at 2.5MP), 36% less colour drift, and it
// does NOT invent the light panel on a blank wall that nothing could stop on
// flux2 — see the notes on that failure in the interior lighting section.
// It holds geometry less tightly than flux2 (0.185 against 0.335), which is the
// price, and it is weakest on aerial masterplans and on sources whose sky is
// blank grey.
//
// Shape follows image_flux2_klein_image_edit_9b_distilled exactly: 4 steps, a
// CFGGuider pinned to cfg 1 against a zeroed negative, and the source arriving
// as conditioning through ReferenceLatent. Three consequences worth knowing:
//
//   - There is no FluxGuidance node. Klein is guidance-distilled, so the
//     Guidance control has nothing to act on and is hidden for this engine.
//   - Steps swept 4/8/12/20 on three frames: brightness flat, deep shadow gets
//     WORSE (0.98 -> 0.49), time 3.7x. 4 is not a floor to raise, it is right.
//   - The sampler starts from an empty latent, so there is no img2img branch
//     and no mask to hang on it. Sketch to Add and Add People stay on flux2 for
//     that reason and because flux2 measurably draws the better tree.
function buildKleinPrompt(opts){
  const g = {
    "1":  { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    "2":  opts.scaleTo
      ? { class_type:"ImageScale", inputs:{ upscale_method:"lanczos", width: opts.scaleTo[0], height: opts.scaleTo[1], crop:"disabled", image:["1",0] } }
      : { class_type:"ImageScaleToTotalPixels", inputs:{ upscale_method:"lanczos", megapixels: opts.megapixels, resolution_steps:1, image:["1",0] } },
    "3":  { class_type:"UNETLoader", inputs:{ unet_name:"flux-2-klein-9b-fp8.safetensors", weight_dtype:"default" } },
    "4":  { class_type:"CLIPLoader", inputs:{ clip_name:"qwen_3_8b_fp8mixed.safetensors", type:"flux2", device:"default" } },
    "5":  { class_type:"VAELoader", inputs:{ vae_name:"full_encoder_small_decoder.safetensors" } },
    "6":  { class_type:"CLIPTextEncode", inputs:{ text: opts.prompt, clip:["4",0] } },
    "7":  { class_type:"ConditioningZeroOut", inputs:{ conditioning:["6",0] } },
    "8":  { class_type:"VAEEncode", inputs:{ pixels:["2",0], vae:["5",0] } },
    "9b": { class_type:"ReferenceLatent", inputs:{ conditioning:["6",0], latent:["8",0] } },
    "10": { class_type:"GetImageSize", inputs:{ image:["2",0] } },
    "11": { class_type:"EmptyFlux2LatentImage", inputs:{ width:["10",0], height:["10",1], batch_size:1 } },
    "12": { class_type:"Flux2Scheduler", inputs:{ steps: KLEIN_STEPS, width:["10",0], height:["10",1] } },
    "13": { class_type:"RandomNoise", inputs:{ noise_seed: opts.seed } },
    "14": { class_type:"KSamplerSelect", inputs:{ sampler_name:"euler" } },
    "15": { class_type:"CFGGuider", inputs:{ model:["3",0], positive:["9b",0], negative:["7",0], cfg:1 } },
    "16": { class_type:"SamplerCustomAdvanced", inputs:{ noise:["13",0], guider:["15",0], sampler:["14",0], sigmas:["12",0], latent_image:["11",0] } },
    "17": { class_type:"VAEDecode", inputs:{ samples:["16",0], vae:["5",0] } },
    "18": { class_type:"SaveImage", inputs:{ images:["17",0], filename_prefix:"SSS" } }
  };
  return g;
}
const KLEIN_STEPS = 4;
const SAVE_IMAGE_NODE_ID_KLEIN = "18";

// Sketch to Add on Klein.
//
// The scope control does not apply here. Klein starts from an empty latent, so
// SetLatentNoiseMask has nothing to hold, and the site's own "masked" option is
// described in the UI as "เชื่อถือได้ ไม่มีเงา" — reliable, and no shadow. That
// missing shadow is the reason peetz moved this mode over: a mask is a hard
// boundary on where anything may change, shadows included, and commit 24af4bb
// had already had to extend the mask downward to give one somewhere to land.
//
// Measured on the painted tree frame, difference from the source outside the
// drawn shape, split into vertical bands:
//
//                     far left   middle   right (tree & its shadow)
//   flux2 masked          3.08     2.55         2.66
//   Klein                18.65    31.12        53.99
//
// flux2's flat 2.79 is not all preservation — part of it is declining to cast
// the shadow at all. Klein's right-hand figure is the tree behaving physically.
// The cost is honest and known: Klein re-renders the whole frame, so scenery
// drifts. That is the same trade the existing "full" scope already makes and
// that peetz already accepted on 2026-08-20 (road 14.17, far houses 13.52) —
// Klein's floor is a little higher, and it does not leave painted colour behind.
//
// Resolution matters more than expected: at the frame's native size the tree
// came out too large and shifted off the drawn shape, while 2.5MP placed it
// correctly. So render at 2.5MP and scale back to the size the mode promises.
// How wide the seam between the kept frame and the redrawn patch is allowed to
// be, in pixels of the output. The mask arrives as a hard-edged bitmap and a
// hard edge shows; blurring the mask itself is what softens the join, which is
// what FeatherMask was wrongly believed to do (it fades the mask image's own
// four borders, not the outline of a stroke).
const KLEIN_SEAM_BLUR = 10;

function buildKleinSketchPrompt(opts){
  const g = buildKleinPrompt(Object.assign({}, opts, { scaleTo:null, megapixels:2.5 }));
  const size = opts.scaleTo;
  let last = ["17", 0];
  if(size){
    g["19"] = { class_type:"ImageScale", inputs:{ upscale_method:"lanczos",
      width: size[0], height: size[1], crop:"disabled", image:["17",0] } };
    last = ["19", 0];
  }

  // Put back everything the drawing did not ask to change.
  //
  // Klein starts from an empty latent, so SetLatentNoiseMask has nothing to
  // hold and the site's own "เฉพาะรอบรูปที่วาด (แนะนำ)" option was doing
  // literally nothing: every pass redrew the whole picture. Measured 2026-09-01
  // on a four-pass run, mean abs difference from the original, in the top 30% of
  // the frame where no stroke and no ground apron reach — 22.0, 25.3, 32.4,
  // 36.5. Sky and roofline the user never touched, drifting further every pass.
  //
  // So the mask is applied to the pixels instead of the latent: composite the
  // generated frame back over the painted source, keeping the source everywhere
  // the mask is black. Outside the drawn shape the result is then the original
  // by construction, and it stays that way however many passes chain.
  //
  // This is not the optional lockOutside of the flux2 graph. There, the latent
  // mask already held the outside to 10.2 and compositing was a refinement that
  // cost shadows. Here there is no latent mask at all, so without this the
  // option is a lie. The ground apron that skMaskBlob adds is what keeps a cast
  // shadow alive: it opens the whole lower band of the frame, so a shadow
  // landing on the ground is inside the mask and survives. A shadow thrown onto
  // a wall outside the mask does not — which is what the option already says.
  //
  // The mask bitmap is authored at skMaskSize and the frame at scaleTo, so it
  // travels mask -> image -> scale -> blur -> mask to arrive at the output grid
  // with a soft edge. Both carry the source's aspect ratio, so nothing distorts.
  if(opts.maskImage && size){
    g["20"] = { class_type:"LoadImageMask", inputs:{ image: opts.maskImage, channel:"red" } };
    g["21"] = { class_type:"MaskToImage", inputs:{ mask:["20",0] } };
    g["22"] = { class_type:"ImageScale", inputs:{ upscale_method:"bilinear",
      width: size[0], height: size[1], crop:"disabled", image:["21",0] } };
    g["23"] = { class_type:"ImageBlur", inputs:{ image:["22",0],
      blur_radius: KLEIN_SEAM_BLUR, sigma: KLEIN_SEAM_BLUR / 2 } };
    g["24"] = { class_type:"ImageToMask", inputs:{ image:["23",0], channel:"red" } };
    // The painted frame is authored at scaleTo already; the scale is a no-op
    // that costs nothing and keeps the graph correct if that ever changes.
    g["25"] = { class_type:"ImageScale", inputs:{ upscale_method:"lanczos",
      width: size[0], height: size[1], crop:"disabled", image:["1",0] } };
    g["26"] = { class_type:"ImageCompositeMasked", inputs:{
      destination:["25",0], source: last, x:0, y:0, resize_source:false, mask:["24",0] } };
    last = ["26", 0];
  }

  g["18"].inputs.images = last;
  return g;
}


// ---------------------------------------------------------------------------
let state = { workflow:"magnific", uploadedName:null, origPreviewURL:null, connected:false, clientId: crypto.randomUUID(), autoMaterials:"", lastResult:null, lastModelKind:null };

const $ = id => document.getElementById(id);
const serverUrlEl = $('serverUrl');
const statusBox = $('statusBox');
const btnRun = $('btnRun');

// ---------------------------------------------------------------------------
// Account dropdown (mock — no backend auth; login now lives only on the
// dedicated login page/view. This panel just reflects logged-in state.)
const acctBtn = $('acctBtn'), acctPanel = $('acctPanel');
let isLoggedIn = false;

function goToLogin(){
  if(typeof showView === 'function') showView('login');
  else window.location.href = 'login.html';
}

acctBtn.addEventListener('click', (e)=>{
  e.stopPropagation();
  if(!isLoggedIn){ goToLogin(); return; }
  acctPanel.classList.toggle('open');
});
document.addEventListener('click', (e)=>{
  if(!acctPanel.contains(e.target) && e.target !== acctBtn) acctPanel.classList.remove('open');
});

// Called externally (from the login page) once sign-in succeeds.
window.appSetLoggedIn = function(email){
  isLoggedIn = true;
  $('acctEmail').textContent = email;
  $('acctLabel').textContent = email.split('@')[0];
  $('acctAvatar').textContent = email.charAt(0).toUpperCase();
};
window.appSetLoggedOut = function(){
  isLoggedIn = false;
  $('acctLabel').textContent = 'Sign in';
  $('acctAvatar').textContent = '?';
  acctPanel.classList.remove('open');
};

$('btnLogout').addEventListener('click', ()=>{
  window.appSetLoggedOut();
  goToLogin();
});
$('btnCopyToken').addEventListener('click', ()=>{
  const el = $('apiToken');
  el.select();
  navigator.clipboard && navigator.clipboard.writeText(el.value).catch(()=>{});
  const btn = $('btnCopyToken');
  const original = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(()=>{ btn.textContent = original; }, 1500);
});

// ---------------------------------------------------------------------------
// Shared by Interior and Exterior. Both tracks arrived at this independently by
// A/B on 2026-07-27, so it lives in one place rather than being copied twice.
//
// The rule these encode: never name a material. Not to describe one, and not to
// forbid one. An enumeration ("concrete shows formwork lines; brick and stone
// show real joints") reads as a menu — on a flat white painted wall the
// exterior version produced board-marked stained concrete, and a neighbouring
// painted boundary wall came back as stone blocks. With these two paragraphs in
// its place, the same seed left both smooth and painted.
//
// "never by what would look better" is the clause doing most of the work. The
// failure was never that the model misread the source; it was that it improved
// on it.
const ENHANCE_NOT_CHANGE = `Enhance what is already in the image rather than changing it. Every surface keeps the material, colour, tone and pattern it already has; nothing is reinterpreted as a different material and nothing is restyled. What each surface is made of is decided entirely by the source image, never by what would look better. Dark surfaces stay dark and pale surfaces stay pale, and making the photograph brighter never makes a material lighter.`;

const CAMERA_ADDS = `Add only what a real camera adds: each surface gains the true micro-texture, sheen and reflectivity of the exact material it already is, light behaves physically with bounce and soft contact shadows, natural depth of field, subtle sensor grain, true-to-life colour, no HDR look.`;

// ---------------------------------------------------------------------------
// Exterior prompt: assembled from fixed core paragraphs (from the reference
// prompt) + modular paragraphs that change based on the selected category
// (time/weather, clouds, background, people, free-form extra).

const EXT_INTRO = `Turn this architectural 3D render into a real photograph of the exact same building, shot from the exact same camera position with identical framing and perspective. Lighting, sky, and weather follow the "Time of Day", "Clouds", and "Weather" sections below, with every shadow consistent with that light source. The result is a straight photograph — nothing about it may look like CGI, a rendering, or an illustration.`;

const EXT_GEOMETRY = `Preserve exactly, without exception:
- Building geometry: every volume, facade, slab, balcony, and structural element keeps its exact shape, position, and proportion. The camera does not move, zoom, tilt, or reframe.
- Openings: every window and door keeps its exact size, shape, and position. Solid walls stay solid; no new openings appear and none are filled in.
- Ground plan: every ground surface keeps its exact category and boundary — paved roads, driveways, and paths stay paved; grass and planting stay planted; pools and ponds stay water with realistic reflections. Nothing swaps category and nothing new is invented.
Realism is added on top of these surfaces, never by changing what they are.`;

const EXT_MATERIALS = [ENHANCE_NOT_CHANGE, CAMERA_ADDS].join('\n\n');

// This paragraph used to carry a sentence describing how grass and foliage
// should look. It was there to stop warm grading yellowing a lawn — but naming
// grass grows grass, and on 2026-08-05 it was measured turning the road across
// the foreground into a verge. Same seed, four ways:
//   remove the sentence, car moving      → road runs to the frame edge
//   remove the sentence, cars parked     → road runs to the frame edge
//   keep it, add "paved surfaces run to their full extent" → still a verge
//   remove the sentence at morning / evening / night → road intact, and the
//     lawn that genuinely belongs stays green under warm light and at night
// The third line is the one that settles it: no added instruction overrides the
// naming, only deletion does. Yellowing is already covered by NEUTRAL_WB and by
// EXT_QUALITY, which asks for greens to read as true green with no warm cast.
const EXT_SITE = `Site elements — roads, paths, fences, poles, streetlights, planters, and everything else already visible in the image — stay exactly in place at correct scale and become photographically real. The scene contains exactly what the source image contains: nothing new is introduced anywhere on the site.`;

// "warmth only in direct highlights" was permission, not a limit, and renders
// came back with an amber cast over the whole frame. This states the target as
// something measurable instead.
const EXT_QUALITY = `Color & Photographic Quality: neutral accurate white balance — whites read as clean white, greys as neutral grey and greens as true green, with no overall warm or golden cast anywhere in the frame. A natural documentary architectural photograph: subtle sensor grain, believable reflections and contact shadows, gentle atmospheric depth. No HDR look, oversaturation, or artificial sharpening.`;

// Appended to the two daylight times. Every one of these presets used to carry
// the word "warm" and the output was yellow across the board — walls, paving and
// sky alike. The fix is to say where the warmth is allowed to land rather than
// only that it exists.
const NEUTRAL_WB = ` The white balance is neutral and the light is clean: white and grey surfaces read as white and grey with no golden or amber cast, and the sun's warmth shows only as a slight lift on the brightest sunlit faces, never as a colour wash over the whole frame.`;

// Under a closed sky the time of day still sets the brightness and the colour,
// but it must stop describing direct sun. Rain used to render under a blue sky
// with the sun out, and overcast still threw a hard building shadow across the
// road, because Time of Day, Clouds and Weather each described the light with
// no order of precedence between them. These variants take that precedence.
// Night is absent on purpose: it is lit by the building, not the sun, so it
// needs no diffuse form.
// Renamed 2026-08-08: morning/afternoon/evening became dawn/sunset/twilight.
// 'afternoon' is now 'sunset' because peetz tested it against plain noon and
// picked it as the default — measured on 1111.jpg, contrast 61.2→68.0 and
// warmth -11.9→-0.3, the biggest move any wording change made that day (a
// rewritten Photographic Quality paragraph moved contrast by 0.2). 'evening'
// is now 'twilight', reusing its own "warmth confined to the sunlit face,
// shade stays neutral" text rather than writing a new dusk description.
//
// The body text is otherwise the same — but the heading word alone is not
// free. Swapping only "Afternoon" for "Sunset" (nothing else) measured
// warmth -0.3 → +20.4 and contrast held: the same "nothing turns golden"
// sentence sits right there and did not stop it. This is the naming effect
// documented for materials, showing up in a lighting word. Whether that
// warmer result is wanted is a judgement call, not a bug — it read as a
// genuine, tasteful golden-hour photograph on 1111.jpg, not the old flat
// orange material-swap failure — but it means "sunset" carries real weight
// of its own and any future rewording of this paragraph must be re-measured,
// not assumed identical because the prose looks unchanged.
function extDiffuseTimeParagraph(time){
  const map = {
    dawn: `Time of Day — Dawn under a closed sky: early daylight with the sun hidden behind cloud, arriving evenly from the whole sky. There is no direct sun anywhere in the scene — nothing casts a shadow onto the ground or across a wall, and the only shading is the gentle ambient occlusion where surfaces meet. Low contrast, cool and clear.`,
    noon: `Time of Day — Midday under a closed sky: bright but completely diffused daylight with the sun hidden behind cloud, arriving evenly from the whole sky. There is no direct sun anywhere in the scene — nothing casts a shadow onto the ground or across a wall, and the only shading is the gentle ambient occlusion where surfaces meet. Low contrast and evenly lit.`,
    sunset: `Time of Day — Sunset under a closed sky: full daylight with the sun hidden behind cloud, arriving evenly from the whole sky. There is no direct sun anywhere in the scene — nothing casts a shadow onto the ground or across a wall, and the only shading is the gentle ambient occlusion where surfaces meet. Low contrast and evenly lit.`,
    twilight: `Time of Day — Twilight under a closed sky: the last of the daylight with the sun already lost behind cloud, dimmer and cooler than midday and flat across the whole scene. There is no direct sun and nothing casts a shadow; building lights may glow softly. Nothing turns golden.`
  };
  return (map[time] || map.noon) + NEUTRAL_WB;
}

function extTimeParagraph(time){
  // Rewritten 2026-09-01 from a VisuaLab reference sheet peetz sent, six
  // states: Original, Predawn, Golden Hour, Midday, Blue Hour, Night Scene.
  // The option VALUES are left alone so nothing saved breaks; only the labels
  // and the text change.
  //
  // NOTE this reverses an earlier deliberate decision. `sunset` used to be
  // defined by the sun's ANGLE and explicitly forbidden from warming, because
  // peetz rejected orange results in July. The reference asks for a real golden
  // hour, so it is golden again — and `noon` is the neutral option for anyone
  // who wants what the old sunset was giving. If orange comes back as a
  // complaint, this is the paragraph that did it.
  const map = {
    // Predawn: the sky carries the light, the building barely does.
    dawn: `Time of Day — Predawn: the sun is still below the horizon. The sky is a deep saturated blue overhead sinking to a narrow warm amber band low down where the sun is about to rise, and the city lights and street lights are still lit. The building is lit mostly by that sky, so its surfaces read cool and slightly blue, while its own interior lights glow warm through the glazing. Nothing casts a hard sun shadow. No lens flare, god rays, or HDR grading.`,
    // Golden hour: warm and directional, and allowed to be warm.
    sunset: `Time of Day — Golden Hour: the sun is low and warm, throwing long soft-edged shadows across the ground and raking the facade from one side. The light itself is golden and slightly orange where it lands, the shade stays cool by contrast, and the sky graduates from pale warm near the horizon to soft blue above with warm-lit cloud. Sunlit surfaces glow; shadowed ones keep their detail rather than going black. No lens flare, god rays, or HDR grading.`,
    noon: `Time of Day — Midday: bright clear daylight from a high sun in a strong blue sky, with well-defined but soft-edged shadows falling short and close under what casts them. The daylight is neutral and very slightly cool, exactly as a camera set to daylight white balance records it, and every surface keeps its own colour. No lens flare, god rays, or HDR grading.` + NEUTRAL_WB,
    // Blue hour: the reference is unambiguous — a strong teal sky, and the
    // building lit from inside. That balance is the whole look.
    twilight: `Time of Day — Blue Hour: the sun has gone and the sky is an even, saturated teal-blue, brightest low down and deepening overhead. The building is lit by its own interior and exterior lights, which glow warm against that cool sky and spill onto the ground nearby — that warm-against-blue balance is the point of this hour. Forms stay readable, never falling into full silhouette, and passing traffic leaves soft light trails. No lens flare, god rays, or HDR grading.`,
    // "moonlight" named a moon into being — the usual failure — so this still
    // does not say where the ambient night fill comes from, only that it exists.
    night: `Time of Day — Night Scene: full darkness, the sky a deep near-black blue with the city glowing faintly on the horizon. The building is lit entirely by its own architectural lighting — interior light through the glazing, and exterior fittings washing walls and soffits from above and below, each throwing its own soft pool and gradient. Away from those pools the night stays cool and neutral, not tinted amber, and unlit areas keep enough ambient fill to stay readable rather than pure black. No invented external light sources.`
  };
  return map[time] || map.noon;
}


// The five night variants named "moon"/"moonlight" outright, and a named
// thing appears — this is very likely why a moon disc kept showing up in
// night renders nobody asked for. Fixed 2026-08-08: every ambient-glow phrase
// stays, only the moon itself is gone. Stars are untouched — peetz asked for
// no moon, not no stars.
// How blue the sky actually comes back, and why the Clouds control cannot
// decide it.
//
// peetz's hypothesis on 2026-09-02 was that setting Clouds to None would deepen
// the blue. Measured on one exterior source at seed 4242, noon and clear, with
// nothing else changed, mean B−R across the top band of the frame:
//
//   none   +59.6   the palest of the three
//   thin   +61.4   the shipped default
//   thick  +65.2
//
// The opposite of the guess, and a span of about 9% — the control is not the
// lever. More cloud reads bluer because the white of the cloud makes the blue
// beside it read deeper, and None's own words, "a natural daylight gradient",
// describe a pale wash.
//
// The benchmarks say the shipped default was simply too pale. R9m_urban_00001_,
// the render peetz calls the best he has made for light, sky, shadow, materials
// and reflection, measures +83.6; his ten delivered exterior Afters that contain
// sky have a median of +86.3. The site was shipping +61.4.
//
// Naming the colour is what closes that gap — the same lever that makes a tree
// appear when the species is named, and that fixed the interior view. With this
// clause: thin +82.7, none +85.4, both landing on R9m_urban and on the delivered
// median, saturation 29.2% -> 43.3%.
//
// It is gated three ways, because a deep blue is a claim about the sky and there
// are skies it would contradict: not at night, not under a closed sky (rain,
// overcast, mist, or the overcast cloud option), and only at the times of day
// whose sky really is blue. Golden Hour and Blue Hour own their colour and are
// left to it.
const SKY_DEEP_BLUE = ` The sky's blue is deep and strongly saturated overhead, paling only close to the horizon.`;
const SKY_BLUE_TIMES = { noon:1 };
const SKY_BLUE_CLOUDS = { none:1, thin:1, thick:1 };

function extCloudsParagraph(clouds, time, closedSky){
  const night = time === 'night';
  const deep = !night && !closedSky && SKY_BLUE_TIMES[time] && SKY_BLUE_CLOUDS[clouds]
    ? SKY_DEEP_BLUE : '';
  const map = {
    none: night
      ? `Clouds: a clear night sky with visible stars.`
      : `Clouds: a clear cloudless sky with a natural daylight gradient.`,
    thin: night
      ? `Clouds: thin wispy clouds catching a faint ambient glow, stars visible between them.`
      : `Clouds: a few thin wispy semi-transparent clouds of varied size — never a flat repeated pattern.`,
    thick: night
      ? `Clouds: drifting clouds veiling parts of the sky, stars visible in the breaks.`
      : `Clouds: scattered cumulus clouds with real volume, soft-lit tops and gently shaded undersides — never a flat repeated pattern.`,
    overcast: night
      ? `Clouds: heavy overcast hiding the stars, faint ambient glow only.`
      : `Clouds: a soft uniform overcast layer diffusing the light evenly.`,

    // Rain gets its own sky rather than borrowing "overcast", which is a bright
    // even white layer — too light to read as weather you would take an
    // umbrella for.
    rain: night
      ? `Clouds: a heavy rain sky with the stars completely hidden, only the dim glow of distant city light on the cloud base.`
      : `Clouds: a heavy, low, rain-bearing sky — thick grey cloud with real depth and darker bellies, covering the frame from edge to edge with no break and no patch of blue anywhere. The daylight coming through it is dim and even.`
  };
  return (map[clouds] || map.thin) + deep;
}

function extWeatherParagraph(weather){
  // Overcast moved here from the Clouds control on 2026-09-01: the reference
  // sheet peetz sent lists it as a weather state beside rain and snow, which is
  // how people actually think about it. The Clouds control still has its own
  // overcast option and either route reaches the same closed-sky paragraph.
  if(weather === 'overcast') return `Weather — Overcast: a heavy, unbroken grey cloud layer fills the sky from edge to edge, close and low, with texture and movement in it rather than a flat grey wash. No sun reaches the scene, so nothing casts a directed shadow; the light arrives evenly from the whole sky and every surface is shaded only where forms meet. Contrast is low and colours sit slightly desaturated and cool, the way an overcast day actually records.`;
  if(weather === 'mist') return `Weather — Morning Mist: a low ground fog lies across the scene, thick enough that anything far away fades to a pale silhouette and the horizon disappears entirely, while the building itself stays clear and close. The light is soft, cool and directionless with no sun anywhere in it, wet surfaces hold a faint sheen, and any lit window glows warm through the haze. Distance is read by how much the fog takes, not by contrast.`;
  if(weather === 'rain') return `Weather — Heavy Rain: the scene sits under a dim, gloomy, heavily overcast light with no sunshine anywhere in it. Rain falls hard enough to be visible as streaks through the air, paved and hard surfaces are wet with standing water and mirror-like reflections, spray breaks off the edges of roofs and sills, and everything reads cool and slightly desaturated.`;
  if(weather === 'snow') return `Weather — Snowing: snow is falling, visible as soft flakes through the air, and a natural layer has settled on existing horizontal surfaces only — roofs, sills, the ground, the tops of walls — while vertical faces stay clear. The light is soft and diffused with no sun, contrast is low, and the whole frame carries a pale cool grading. Geometry unchanged.`;
  return ''; // clear
}

// Auto is the default, and it composes nothing. Every other option tells the
// model to invent a backdrop, and inventing is what makes an exterior read as
// CG — interior looks more real largely because it only has to enhance what was
// photographed. This is the same clause that stopped interior window views from
// substituting a nicer scene, pointed outward instead of through glazing.
function extBackgroundParagraph(bg){
  // These two describe a place the building stands in rather than a band of
  // scenery behind it. The old low-rise version ended "No towers or landmarks",
  // naming the two things it did not want — dropped on the usual grounds.
  //
  // Both are written to read as current construction. The first attempt asked
  // only for houses and for a city, and got pitched tiled roofs and tenement
  // blocks with window air-conditioners — the model's default for those words
  // is dated. Saying so explicitly, and describing the spacing, is what fixed
  // it. "Manhattan-like" was tested for the city and rejected: it does produce
  // New York, but New York includes its pre-war stock, and older buildings came
  // back with it.
  // The neighbours kept ending up on a hillside, and three attempts at saying
  // "the ground is level" did not move it — because on level ground the model
  // was right. A one or two storey house standing behind a two storey building
  // that is itself lifted on columns cannot be seen at all unless something
  // raises it, so asking for neighbours behind the building is asking for a
  // slope. They go to the sides instead, where there is open ground to stand on,
  // and what is behind the building is sky.
  if(bg === 'low') return `Background & Horizon: the building stands on a flat suburban street, with its neighbours to either side of it along that same street — contemporary one and two storey houses set well apart, each a clean modern volume with a flat or shallow roof, smooth painted and timber-clad walls, large glazing and a carport. Each neighbour stands on its own separate plot with a clear gap of open ground between it and the main building, so sky and daylight show right through that gap and each one reads as a building of its own. They stand on ground as level as the road, each seen from the side at its own height, so no house ever appears above the main building's roofline. Far down the street, well past the last of the houses, a thin low line of distant trees shows through the gaps between them, its crowns no higher than the neighbours' roofs and thinned by haze to a soft edge. Directly behind and above the main building there is only open sky. Only distance makes each house smaller, softer and lower in contrast, and each reads as a house built in the last few years.`;
  if(bg === 'high') return `Background & Horizon: the building stands in a modern city centre — contemporary glass and steel towers rise close on either side and behind it, their curtain-wall facades stepping back as they go up and reflecting the sky, with a broad avenue running past and the city receding into atmospheric haze. Everything around it is current construction, clean and sharp-edged. It reads as the downtown this building genuinely opens onto, never as a skyline placed behind it.`;
  if(bg === 'trees') return `Background & Horizon: soften the horizon with distant trees and shrubs consistent with the setting, rendered with atmospheric perspective (softer, lower contrast, slightly hazy with distance). No large new buildings or landmarks.`;
  return `Background & Horizon: the source image is the authority on what stands behind and beside the building. Whatever it already shows there — its own buildings, trees, planting, sky or backdrop — stays exactly that: the same elements in the same places at the same distance, changed only by being rendered photographically. Nothing is substituted for something more interesting and nothing is added around it: no extra building, tree, skyline, hill or horizon that the source does not already contain. Where the source shows nothing but blank sky behind the building, that stays plain open sky and no scene is composed to fill it.`;
}

function extPeopleParagraph(people, desc){
  if(people === 'yes'){
    if(desc) return `People: include ${desc} — correctly scaled to the architecture, lit consistently with the scene, photographically real, secondary to the building.`;
    return `People: one or two people naturally present — walking or standing, correctly scaled, lit consistently with the scene, photographically real, secondary to the building.`;
  }
  // Motion-blurred figures, the long-exposure convention in architectural
  // photography. Tested same-seed against the sharp option on 2026-08-05: the
  // smear lands and the building stays sharp. Note "standing" is deliberately
  // absent — a still figure cannot smear, and leaving the word in is what kept
  // the sharp option sharp. The Focus paragraph further down still ends "no
  // blur or bokeh anywhere"; a variant that exempted movement from that
  // sentence rendered indistinguishably, so it was not shipped.
  if(people === 'blur'){
    if(desc) return `People: include ${desc}, moving through the scene and caught mid-stride during a long exposure so each figure is smeared into a soft translucent streak in the direction they are moving, the building behind them staying perfectly sharp — correctly scaled, lit consistently with the scene, secondary to the building.`;
    return `People: one or two people walking through the scene, caught mid-stride during a long exposure so each figure is smeared into a soft translucent streak in the direction they are moving, the building behind them staying perfectly sharp — correctly scaled, lit consistently with the scene, secondary to the building.`;
  }
  // Off: emit nothing at all. Image models respond to the concept named in the
  // prompt and largely ignore the negation around it, so "no people" reliably
  // summons people. Silence + the global "nothing new is introduced" lock works.
  return '';
}

function extViewParagraph(view){
  if(view === 'bird') return `View — Bird's Eye (this overrides the fixed camera): an elevated drone view looking down that reveals the roof, overall massing, and site layout, with every building and site element still exactly as modeled.`;
  if(view === 'isometric') return `View — Isometric (this overrides the fixed camera): an elevated three-quarter view with parallel, non-converging perspective lines showing the massing, roof, and immediate site, everything exactly as modeled.`;
  return ''; // eye-level — camera already locked
}

// Vehicles offers only the moving car. A parked one was tested on 2026-08-06
// and dropped: with generic wording the body melts — bulging panels, oval wheel
// arches, an extra window in the greenhouse — and 20 steps does not fix it,
// because "realistic vehicles" gives the model no real shape to hold onto.
// Naming an actual model does fix it, but then the mode only works for whoever
// wants that exact car, and the count stays unreliable on top.
//
// The moving car has none of those problems. Long exposure is doing the same
// job it does for people: the smear hides what the model cannot resolve at this
// size, and everything fixed in the frame stays sharp. Verified with and
// without a named model.
//
// Known limitation kept from the parked version: on a source that already
// contains vehicles this adds another. Naming vehicles is what produces
// vehicles, and no conditional rewrite has beaten that — the dropdown label
// carries the warning instead.
function extCarsParagraph(cars){
  // 'yes' was the old parked value; anything switched on now means moving, so
  // a saved setting does not silently come back with no car at all.
  if(cars === 'blur' || cars === 'yes') return `Vehicles: exactly one car driving along the road in front of the building, caught during a long exposure so that vehicle alone is smeared into a soft translucent streak along its direction of travel, while everything else in the frame stays perfectly sharp — correctly scaled to the building, lit consistently with the scene, secondary to the building. No other vehicle appears anywhere in the frame.`;
  return ''; // Off: emit nothing — see extPeopleParagraph
}

function extFocusParagraph(focus){
  if(focus === 'shallow') return `Focus: shallow depth of field — the building critically sharp, near foreground and far background falling into smooth optical blur.`;
  return `Focus: deep depth of field — sharp from front to back, no blur or bokeh anywhere.`;
}

function extConsistencyReminder(){
  return `Final check: an ultra-detailed high-resolution photograph in which the building's geometry, every opening, and the ground layout (paved stays paved, planted stays planted, water stays water) match the source image exactly, every shadow matches the sky described above, and the frame contains no figure, object, or element that was absent from the source image.`;
}

function buildExteriorPromptP(p = {}){
  const time = p.time || 'noon';   // matches the shipped HTML default
  const clouds = p.clouds || 'thin';
  const weather = p.weather || 'clear';
  const background = p.background || 'auto';
  const view = p.view || 'normal';
  const people = p.people || 'no';
  const peopleDesc = String(p.peopleDesc || '').trim();
  const cars = p.cars || 'no';
  const focus = p.focus || 'deep';
  const extra = String(p.extra || '').trim();

  const closedSky = weather === 'rain' || weather === 'overcast' || weather === 'mist' || clouds === 'overcast';

  const parts = [
    EXT_INTRO,
    EXT_GEOMETRY,
    extViewParagraph(view),
    EXT_MATERIALS,
    EXT_SITE,
    extBackgroundParagraph(background),
    // Rain implies a closed sky, and so does the overcast cloud option; under
    // either, the sun paragraph gives way to its diffuse form. Rain also
    // forces the cloud layer, so 'clear cloudless sky' can never be asked for
    // in the same breath as falling rain.
    (closedSky && time !== 'night') ? extDiffuseTimeParagraph(time) : extTimeParagraph(time),
    extCloudsParagraph(weather === 'rain' ? 'rain' : clouds, time, closedSky),
    extWeatherParagraph(weather),
    extPeopleParagraph(people, peopleDesc),
    extCarsParagraph(cars),
    EXT_QUALITY,
    extFocusParagraph(focus),
    extConsistencyReminder()
  ].filter(Boolean);
  if(extra) parts.push(`Additional Instructions:\n${extra}`);

  return parts.join('\n\n');
}

// Semi Outdoor — covered terraces, pavilions, breezeways, carports: shares
// every building block with Exterior, only the intro framing differs.
const SEMI_INTRO = `Turn this 3D render into a real photograph of the exact same semi-outdoor space — a covered terrace, pavilion, breezeway, carport, or similar roofed space open on one or more sides — shot from the exact same camera position with identical framing. Direct sun and sky may be partially filtered by the roof while open sides receive full outdoor light, following the "Time of Day", "Clouds", and "Weather" sections below. The result is a straight photograph — nothing may look like CGI, a rendering, or an illustration.`;

function buildSemiOutdoorPromptP(p = {}){
  const time = p.time || 'noon';   // matches the shipped HTML default
  const clouds = p.clouds || 'thin';
  const weather = p.weather || 'clear';
  const background = p.background || 'auto';
  const view = p.view || 'normal';
  const people = p.people || 'no';
  const peopleDesc = String(p.peopleDesc || '').trim();
  const cars = p.cars || 'no';
  const focus = p.focus || 'deep';
  const extra = String(p.extra || '').trim();

  const closedSky = weather === 'rain' || weather === 'overcast' || weather === 'mist' || clouds === 'overcast';

  const parts = [
    SEMI_INTRO,
    EXT_GEOMETRY,
    extViewParagraph(view),
    EXT_MATERIALS,
    EXT_SITE,
    extBackgroundParagraph(background),
    // Rain implies a closed sky, and so does the overcast cloud option; under
    // either, the sun paragraph gives way to its diffuse form. Rain also
    // forces the cloud layer, so 'clear cloudless sky' can never be asked for
    // in the same breath as falling rain.
    (closedSky && time !== 'night') ? extDiffuseTimeParagraph(time) : extTimeParagraph(time),
    extCloudsParagraph(weather === 'rain' ? 'rain' : clouds, time, closedSky),
    extWeatherParagraph(weather),
    extPeopleParagraph(people, peopleDesc),
    extCarsParagraph(cars),
    EXT_QUALITY,
    extFocusParagraph(focus),
    extConsistencyReminder()
  ].filter(Boolean);
  if(extra) parts.push(`Additional Instructions:\n${extra}`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Interior — v6. Kept identical to web/lib/prompts.mjs; this file is the
// standalone tool that talks to ComfyUI directly, that file is the hosted SaaS.
// If you change one, change the other.
//
// Core chosen by same-seed A/B on 2026-07-27 across two sources (a bedroom with
// flat white wardrobe panels, a café with a terracotta tile wall), run against a
// longer variant that spelled out material rules and a shorter one that dropped
// them entirely. This is the variant peetz picked.
//
// Three rules learned the hard way:
//
// 1. Never name a material here — not even to forbid it. Prompt text mentioning
//    a material makes it more likely to appear, so a ban list reads partly as a
//    suggestion. The old room-type presets proposed materials outright
//    ("leather with natural grain, velvet with a directional nap") and silently
//    swapped what the customer had modelled, which is why Room Type is gone;
//    the later ban list was subtler but measurably worse than saying nothing.
// 2. No lighting words in the core. An earlier core carrying "warm afternoon
//    sunlight" turned every render orange regardless of the picker.
// 3. Shorter beats longer. A bloated core contradicts itself.

const INT_CAMERA = `Convert this 3D interior render into a photorealistic photograph of the exact same room, from the exact same camera position and framing.`;

// Shared with Exterior — see ENHANCE_NOT_CHANGE above for why no material is
// named. The interior A/B that chose it: a previous version listed the
// materials a plain surface must never become ("timber, stone, brick, marble,
// tile") and it measurably made things worse, washing a terracotta tile wall to
// cream and lifting a near-black ceiling and floor to mid-grey, while this
// version held all three.
const INT_FIDELITY = ENHANCE_NOT_CHANGE;
const INT_CAMERA_ADDS = CAMERA_ADDS;

const INT_LIGHT_PHYSICS = `Light behaves physically: it bounces between surfaces picking up their colour, falls off with distance, wraps softly around edges, and settles into gentle ambient occlusion where surfaces meet.`;

const INT_PHOTO_QUALITY = `The result is a straight photograph taken with a full-frame camera and a sharp prime lens: natural dynamic range, subtle sensor grain, true-to-life colour, no HDR look, no oversaturation, no artificial sharpening.`;

const INT_CORE = [INT_CAMERA, INT_FIDELITY, INT_CAMERA_ADDS].join('\n\n');

// Close-up shot type. A detail view is a different photograph from a room view:
// a real lens this close cannot hold everything sharp, there is no "room" to
// light, and material texture is the subject rather than a finishing touch.
const INT_CAMERA_CLOSEUP = `Convert this 3D interior detail view into a photorealistic close-up photograph of the exact same objects, shot from the exact same camera position with identical framing and perspective. This is a detail shot, not a room view: the objects in frame are the subject.`;

const INT_CLOSEUP_DETAIL = `At this distance the materials themselves are the subject and resolve fully: wood shows open pores, ray fleck and the direction of its grain; fabric and rugs show individual tufts, weave and pile; paper and book cloth show fibre and slightly softened edges; vinyl shows fine concentric groove lines catching the light; metal shows brushed direction and tiny surface marks; painted surfaces show the faint texture of a real sprayed or rolled finish. Fine dust, soft edge wear and the small irregularities of real objects are visible, while the objects stay clean and well kept.`;

// This paragraph exists to keep hard sun out, and the old version named an
// opening three times to do it ("through the glazing", "shafts of sunlight",
// "window-frame shadow patterns"). In a room with no opening that is three
// invitations inside the one clause meant to prevent the problem. Rewritten
// 2026-08-18 as shadow quality alone, which is checkable on any interior and
// names nothing: it says where shading may come from rather than what it must
// not look like.
const SOFT_SHADOWS = ` Every shadow is soft-edged and open, the kind a large diffuse source casts: edges fade gradually rather than cutting sharply, and light lands evenly across floor, walls and furniture rather than in bright hard-edged patches or stripes.`;

// Asked for across the interior modes on 2026-08-18: light should arrive as a
// glow that wraps forms rather than a beam that strikes them, because renders
// were coming back dark and hard-edged and could not be shown to a client.
const INT_GLOW = ` The light reads as a soft glow that spreads and wraps around forms rather than a direct beam that strikes them, building gently from the fittings and from the bright surfaces it bounces off, so shadows stay pale and soft-edged and nothing in the frame falls into heavy darkness.`;

// Only for the modes that describe a lit room. On evening or night this would
// contradict the mode's own opening sentence.
const INT_HIGH_KEY = ` The overall exposure is bright and welcoming — a clean, open, high-key photograph rather than a dim or moody one.`;

// ---------------------------------------------------------------------------
// Interior mood, added 2026-08-26.
//
// The three clauses above — glow, high-key, soft shadows — went in on
// 2026-08-18 because renders were coming back dark and hard-edged and could not
// be shown to a client. They fixed that, and then some: measured against the
// 158 reference images peetz curated himself in `dataset/interior`, the shipped
// look was going the wrong way on every axis.
//
//                    mean lum   clipped white   deep shadow   chroma
//   his reference       110.4          0.45%        15.33%      35.2
//   shipped output      174.4          9.06%         3.76%      11.6
//
// Seven separate clauses were pushing that direction at once: "Bright, clear
// and even", "pure white with no colour cast", "nothing falls into heavy
// darkness", "high-key rather than dim or moody", "light lands evenly", "stays
// plain bright sky", "abundant soft daylight". Rewriting six of them on the
// same source, seed and model moved it to 120.1 / 2.24% / 9.16% / 25.5 —
// about four fifths of the way back on exposure and clipping.
//
// It is a choice rather than a replacement because the old complaint was real.
// 'bright' is exactly what shipped before this date.
// "building gently from the fittings" contradicts FIXTURES_OFF two sentences
// later, and dropping it looked like free tidying. It is left in because this
// is the exact string that was measured; the tidier version is untested, and
// this project has a long record of untested improvements measuring worse.
const INT_GLOW_DEPTH = ` The light reads as a soft glow that spreads and wraps around forms rather than a direct beam that strikes them, building gently from the fittings and from the bright surfaces it bounces off, so the light falls off gradually across the room and shadow gathers softly in the corners and under the furniture, the frame keeping a full tonal range with genuine dark areas as well as bright ones.`;

const SOFT_SHADOWS_DEPTH = ` Shadows are soft-edged, the kind a large window casts: edges fade gradually rather than cutting sharply, they are free to deepen well into shadow while keeping their detail, and the light is strongest near the opening and weaker away from it, so the room is read by that gradient rather than by even illumination.`;

// Applied to whichever lighting sentence the mode and fixture switch selected,
// so the ON/OFF table stays single-sourced. Two spellings of the white-balance
// sentence exist (comma in the OFF table, colon in the ON table) and both have
// to be listed; a replace that silently matches nothing would ship the old look
// under the new label.
const INT_MOOD_SWAPS = [
  [`Neutral white balance throughout, white surfaces read as pure white with no colour cast, and every surface keeps its own lightness. Bright, clear and even.`,
   `White balance is neutral to gently warm. Pale surfaces are not pure paper white: they carry the quiet mineral tone of the plaster or paint they are made of, and every surface keeps its own lightness.`],
  [`Neutral white balance throughout: white surfaces read as pure white with no colour cast, and every surface keeps its own lightness.`,
   `White balance is neutral to gently warm. Pale surfaces are not pure paper white: they carry the quiet mineral tone of the plaster or paint they are made of, and every surface keeps its own lightness.`],
  [`the room is lit entirely by abundant soft daylight through the glazing.`,
   `the room is lit by daylight arriving through its own glazing, one soft directional source rather than a general brightness, so the room is modelled by that light.`]
];

// The blown-window half of the same problem: "plain bright sky" was being taken
// literally and the glazing came back as a flat 255 void. Clipped highlights
// across the whole frame fell 9.06% -> 2.46% on this sentence alone.
const SKY_VOID_BRIGHT = `Where the source shows nothing but blank white beyond the glass, that stays plain bright sky and no scene is composed to fill it.`;
const SKY_VOID_DEPTH  = `Where the source shows nothing but blank white beyond the glass, the glazing reads as bright daylight held just within the exposure, still luminous but not burnt to a flat white void, and no scene is composed to fill it.`;

// Two failures this fixes, both seen in testing:
// 1. A turntable's clear acrylic dust cover was read as a window and the model
//    invented a shaft of light blazing off it onto the wall.
// 2. Windows came back as flat white voids.
const NO_PHANTOM_SOURCE = ` Light enters only through the openings that already exist in the source image. Every solid wall and panel in the source stays solid and unbroken: no new opening of any kind appears anywhere, and no existing opening changes its size, shape or position. No new lamp or glowing panel is invented, and no object, screen, glass cover or reflective surface is turned into a light source or mistaken for an opening.`;

// NO_PHANTOM_SOURCE says light may only come from openings the source already
// has; it never says how many of them light the room. On a source with real
// glazing on two sides the render lit both, softly, and the frame came back
// with no cast shadow anywhere — peetz spotted it on 2026-08-31. Naming a
// single dominant opening is what brings the shadows back.
//
// Only the depth mood takes it. The bright mood's SOFT_SHADOWS asks for light
// that "lands evenly ... rather than in bright hard-edged patches", which is
// the opposite instruction, and evening/night are lit by their own fittings
// rather than by an opening at all — the same gate litRoom already uses.
//
// Measured on three rooms: the aggregate brightness statistics move 1.397 ->
// 1.392, i.e. not at all. Direction is invisible to them. Judge this one by
// eye — cast shadows and sunlight patches appear where there were none.
const ONE_LIGHT_DIRECTION = ` All the light in the room arrives from one dominant direction — the largest and brightest opening the source already has. Every shadow in the frame falls the same way from that single source, and no second light of comparable strength arrives from another side.`;

// Auto no longer asks for an exterior to be composed. Telling the model there
// is "a genuine exterior appropriate to the setting" beyond the glass made it
// invent landscapes and skylines that were never in the source — the fix for
// blank white windows overshot into scene invention. Auto now preserves what
// the source shows and only rules out the flat void; a view is drawn only when
// the user picks one.
const INT_VIEW_KEEP = ` The source image is the authority on what lies outside. Whatever it already shows beyond the glazing — its own buildings, trees, planting, sky or backdrop — stays exactly that: the same elements in the same places at the same distance, changed only by being rendered photographically. Nothing is substituted for something more interesting and nothing is added around it: no extra building, tree, skyline, hill or horizon that the source does not already contain. Where the source shows nothing but blank white beyond the glass, that stays plain bright sky and no scene is composed to fill it.`;

// A chosen view has to be phrased as a CONDITION, never as a fact. Written as a
// statement — "beyond the glazing there is a city view" — the model treats it as
// something the picture must contain and cuts new windows into solid walls to
// make room for it. Reported 2026-07-27: garden and city both punched openings
// into a blank wall that the correct render left solid.
const INT_VIEW_GUARD = ` This governs only what is seen through openings that already exist: every solid wall in the source stays solid, no new window or glass panel is cut into it, and where the source has no opening none is added.`;

// What is out there (the user's choice) and how bright it reads (follows the
// lighting mode). Splitting the two fixes a contradiction in the old fixed
// sentence, which asked for a "bright and softly overexposed" view even at night.
const INT_VIEW_CONTENT = {
  // There is deliberately no "sky only" option here.
  //
  // One existed and did not work: "plain open sky with a soft natural gradient"
  // describes exactly what an unexposed white window already looks like, so the
  // render had nothing to do, and most of the sentence went on forbidding
  // buildings and trees — which is how you summon them. Rewritten positively on
  // 2026-09-02 (a colour, a direction to that colour, an edge-to-edge extent) it
  // worked outright: on a café modelled with no exterior, near-white pixels fell
  // from 25.7% to 3.9% and the window carried a real graded blue.
  //
  // peetz turned it down on sight, and he is right. Sky filling a shopfront down
  // to floor level means the room is airborne — true of nothing he draws except
  // a high-floor view, which the city option already covers from the right
  // height. A view that cannot exist is worse than a blank window, so the option
  // is gone rather than fixed. Keep this note: the wording works, the idea does
  // not, and the next person to notice blank windows should not re-derive it.
  garden: `a real garden, planting and shrubs with a tree or two near the glass and soft depth behind them`,
  forest: `real woodland close to the glass, trunks and layered foliage receding into soft depth`,
  street: `a real street at ground level, road surface and kerb, street trees and the fronts of the buildings opposite`,
  city: `a wide city view seen from high above the ground, rooftops and massed buildings receding to a distant horizon softened by atmospheric haze`
};

const INT_VIEW_EXPOSURE = {
  day: `bright and softly overexposed but still readable, never a flat white void`,
  evening: `under a deepening dusk sky, cooler and dimmer than the room but still clearly readable`,
  night: `dark but still readable, showing only the light that setting really has at night — lit windows, street lamps or moonlight on foliage — never a flat black void`
};

function intViewOutsideParagraph(bg, mode, depth){
  const content = INT_VIEW_CONTENT[bg];
  const keep = depth ? INT_VIEW_KEEP.replace(SKY_VOID_BRIGHT, SKY_VOID_DEPTH) : INT_VIEW_KEEP;
  if(!content) return keep; // auto, or an unknown value
  const band = mode === 'night' ? 'night' : (mode === 'evening' ? 'evening' : 'day');
  // The condition used to read "glazing with something visible through it",
  // which quietly excluded the exact case the Sky option exists for: a window
  // modelled with no backdrop has nothing visible through it, so the clause
  // never applied and the blank stayed blank. The condition that keeps the
  // model from cutting new holes in walls is that the OPENING already exists —
  // INT_VIEW_GUARD says so directly — not that something is already behind it.
  return ` Where the source image already shows glazing, what is seen through that glazing reads as ${content}, ${INT_VIEW_EXPOSURE[band]}.`
    + ` This covers every opening the source already has, the ones it leaves blank included: those carry the same view as the rest.`
    + INT_VIEW_GUARD;
}

// Lighting is two independent questions and used to be folded into one control:
// what KIND of light the scene has, and whether the room's own fixtures are
// switched on. Folding them together made "night" mean "lamps off" by
// definition, which left the most ordinary night render of all — a warm lit
// interior against a dark outside — impossible to ask for.
//
// Note the deliberate absence of "warm" and "golden" from the white option: a
// stray warmth word anywhere tints the whole frame orange.
const INT_LIGHT_ON = {
  // "blending with abundant soft daylight from the window" asserted that the
  // room HAS a window. On a source with no opening anywhere — a deep-plan flat,
  // a windowless ward — that sentence still has to be made true, and the render
  // answered it by putting glowing panels into blank cabinet fronts. Saying
  // only that the room is lit by what it already contains is equally true of a
  // wall of glazing and of no opening at all. Measured 2026-08-18 on a
  // windowless source: the invented openings stop appearing.
  white: `Lighting: the room is lit by the light it already contains — the light fittings it has, switched on, and whatever daylight it already receives. Neutral white balance throughout: white surfaces read as pure white with no colour cast, and every surface keeps its own lightness.`,

  warm: `Lighting: the room's fixtures are switched on and glow a soft warm-white, spreading into pools that fall off naturally and blending with daylight from the window. The warmth lives in the glow of the lamps and the surfaces they reach; walls away from the fixtures stay neutral, and the room never turns uniformly orange.`,

  evening: `Lighting: dusk outside the windows, the sky beyond fading to a cool deep blue while the room itself is lit from within by its own fixtures glowing warm. The contrast between the cool glazing and the warm interior is gentle and cinematic. Shadows are deep but stay open and detailed, never crushed to black.`,

  night: `Lighting: night beyond the glazing, dark outside the glass, while the room's fixtures are switched on and glow warm. The room reads as a bright warm interior set against the darkness outside, the light spreading into pools that fall off naturally. Shadows are deep but stay open and detailed, never crushed to black.`
};

// This was once a long clause listing nine kinds of fitting and everything an
// unlit one must not do. Two same-seed A/Bs on 2026-07-27 showed the list
// hurting on both counts: with it, a wall sconce still bled a faint glow and a
// terracotta wall washed out, and — the giveaway — the word "screens" in the
// list turned a small white paper holder on a café table into a black
// electronic reader. Naming a thing to forbid it still puts it in the picture.
// The short version left the sconces properly dark and the paper holder alone.
const FIXTURES_OFF = ` The room's own fittings are not lit; every bit of its illumination arrives from outside.`;

const INT_LIGHT_OFF = {
  white: `Lighting: the room is lit entirely by abundant soft daylight through the glazing. Neutral white balance throughout, white surfaces read as pure white with no colour cast, and every surface keeps its own lightness. Bright, clear and even.` + FIXTURES_OFF,

  warm: `Lighting: the room is lit entirely by daylight through the glazing, carrying the gentle warmth of late afternoon. The warmth lives in the light where it lands; surfaces away from the window stay neutral, and the room never turns uniformly orange.` + FIXTURES_OFF,

  evening: `Lighting: dusk outside the windows, the sky beyond fading to a cool deep blue. The room is lit only by the last of that daylight, dim and cool and even, forms still readable in soft gradation rather than solid black.` + FIXTURES_OFF,

  night: `Lighting: night. The only light is faint ambient night light entering through the glazing, distant city or garden light and a trace of moonlight, so the room reads as a dim, cool, quiet space. Forms stay readable in the low light with soft gradation rather than solid black.` + FIXTURES_OFF
};

function intLightingParagraph(mode, fixtures, bg, closeup, mood){
  const m = INT_LIGHT_ON[mode] ? mode : 'white';
  const depth = mood === 'depth';
  let base = (fixtures === 'off' ? INT_LIGHT_OFF : INT_LIGHT_ON)[m];
  if(depth) for(const [from, to] of INT_MOOD_SWAPS) base = base.replace(from, to);
  // Only the two modes that describe a lit room take the glow, the high-key
  // exposure and the soft-shadow clause. Evening and night are meant to be
  // dark, and a bright-and-welcoming sentence would fight their own opening
  // line — the kind of self-contradiction that broke the old v5 core.
  const litRoom = (m === 'white' || m === 'warm')
    ? (depth ? (INT_GLOW_DEPTH + SOFT_SHADOWS_DEPTH + ONE_LIGHT_DIRECTION) : (INT_GLOW + INT_HIGH_KEY + SOFT_SHADOWS))
    : '';
  // A close-up frame often contains no glazing at all, so asking for a view
  // through it invites one to be drawn.
  return base + litRoom + NO_PHANTOM_SOURCE + (closeup ? '' : intViewOutsideParagraph(bg, m, depth));
}

function intFocusParagraph(focus, closeup){
  if(closeup) return `Focus: the natural shallow depth of field of a lens working this close, the main subject critically sharp, with focus falling off gently into soft optical blur toward the back of the frame.`;
  if(focus === 'shallow') return `Focus: shallow depth of field, the main furniture grouping critically sharp, immediate foreground and far background in smooth optical blur. The result is a straight photograph, not a rendering.`;
  return `Focus: deep depth of field, the whole room sharp from front to back. The result is a straight photograph, not a rendering.`;
}

// Interior people. Same-seed test on the café source, 2026-08-05:
//
// - Seated works because the pose is conditioned on the seating the room
//   already has. Without that clause a request to seat someone in a room with
//   nothing to sit on is an invitation to invent furniture.
// - Walking asks for exactly ONE figure, and the count is the whole trick. The
//   first version said "one or two" and produced four; with four smeared bodies
//   crossing a small room the blur ran onto the bench, the wall and the table
//   behind them. One walker leaves everything fixed perfectly sharp.
// - Suppressed entirely on a close-up, where the core already says the objects
//   in frame are the subject. The control hides itself in that mode too.
function intPeopleParagraph(people, closeup){
  if(closeup) return '';
  if(people === 'sit') return `People: one or two people seated, using the seating the room already contains and leaving its layout, position and count untouched — relaxed and unposed, correctly scaled to the space, lit by the light already in the room, photographically real, secondary to the interior.`;
  if(people === 'walk') return `People: one person walking through the room, caught mid-stride during a long exposure so that figure alone is smeared into a soft translucent streak in the direction they are moving, while everything fixed in the room stays perfectly sharp — correctly scaled to the space, lit by the light already in the room, secondary to the interior.`;
  if(people === 'both') return `People: someone seated using the seating the room already contains, its layout, position and count left untouched, and one person walking through the room caught mid-stride during a long exposure so that figure alone is smeared into a soft translucent streak while everything fixed in the room stays perfectly sharp — all correctly scaled to the space, lit by the light already in the room, secondary to the interior.`;
  return ''; // Off: emit nothing — see extPeopleParagraph for why
}

function buildInteriorPromptP(p = {}){
  const mode = p.intLight || 'white';
  const fixtures = p.intFixtures || 'on';
  const bg = p.intBg || 'auto';
  const closeup = (p.intShot || 'room') === 'closeup';
  const mood = p.intMood || 'depth';
  const focus = p.intFocus || 'deep';
  const people = p.intPeople || 'no';
  const extra = String(p.intExtra || '').trim();

  const core = closeup
    ? [INT_CAMERA_CLOSEUP, INT_FIDELITY, INT_CLOSEUP_DETAIL, INT_LIGHT_PHYSICS, INT_PHOTO_QUALITY].join('\n\n')
    : INT_CORE;

  const parts = [
    core,
    intLightingParagraph(mode, fixtures, bg, closeup, mood),
    intPeopleParagraph(people, closeup),
    intFocusParagraph(focus, closeup)
  ].filter(Boolean);
  if(extra) parts.push(`Additional Instructions:\n${extra}`);
  // Room mode deliberately has no trailing "final check" paragraph: the version
  // that carried one is the version that lost the wardrobe, and the run that
  // passed ends on the focus line. Close-up keeps its own, as tested.
  if(closeup) parts.push(`Final check: an ultra-detailed high-resolution photograph in which every object, its material and its colour match the source image exactly, and the frame contains no object or element that was absent from the source image.`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Add People — a different job from the other three modes. Its input is a
// photograph that is already finished, so this prompt must NOT carry the
// enhance/material/lighting paragraphs: those exist to reinterpret a raw
// SketchUp render, and on an image the customer has already approved,
// reinterpreting it is precisely the damage to avoid.
//
// The pipeline is unchanged — same full pass from an empty latent. Measured
// 2026-08-05: running a finished render back through it adds people and leaves
// the room intact, while starting the sampler from that render as its latent
// adds nobody at any denoise from 0.25 through 0.80. There is no denoise window
// to find, so the short prompt is the entire mechanism.
//
// One wording serves both interior and exterior, which is why the mode needs no
// scene selector: "seated if the picture already contains seating, otherwise
// standing" makes the model read the scene instead of being told what it is —
// the same conditional form that stopped window views from cutting new holes in
// walls.
const AP_BASE = `This is a finished photograph. Leave it exactly as it is — the same place, the same objects in the same positions, the same materials, the same colours, the same lighting and the same camera. Nothing already in the frame is moved, replaced, restyled or removed. The only change is that people are now present in it.`;

// How many. Counted on the rendered output at seed 815243, 2026-08-05:
//   still   1 → 1 · 3 → 4 · 6 → about ten, and the room stops reading as an
//           architectural photograph at all
//   moving  1 → 1 · 2 → 2, everything fixed still sharp · 3 → 3, but three
//           smeared bodies crossing a small room drag the blur onto the bench,
//           the wall and the table behind them
// Hence the ceilings below: four at rest, two moving. Asking for more does not
// produce more, it produces an unusable frame, so the slider does not offer it.
const AP_COUNT_RANGE = { still: [1, 4], moving: [1, 2], both: [2, 4] };
const NUM = { 1: 'one person', 2: 'two people', 3: 'three people', 4: 'four people' };
const clampCount = (n, pose) => {
  const [lo, hi] = AP_COUNT_RANGE[pose];
  return Math.min(Math.max(Math.round(Number(n) || lo), lo), hi);
};

const apStill = n => `People: exactly ${NUM[n]} at rest — seated if the picture already contains seating, otherwise standing — sharp and still, correctly scaled to the space, lit by the light already in the picture, secondary to the place itself. Whatever they rest on is something the picture already contains, and its position and count are left untouched. No more than ${NUM[n]} appear anywhere in the frame.`;

const apMoving = n => n === 1
  ? `People: exactly one person walking through the picture, caught mid-stride during a long exposure so that figure alone is smeared into a soft translucent streak in the direction they are moving, while everything else in the frame stays perfectly sharp — correctly scaled to the space, lit by the light already in the picture, secondary to the place itself. No more than one person appears anywhere in the frame.`
  : `People: exactly ${NUM[n]} walking through the picture, caught mid-stride during a long exposure so those figures alone are smeared into soft translucent streaks in the direction they are moving, while everything else in the frame stays perfectly sharp — correctly scaled to the space, lit by the light already in the picture, secondary to the place itself. No more than ${NUM[n]} appear anywhere in the frame.`;

// The still figures are told outright that they stay sharp. An earlier version
// let them share one sentence with the long-exposure clause and the seated
// person came back soft. The walker stays at one here: the slider sets the
// total, and every figure above the first is a still one.
const apBoth = n => `People: exactly ${NUM[n - 1]} at rest — seated if the picture already contains seating, otherwise standing — and exactly one person walking through the picture. The still ${n === 2 ? 'figure is' : 'figures are'} rendered as sharp as everything around them. Only the walking figure is caught mid-stride during a long exposure and smeared into a soft translucent streak in the direction they are moving; everything else in the frame stays perfectly sharp. All are correctly scaled to the space, lit by the light already in the picture, and secondary to the place itself. Whatever the still ${n === 2 ? 'figure rests' : 'figures rest'} on is something the picture already contains, and its position and count are left untouched. No more than ${NUM[n]} appear anywhere in the frame.`;

const AP_POSE = { still: apStill, moving: apMoving, both: apBoth };

function buildAddPeoplePromptP(p = {}){
  const pose = AP_POSE[p.pose] ? p.pose : 'still';
  const count = clampCount(p.count, pose);
  const desc = String(p.desc || '').trim();

  const parts = [AP_BASE, AP_POSE[pose](count)];
  // Free text is appended rather than spliced into the paragraph above, so the
  // wording that was actually rendered stays byte-for-byte intact.
  if(desc) parts.push(`Additional Instructions:\n${desc}`);
  return parts.join('\n\n');
}

// DOM adapters — read the UI controls and delegate to the shared builders above
function readExtParams(){
  return {
    time: $('sExtTime').value, clouds: $('sExtClouds').value, weather: $('sExtWeather').value,
    background: $('sExtBackground').value, view: $('sExtView').value,
    people: $('sExtPeople').value, peopleDesc: $('sExtPeopleDesc').value,
    cars: $('sExtCars').value, focus: $('sExtFocus').value,
    // Same rule as interior: the generated text goes first so anything typed
    // sits last and overrides it.
    extra: [
      ($('sAutoMatExt').checked && state.autoMaterials) ? state.autoMaterials : '',
      $('sExtExtra').value.trim()
    ].filter(Boolean).join(' ')
  };
}
function buildExteriorPrompt(){ return buildExteriorPromptP(readExtParams()); }
function buildSemiOutdoorPrompt(){ return buildSemiOutdoorPromptP(readExtParams()); }
function buildInteriorPrompt(){
  // Anything typed wins the tail position, so a hand-written correction still
  // overrides what was read off the image.
  const auto = ($('sAutoMat').checked && state.autoMaterials) ? state.autoMaterials : '';
  const typed = $('sIntExtra').value.trim();
  return buildInteriorPromptP({
    intLight: $('sIntLight').value, intShot: $('sIntShot').value,
    intFixtures: $('sIntFixtures').value, intBg: $('sIntBg').value, intMood: $('sIntMood').value,
    intFocus: $('sIntFocus').value, intPeople: $('sIntPeople').value,
    intExtra: [auto, typed].filter(Boolean).join(' ')
  });
}

function updatePeopleDescVisibility(){
  $('sExtPeopleDescWrap').style.display = $('sExtPeople').value !== 'no' ? '' : 'none';
}

// ---------------------------------------------------------------------------
// Auto material colours.
//
// A rule the model cannot evaluate is dead text — sixteen renders failed to
// make any wording of "keep the tones" hold a dark ceiling. What does work is
// naming the colour outright, and that value can be read off the source instead
// of typed: the ceiling came back charcoal and the floor walnut from a sentence
// this function wrote, matching what a human typed by hand.
//
// A SketchUp interior is shot square-on, so the top band is ceiling and the
// bottom band is floor. Exteriors are excluded — up there the top band is sky.
const TONES = [[40,'near-black'],[75,'very dark'],[115,'dark'],[155,'mid'],[200,'light'],[999,'very light']];

function describeBand(r, g, b){
  const L = 0.299*r + 0.587*g + 0.114*b;
  const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  const tone = TONES.find(t => L < t[0])[1];
  let hue;
  if(sat < 0.10) hue = 'neutral grey';
  else if(sat < 0.22) hue = r >= b ? 'warm grey' : 'cool grey';
  else hue = r >= b ? (L < 115 ? 'brown' : 'tan') : 'blue-grey';
  return tone + ' ' + hue;
}

// Median rather than mean: a few ceiling downlights would drag an average up
// and end up describing a surface that is not in the room.
function sampleBand(data, w, y0, y1){
  const R = [], G = [], B = [];
  for(let y = y0; y < y1; y += 2)
    for(let x = Math.floor(w*0.1); x < Math.floor(w*0.9); x += 2){
      const i = (y*w + x) * 4;
      R.push(data[i]); G.push(data[i+1]); B.push(data[i+2]);
    }
  const med = a => { a.sort((p,q)=>p-q); return a[a.length>>1]; };
  return describeBand(med(R), med(G), med(B));
}

// Bands come from profiling a source in 5% slices rather than guessing. On the
// exterior that profile is unambiguous: sky owns everything above 0.35 at a
// flat 255, the building sits 0.45-0.70, the paving that keeps turning
// terracotta is 0.74-0.90, and the very bottom is road, so it is left out.
const BANDS = {
  interior: [['ceiling', 0.00, 0.10], ['walls', 0.35, 0.60], ['floor', 0.80, 1.00]],
  exterior: [['facade', 0.45, 0.70], ['ground', 0.74, 0.90]]
};

function readMaterialSentence(img, kind){
  const bands = BANDS[kind];
  if(!bands) return '';
  try{
    const W = 400, H = Math.max(1, Math.round(W * img.naturalHeight / img.naturalWidth));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g2 = c.getContext('2d');
    g2.drawImage(img, 0, 0, W, H);
    // Throws on a tainted canvas — opening the page over file:// can do that.
    const d = g2.getImageData(0, 0, W, H).data;
    const v = {};
    for(const [name, y0, y1] of bands)
      v[name] = sampleBand(d, W, Math.floor(H*y0), Math.floor(H*y1));
    if(kind === 'interior')
      return `The ceiling is ${v.ceiling}, and it stays that dark rather than reading as white. `
           + `The floor is ${v.floor}. The walls are ${v.walls}.`;
    return `The paved ground across the front of the building is ${v.ground}, and it stays that dark in full sun. `
         + `The building's own walls and panels are ${v.facade}.`;
  }catch(e){
    log('Could not read material colours from the image (' + e.message + ') — carrying on without them.', 'warn');
    return '';
  }
}

// Which reading applies depends on the preset, so recompute whenever either the
// image or the preset changes.
function refreshAutoMaterials(){
  const img = $('previewImg');
  const type = $('sPromptType').value;
  const kind = type === 'interior' ? 'interior' : (type === 'exterior' || type === 'semiOutdoor') ? 'exterior' : null;
  if(!img.src || !img.naturalWidth || !kind){ state.autoMaterials = ''; return; }
  const next = readMaterialSentence(img, kind);
  // applyPromptType runs on every control change; only say something when the
  // reading actually changed, or the log fills with the same line.
  if(next && next !== state.autoMaterials) log('Material colours read from image: ' + next, 'ok');
  state.autoMaterials = next;
}

let hiddenPromptCache = '';
const PROMPT_MASK = '🔒 Prompt generated and ready to use — hidden to protect this preset.\nSwitch "Image Type" to Custom if you want to write and view your own prompt.';

function applyPromptType(){
  const type = $('sPromptType').value;
  updatePeopleDescVisibility();
  // Which bands to read depends on the preset, so re-read before the prompt
  // below is rebuilt — switching Interior/Exterior after upload must re-sample.
  refreshAutoMaterials();
  if(type === 'exterior'){
    $('sExtControls').style.display = '';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = buildExteriorPrompt();
    $('sPrompt').value = PROMPT_MASK;
  } else if(type === 'semiOutdoor'){
    $('sExtControls').style.display = '';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = buildSemiOutdoorPrompt();
    $('sPrompt').value = PROMPT_MASK;
  } else if(type === 'interior'){
    $('sExtControls').style.display = 'none';
    $('sIntControls').style.display = '';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = buildInteriorPrompt();
    $('sPrompt').value = PROMPT_MASK;
  } else {
    $('sExtControls').style.display = 'none';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = false;
    if($('sPrompt').value === PROMPT_MASK) $('sPrompt').value = '';
    hiddenPromptCache = '';
  }
}
$('sPromptType').addEventListener('change', applyPromptType);
function refreshExtPrompt(){
  updatePeopleDescVisibility();
  const type = $('sPromptType').value;
  if(type === 'exterior') hiddenPromptCache = buildExteriorPrompt();
  else if(type === 'semiOutdoor') hiddenPromptCache = buildSemiOutdoorPrompt();
}
['sExtTime','sExtClouds','sExtWeather','sExtBackground','sExtView','sExtPeople','sExtPeopleDesc','sExtCars','sExtFocus','sExtExtra','sAutoMatExt'].forEach(id=>{
  $(id).addEventListener('input', refreshExtPrompt);
});
// Close-up overrides three of the pickers: a real lens this close is forced
// into shallow depth of field, the frame usually holds no glazing for a view to
// sit behind, and a detail shot has no room for a figure — the close-up core
// already declares the objects in frame to be the subject. Grey them out rather
// than leave controls that silently do nothing.
function updateIntFocusAvailability(){
  const closeup = $('sIntShot').value === 'closeup';
  ['sIntFocus','sIntBg','sIntPeople'].forEach(id=>{
    const sel = $(id);
    sel.disabled = closeup;
    const field = sel.closest('.field');
    if(field) field.style.opacity = closeup ? '0.45' : '';
  });
}
['sIntLight','sIntShot','sIntFixtures','sIntBg','sIntMood','sIntFocus','sIntPeople','sIntExtra','sAutoMat'].forEach(id=>{
  $(id).addEventListener('input', ()=>{
    updateIntFocusAvailability();
    if($('sPromptType').value === 'interior') hiddenPromptCache = buildInteriorPrompt();
  });
});
try{ updateIntFocusAvailability(); }catch(e){ console.error('updateIntFocusAvailability init failed:', e); }
try{ applyPromptType(); }catch(e){ console.error('applyPromptType init failed:', e); } // set initial value (Exterior by default)

// ---------------------------------------------------------------------------
// before/after compare slider
const cmpEl = $('cmp');
const cmpRange = $('cmpRange');
function setCmpPercent(pct){
  $('cmpBeforeWrap').style.clipPath = 'inset(0 ' + (100 - pct) + '% 0 0)';
  $('cmpLine').style.left = pct + '%';
  $('cmpDot').style.left = pct + '%';
}
cmpRange.addEventListener('input', ()=> setCmpPercent(cmpRange.value));

function showBeforeOnly(url){
  $('cmpEmpty').style.display = 'none';
  $('cmpAfterImg').style.display = '';
  $('cmpAfterImg').src = url; // show the original as full background until a result exists
  $('cmpBeforeWrap').style.display = 'none';
  $('cmpLabelBefore').style.display = 'none';
  $('cmpLabelAfter').style.display = 'none';
  $('cmpLine').style.display = 'none';
  $('cmpDot').style.display = 'none';
  cmpRange.style.display = 'none';
  $('dlOrigLink').href = url;
}

// The `download` HTML attribute is ignored by browsers for cross-origin URLs
// (ComfyUI's /view endpoint is a different origin than this page), so a plain
// <a download> click just opens the image instead of saving it. Fetch the
// bytes ourselves and trigger the save from a same-origin blob: URL instead.
async function forceDownload(url, filename){
  try{
    const res = await fetch(url);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(blobUrl), 5000);
  }catch(e){
    console.error('Direct download failed, opening the image in a new tab instead:', e);
    window.open(url, '_blank');
  }
}
$('dlLink').addEventListener('click', (e)=>{
  e.preventDefault();
  forceDownload($('dlLink').href, $('dlLink').download || 'result.png');
});
$('dlOrigLink').addEventListener('click', (e)=>{
  e.preventDefault();
  forceDownload($('dlOrigLink').href, 'original.png');
});

function showCompare(beforeUrl, afterUrl){
  $('cmpEmpty').style.display = 'none';
  $('cmpAfterImg').style.display = '';
  $('cmpAfterImg').src = afterUrl;
  $('cmpBeforeImg').src = beforeUrl;
  $('cmpBeforeWrap').style.display = '';
  $('cmpLabelBefore').style.display = '';
  $('cmpLabelAfter').style.display = '';
  $('cmpLine').style.display = '';
  $('cmpDot').style.display = '';
  cmpRange.style.display = '';
  cmpRange.value = 50;
  setCmpPercent(50);
}

function log(msg, cls){
  const line = document.createElement('div');
  if(cls) line.className = cls;
  line.style.whiteSpace = 'pre-wrap';
  line.textContent = msg;
  statusBox.appendChild(line);
  statusBox.scrollTop = statusBox.scrollHeight;
}
function clearLog(){ statusBox.innerHTML = ''; }

function baseUrl(){ return serverUrlEl.value.replace(/\/+$/,''); }

async function testConnection(){
  const el = $('connStatus'), txt = $('connText');
  try{
    const res = await fetch(baseUrl() + '/system_stats', { method:'GET' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    await res.json();
    el.className = 'conn ok'; txt.textContent = 'Connected to ComfyUI';
    state.connected = true;
  }catch(e){
    el.className = 'conn bad';
    txt.textContent = 'System temporarily unavailable';
    state.connected = false;
  }
  updateRunEnabled();
}
$('btnTestConn').addEventListener('click', testConnection);
window.addEventListener('load', testConnection);

// Show which build the browser is actually running. The value is read off
// app.js's own ?v= query string rather than stored in a constant here, because
// the question this answers is "did my refresh actually pick up the new file?"
// — and a hand-kept constant can say yes while a cached script says otherwise.
// Reading the tag that loaded this code cannot disagree with itself.
(function showAppVersion(){
  const el = $('appVersion');
  if(!el) return;
  const tag = document.currentScript || document.querySelector('script[src*="app.js"]');
  const m = tag && /[?&]v=([^&"']+)/.exec(tag.getAttribute('src') || '');
  if(m){
    el.textContent = 'v' + decodeURIComponent(m[1]);
  }else{
    // No version on the tag at all — usually a local file opened directly.
    el.textContent = 'v(dev)';
    el.classList.add('stale');
  }
})();

// workflow selection
document.querySelectorAll('.wf-opt').forEach(el=>{
  el.addEventListener('click', ()=>{
    if(el.classList.contains('disabled')) return;
    // Only an actual change resets — clicking the mode you are already in must
    // not throw away the upload you are working on.
    const changed = el.dataset.wf !== state.workflow;
    document.querySelectorAll('.wf-opt').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
    state.workflow = el.dataset.wf;
    $('paramsCardMagnific').style.display = state.workflow === 'magnific' ? '' : 'none';
    $('paramsCardSSS').style.display = state.workflow === 'sss' ? '' : 'none';
    $('paramsCardPeople').style.display = state.workflow === 'people' ? '' : 'none';
    $('paramsCardSketch').style.display = state.workflow === 'sketch' ? '' : 'none';
    skSyncMode();
    // Every mode wants a different size and a different starting frame, and the
    // source is not carried across — say so, or the image looks like it dropped
    // out on its own.
    if(changed){
      resetSource();
      log('เปลี่ยนโหมดแล้ว — อัปโหลดภาพใหม่สำหรับโหมดนี้');
    }
  });
});

// The ceiling depends on the pose — four at rest, two moving, and "both" needs
// at least two to be both. Move the slider's own limits rather than silently
// clamping a value the user can still see on screen.
function syncPeopleCount(){
  const [lo, hi] = AP_COUNT_RANGE[$('apPose').value] || AP_COUNT_RANGE.still;
  const slider = $('apCount');
  slider.min = lo; slider.max = hi;
  slider.value = Math.min(Math.max(parseInt(slider.value) || lo, lo), hi);
  $('apCountVal').textContent = slider.value;
  $('apCountLo').textContent = lo;
  $('apCountHi').textContent = hi;
}
function refreshPeoplePrompt(){
  syncPeopleCount();
  $('apPrompt').value = buildAddPeoplePromptP({
    pose: $('apPose').value, count: parseInt($('apCount').value), desc: $('apDesc').value
  });
}
['apPose','apCount','apDesc'].forEach(id=>$(id).addEventListener('input', refreshPeoplePrompt));
refreshPeoplePrompt();

// ---------------------------------------------------------------------------
// SSS Sketch to Add — the mask says where, the prompt says what.
//
// The whole point of the mask is that it carries the position, so the text
// never has to. Every earlier attempt at "put a thing here" failed on the same
// rule (see the interior lighting work): naming a thing in a prompt makes it
// appear everywhere, and naming a colour to mark it paints the frame that
// colour. With a mask deciding where, the sentence only has to describe what,
// and that failure mode disappears rather than being worked around.
//
// One pass per element type, chained: pass two edits pass one's output. Types
// are not merged into a single pass because one sentence asking for trees and
// cars puts trees in the car mask and cars in the tree mask.
//
// `order` is the pass order, not the draw order, so a type that needs another
// already in the frame can say so.
// Two colours per type, and they are not the same thing. `color` is the chip
// and the overlay on screen, chosen to be told apart at a glance. `paint` is
// what is stamped into the frame that goes up to the model, and it is
// deliberately dull: bright enough to say "something solid of about this tone
// stands here", never bright enough to read as a request for that colour. A
// car painted in the chip's blue came back a blue car.
const SK_TYPES = [
  // One chip for the whole tree means one colour for a canopy and a trunk, and
  // a trunk stamped in canopy green came back covered in moss. A thin stroke is
  // a trunk or a branch by construction — the brush has to be wound right down
  // to draw one — so the thin ones are stamped in bark instead.
  { id:'tree',   label:'ต้นไม้',   color:'#3FA34D', paint:'#3A682C', paintThin:'#5C442C', order:1 },
  // พุ่ม and ลำต้น were dropped on 2026-08-20 and asked for back the same day.
  // The reason for dropping them was that every chip was a whole-frame pass
  // then, so splitting a tree in two doubled the damage to the scenery. Scope
  // defaults to masked now and each pass is local, so that cost is gone — and
  // splitting buys something the single chip decides by guesswork: which part
  // is bark and which is foliage, instead of inferring it from stroke width.
  { id:'canopy', label:'พุ่ม',      color:'#6FBF4A', paint:'#3A682C', order:1 },
  { id:'trunk',  label:'ลำต้น',    color:'#8B5E34', paint:'#5C442C', order:2 },
  { id:'rock',   label:'หิน',      color:'#8A8F98', paint:'#807C76', order:1 },
  { id:'people', label:'คน',       color:'#E0632F', paint:'#68635E', order:3 },
  { id:'car',    label:'รถ',       color:'#2D6CDF', paint:'#96989C', order:3 },
  { id:'animal', label:'สัตว์',    color:'#9B59B6', paint:'#786858', order:3 },
  { id:'lamp',   label:'ดวงโคม',   color:'#E5B700', paint:'#E6CD96', order:4 },
  // A cove or a strip is a line, so this one draws lines: press at one end,
  // drag to the other, and the stroke is the segment between them rather than
  // the wobble the hand made on the way. The chip is the mode — no toggle to
  // find, and none to leave switched on by mistake.
  { id:'hidden', label:'ไฟซ่อน',   color:'#00A7B5', paint:'#E6CD96', order:4, line:1 },
  // Foreground framing, peetz's ask on 2026-08-20 with two reference photos: a
  // stand of birch trunks the camera shoots past, and a branch hanging into the
  // top corners. He had been drawing a huge tree to get this and getting a
  // huge tree. It is a different thing from a tree in the scene — nothing about
  // it is whole, it is cut off by the frame, and it is nearer than the focus.
  // Rendered last, because whatever is in front of the camera goes on last.
  // `noRoom`: the margin exists so a canopy has somewhere to branch into and
  // drop a shadow. Framing has neither — it wants the silhouette that was
  // drawn and not a pixel more. It also cannot afford the margin: at 5% of a
  // 1024px frame that is 51px a side, so a trunk drawn 43px wide came back
  // 145px wide, and two thin trunks 100px apart merged into one fat one.
  // Measured 2026-08-20, and it is why thin strokes were still coming back fat.
  { id:'fgtrunk', label:'ลำต้นหน้าภาพ', color:'#7A5230', paint:'#4A3927', order:5, noRoom:1 },
  { id:'fgleaf',  label:'พุ่มหน้าภาพ',  color:'#2E7D32', paint:'#2E5227', order:5, noRoom:1 }
];
const SK_TYPE_BY_ID = Object.fromEntries(SK_TYPES.map(t => [t.id, t]));

// What to type into each pass's own field. Only the chips where the field
// decides what appears get a line of their own; the rest keep the generic one.
const SK_DESC_HINT = {
  tree:   'ชนิดต้นไม้ — ใช้ชื่ออังกฤษ เช่น a rain tree, a frangipani, a mango tree',
  canopy: 'ชนิดต้นไม้ — ใช้ชื่ออังกฤษ เช่น a rain tree, a frangipani, a mango tree',
  animal: 'ชนิดสัตว์ — ไทยก็ได้ เช่น แมว, หมาพันธุ์โกลเด้น รีทรีฟเวอร์',
  car:    'ยี่ห้อ/รุ่นรถ เช่น Porsche 911 GT3, Mercedes-Benz CLE 53 AMG'
};
// Anything under this is too narrow to be a canopy, so on the tree chip it is
// stamped in bark instead of green.
const SK_THIN = 6;

// The brush snaps to these rather than sliding freely. Free sliding gave a
// number nobody could aim at — the difference between 3.5 and 4 is nothing, and
// the difference between 4 and 14 is everything — and stroke width is now the
// control that decides how thick a trunk comes back, so it needs to be a value
// you can pick on purpose and hit again next time.
const SK_BRUSHES = [1, 1.5, 2, 3, 4, 6, 8, 10, 14, 18, 24, 30];

// What each size is good for, in the words of the thing being drawn rather
// than in percentages of the short side.
function skBrushWhat(size){
  if(size <= 2)  return 'กิ่งเล็ก · ต้นไกล';
  if(size <= 4)  return 'ลำต้นบาง';
  if(size <= 8)  return 'ลำต้น';
  if(size <= 14) return 'พุ่มเล็ก · ลำต้นใหญ่';
  if(size <= 24) return 'พุ่ม';
  return 'พุ่มใหญ่';
}

function skBrushSize(){
  const i = Math.min(SK_BRUSHES.length - 1, Math.max(0, parseInt($('skBrush').value) || 0));
  return SK_BRUSHES[i];
}

function skBrushRefresh(){
  const size = skBrushSize();
  $('skBrushNum').textContent = size;
  // The bark rule only applies to the one chip that has two colours, so it is
  // only mentioned there — a hint that is sometimes false is worse than none.
  const bark = SK_TYPE_BY_ID[SK.type] && SK_TYPE_BY_ID[SK.type].paintThin
    ? (size < SK_THIN ? ' · ป้ายสีเปลือกไม้' : ' · ป้ายสีเขียว')
    : '';
  $('skBrushWhat').textContent = skBrushWhat(size) + bark;
}

// Same opening as Add People, which is already proven for "the input is a
// finished photograph, add something to it".
const SK_BASE = `This is a finished photograph. Leave it exactly as it is — the same place, the same objects in the same positions, the same materials, the same colours, the same lighting and the same camera. Nothing already in the frame is moved, replaced, restyled or removed.`;

// The clause that answers "ผสาน แสง เงา mood ให้เข้ากับงานต้นฉบับ". It never
// states a direction or a softness, it states that both match what is already
// there — so it reads the source instead of being told what the source is.
const SK_DAYLIT = ` It is lit by the light already in the frame, catching that light from the same direction as everything around it, and it casts its own shadow onto the ground in the same direction and with the same softness as the shadows already there.`;
const SK_DAYLIT_PL = ` They are lit by the light already in the frame, catching that light from the same direction as everything around them, and they cast their own shadows onto the ground in the same direction and with the same softness as the shadows already there.`;

// Foreground framing gets neither clause. It stands between the camera and the
// scene, so it has no ground to put a shadow on, and its whole job is to leave
// the picture behind it exactly as it was.
// The first version of this forbade the scene behind from changing at all,
// which also forbade the one change it should make: a thing standing in the
// light throws a shadow, and peetz's framing came back with none while the
// ต้นไม้ chip — which has the ordinary shadow clause — looked right. So the
// shadow is asked for, and only what is beyond it is held still.
const SK_FRAME = ` It is lit by the same light as the scene behind it and casts its own shadow across the ground in the same direction and with the same softness as the shadows already there; beyond that shadow the scene keeps the exposure, the colour and the sharpness it already had.`;
const SK_FRAME_PL = ` They are lit by the same light as the scene behind them and cast their own shadows across the ground in the same direction and with the same softness as the shadows already there; beyond those shadows the scene keeps the exposure, the colour and the sharpness it already had.`;
const SK_FRAMING = { fgtrunk:1, fgleaf:1 };

// Light sources need the opposite clause: they give light rather than take it.
const SK_EMIT = ` The light it gives off is the same colour temperature as the light already in the picture. Its glow spreads onto the surfaces immediately around it and fades away gradually; nothing further away in the frame changes exposure.`;

// Which chips have to name the thing, and what they name when the user has not
// said. See the measurements above the tree entry: an unnamed tree is not a
// vague tree, it is no tree, and an unnamed animal came back as a cow.
//
// The name goes in its own sentence rather than into the noun phrase, so the
// wording that was tuned over the earlier renders is untouched and the grammar
// survives a count above one.
const SK_DEFAULT_SPECIES = {
  tree:   ['a rain tree (Samanea saman)', 'rain trees (Samanea saman)'],
  animal: ['a dog', 'dogs']
};
function skSpecies(n, p, key){
  const said = String((p && p.species) || '').trim();
  const fallback = SK_DEFAULT_SPECIES[key];
  if(!said && !fallback) return '';
  const what = said || (n === 1 ? fallback[0] : fallback[1]);
  return n === 1
    ? ` It is ${what}.`
    : ` They are all ${what}.`;
}

const SK_WHAT = {
  // The species is in the sentence because without one, Klein draws no tree at
  // all. Measured 2026-09-01, same stroke and same seed on one frame:
  //
  //   nothing extra (the wording that shipped)                no tree
  //   "a broadleaf shade tree with a wide spreading crown"    no tree
  //   "a mango tree"                                          a mango tree
  //   "a rain tree (Samanea saman)"                           a rain tree
  //   "a frangipani (Plumeria)"                               a frangipani
  //
  // So it is not detail that is missing, it is a name: the middle line is
  // longer and more specific than the first and still produced nothing. It also
  // has to be a name the model knows — the Thai "ต้นจามจุรี" drew nothing while
  // the same tree in English drew fine. (Thai does work for animals: "แมว"
  // returns a cat. The gap is botanical vocabulary, not the language.)
  //
  // Placement matters too and is not enough on its own: against a wall under a
  // carport roof, even a named species stayed away. Name it AND draw it
  // somewhere a tree could stand.
  tree: (n, p) => (n === 1
    ? `The only change is that a tree now grows in it: a real tree standing on the ground with a trunk, a branching structure and a full leafy canopy, at a believable size for the space around it.`
    : `The only change is that trees now grow in it: real trees standing on the ground, each with a trunk, a branching structure and a full leafy canopy, at a believable size for the space around them.`)
    + skSpecies(n, p, 'tree'),
  // Says nothing about a trunk or about the ground. This region is the crown
  // and only the crown; whatever holds it up is the trunk pass's problem, and
  // mentioning it here is what let foliage wander down the trunk's strip.
  canopy: (n, p) => (n === 1
    ? `The only change is that the leafy crown of a tree now fills it: dense foliage carried on spreading branches, thinning to open sky at its edges, at a believable size for the space around it.`
    : `The only change is that the leafy crowns of trees now fill it: dense foliage carried on spreading branches, thinning to open sky at their edges, at a believable size for the space around them.`)
    + skSpecies(n, p, 'tree'),
  // The two clauses that matter: it reaches the ground at the bottom, and it
  // reaches the foliage at the top. Both ends are named because both ends are
  // where the previous attempts stopped short. Order 2 puts it after the crown,
  // so the crown is already in the frame for it to grow up and meet.
  trunk: n => n === 1
    ? `The only change is that the trunk of a tree now rises through it: real bark on a single upright stem, standing on the ground at its foot where it meets the surface it grows out of, and carrying its branches up into the foliage above, at a believable thickness for its height.`
    : `The only change is that the trunks of trees now rise through it: real bark on upright stems, each standing on the ground at its foot where it meets the surface it grows out of, and carrying its branches up into the foliage above, at a believable thickness for its height.`,
  rock: n => n === 1
    ? `The only change is that a natural rock now rests on the ground: weathered stone sitting where it lies, at a believable size for the space around it.`
    : `The only change is that natural rocks now rest on the ground: weathered stone sitting where it lies, at a believable size for the space around them.`,
  // Wording lifted from Add People, which was tuned over sixteen renders.
  people: n => n === 1
    ? `The only change is that a person is now present in it, at rest — seated if the picture already contains seating, otherwise standing — sharp and still, correctly scaled to the space and secondary to the place itself.`
    : `The only change is that people are now present in it, at rest — seated if the picture already contains seating, otherwise standing — sharp and still, correctly scaled to the space and secondary to the place itself.`,
  car: n => n === 1
    ? `The only change is that a car now stands in it: an ordinary everyday road car, parked on the ground, correctly scaled to the space.`
    : `The only change is that cars now stand in it: ordinary everyday road cars, parked on the ground, correctly scaled to the space.`,
  // "an ordinary animal that belongs in a place like this" was the conditional
  // form, and on Klein it reads as livestock: measured 2026-09-01 on a suburban
  // driveway it produced a cow standing in the carport, and in a chained run a
  // full-grown deer with its head missing, beside a fawn. Neither was scaled to
  // the stroke — the drawing was 52px and the deer filled a third of the frame.
  // Naming the animal fixes the species AND the scale in one go. peetz's own
  // words for this chip are "สัตว์(แมว,หมา)", so a dog is the default and the
  // description field is where a cat or a breed goes.
  animal: (n, p) => (n === 1
    ? `The only change is that an animal is now present in it, standing on the ground, correctly scaled to the space and secondary to the place itself.`
    : `The only change is that animals are now present in it, standing on the ground, correctly scaled to the space and secondary to the place itself.`)
    + skSpecies(n, p, 'animal'),
  // "of the kind this place already uses" is the conditional form again: it
  // makes the model read the room rather than invent a fitting for it.
  lamp: n => n === 1
    ? `The only change is that a light fitting is now mounted there and switched on: a fitting of the kind this place already uses, giving off light.`
    : `The only change is that light fittings are now mounted there and switched on: fittings of the kind this place already uses, giving off light.`,
  hidden: () => `The only change is that concealed lighting is now switched on there: the fitting itself stays completely out of sight, and only the light it throws across the surface is visible — an even wash, brightest closest to where it is concealed, fading away smoothly.`,
  // Three things carry the whole idea and all three are stated: it is cut off
  // by the frame, it is nearer than whatever the camera is focused on, and the
  // tree it belongs to is not in the picture. Leave any of them out and what
  // comes back is a tree standing in the scene, which is what he already had.
  // Same two phrases that inflated the foliage were in here too, and they did
  // the same thing: "arm's length" and "larger than anything behind" turned a
  // slim trunk into a redwood. Depth is stated as tone and focus only. How
  // thick the trunk is comes from how thick the stroke is — the mask decides
  // that — so the sentence stays out of it.
  fgtrunk: (n, p) => (p && p.grounded)
    ? (n === 1
        ? `The only change is that the trunk of a tree now stands between the camera and the scene: rough bark running up out of the top of the frame with its crown out of view, a few small leafy shoots breaking straight from the bark here and there as they do on a real trunk, and at the bottom the base of it widening where it meets the ground, the ground closing around the foot with its own grass and fallen litter, reading darker than the scene behind it, and a little soft because the camera is focused past it on that scene.`
        : `The only change is that the trunks of trees now stand between the camera and the scene: rough bark, each trunk exactly as thick as it is drawn, the thickest of them nearest the camera, all running up out of the top of the frame with their crowns out of view, a few small leafy shoots breaking straight from the bark here and there as they do on real trunks, and at the bottom the base of each widening where it meets the ground, the ground closing around the feet with its own grass and fallen litter, all reading darker than the scene behind them, and softest on the nearest because the camera is focused past them on that scene.`)
    : (n === 1
    ? `The only change is that the trunk of a tree now stands between the camera and the scene: rough bark running out of the top and the bottom of the frame so that neither the crown nor the foot of it is in view, a few small leafy shoots breaking straight from the bark here and there as they do on a real trunk, reading darker than the scene behind it, and a little soft because the camera is focused past it on that scene.`
    : `The only change is that the trunks of trees now stand between the camera and the scene: rough bark, each trunk exactly as thick as it is drawn, the thickest of them nearest the camera and running out of both the top and the bottom of the frame, the thinner ones standing further back among them so that the stand has depth to it, a few small leafy shoots breaking straight from the bark here and there as they do on real trunks, all reading darker than the scene behind them, and softest on the nearest because the camera is focused past them on that scene.`),
  // "seen from arm's length" and "larger than anything behind" both pushed the
  // scale up, and what came back was three or four enormous leaves. What the
  // photographs actually show is the outer edge of a canopy: slender twigs
  // carrying a lot of small leaves. Say that instead, and say the depth in
  // terms of tone rather than size, or the size climbs again.
  fgleaf: n => n === 1
    ? `The only change is that the outer branches of a tree now reach into the frame from just outside it: a spreading branch carrying the ordinary broad leaves of a shade tree, full and overlapping rather than sparse, entering from the edge of the frame with the tree they belong to out of shot, hanging in front of the scene and reading darker than it, and a little soft because the camera is focused past them on the scene beyond.`
    : `The only change is that the outer branches of trees now reach into the frame from just outside it: spreading branches carrying the ordinary broad leaves of a shade tree, full and overlapping rather than sparse, entering from the edges of the frame with the trees they belong to out of shot, hanging in front of the scene and reading darker than it, and a little soft because the camera is focused past them on the scene beyond.`
};
const SK_EMITTING = { lamp:1, hidden:1 };

// peetz on 2026-09-01: the tree reads matte, with no sheen or reflection. The
// sketch prompt never asked for any — SK_DAYLIT covers light direction and a
// ground shadow and stops there, while the exterior prompt has carried
// "micro-texture, sheen and reflectivity" all along. This is that vocabulary
// finally reaching this mode.
//
// A longer version naming waxy leaf surfaces and specular highlights performed
// no better and is not used. Neither shows up in the numbers — highlight share
// sat at 3.00% for all three variants and leaf contrast moved 47.90 -> 48.48 —
// but the sun glints are plain in the image. Judge this one by eye.
//
// Bark is not foliage, so trunk and fgtrunk are left out.
// peetz asked for small, fine, realistic leaves on 2026-09-01. Four wordings
// were run on the same frame and seed, leaf grain against a 16.90 baseline:
//
//   "many small individual leaves, a few centimetres across"        18.41
//   naming a species — "pinnate leaflets, like a rain tree"         16.94
//   this one — fine and airy, sky through the gaps, broken edge     18.72
//
// Naming a species changed the tree outright into a rain tree, which is why I
// first read it as the winner; peetz picked this one instead on 2026-09-01 and
// it is also the highest grain of the four. Naming a species is the stronger
// lever but it commits every project to one tree — this asks for the quality
// peetz wanted (fine, airy, an edge that breaks into individual leaves against
// the sky) without deciding the species for him.
//
// It is a default, not a lock: the per-type description field appends after
// this and overrides it.
const SK_FINE_LEAF = ` The foliage is fine and airy: the leaves are small enough that daylight and sky show through the gaps between them all across the crown, and the outer edge of the canopy breaks into individual small leaves against the sky rather than ending in a smooth mass.`;

const SK_LEAF_GLOSS = ` The foliage is glossy and slightly reflective, with sunlight glinting off individual leaf surfaces and a clear difference between the sunlit leaves and the shaded ones inside the canopy.`;
const SK_FOLIAGE = { tree:1, canopy:1, fgleaf:1 };

function buildSketchPromptP(p = {}){
  const type = SK_WHAT[p.type] ? p.type : 'tree';
  const count = Math.max(1, Math.round(Number(p.count) || 1));
  const tail = SK_EMITTING[type] ? SK_EMIT
    : SK_FRAMING[type] ? (count === 1 ? SK_FRAME : SK_FRAME_PL)
    : (count === 1 ? SK_DAYLIT : SK_DAYLIT_PL);
  const desc = String(p.desc || '').trim();
  // On the chips that have to name the thing, the description field IS that
  // name: it replaces the default species rather than arriving after it, so the
  // sentence never asks for a rain tree and a mango tree at once. Everywhere
  // else the field keeps its old meaning and is appended.
  const names = !!SK_DEFAULT_SPECIES[type === 'canopy' ? 'tree' : type];
  const q = names ? Object.assign({}, p, { species: desc }) : p;
  // Free text is appended rather than spliced in, so the wording that was
  // actually rendered stays byte-for-byte intact.
  const parts = [SK_BASE + ' ' + SK_WHAT[type](count, q) + tail + (SK_FOLIAGE[type] ? SK_FINE_LEAF + SK_LEAF_GLOSS : '')];
  if(desc && !names) parts.push(`Additional Instructions:\n${desc}`);
  return parts.join('\n\n');
}

// ---- drawing surface -------------------------------------------------------
// Strokes are stored in normalised 0..1 coordinates, so the same list redraws
// correctly at preview scale and exports correctly at mask scale.
const SK = { strokes: [], cur: null, hover: null, type: SK_TYPES[0].id, stage: 'sketch' };
const SK_DESC = {};

function skSetImage(url){
  SK.strokes = []; SK.cur = null;
  const img = $('skImg');
  img.onload = () => {
    img.style.display = '';
    $('skCanvas').style.display = '';
    $('skEmpty').style.display = 'none';
    skFitCanvas();
    refreshWorkNotes();
  };
  img.src = url;
  // A finished run leaves the stage on Result. A new image means a new drawing,
  // so come back to the canvas — otherwise the next upload lands on a hidden
  // stage, and a hidden stage has no size for a stroke to be measured against.
  if(state.workflow === 'sketch') skSetStage('sketch');
  skRefreshUI();
}

// The image is object-fit:contain inside the stage, so the canvas has to be
// placed over the letterboxed rectangle rather than over the whole box —
// otherwise a stroke lands somewhere else in the mask than where it was drawn.
function skFitCanvas(){
  const img = $('skImg'), cv = $('skCanvas'), wrap = $('skWrap');
  if(!img.naturalWidth || !wrap.clientWidth) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  cv.style.left = Math.round((W - w) / 2) + 'px';
  cv.style.top  = Math.round((H - h) / 2) + 'px';
  cv.style.width = w + 'px'; cv.style.height = h + 'px';
  cv.width = w; cv.height = h;
  skRedraw();
}

function skPaint(ctx, strokes, W, H, colour, extra, dy){
  const short = Math.min(W, H);
  const pad = extra || 0, oy = dy || 0;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for(const st of strokes){
    ctx.strokeStyle = colour || SK_TYPE_BY_ID[st.type].color;
    ctx.lineWidth = Math.max(2, st.size / 100 * short + 2*pad);
    ctx.beginPath();
    st.pts.forEach((p, i) => i ? ctx.lineTo(p[0]*W, p[1]*H + oy) : ctx.moveTo(p[0]*W, p[1]*H + oy));
    // A single tap is still a dot, not nothing.
    if(st.pts.length === 1) ctx.lineTo(st.pts[0][0]*W + 0.01, st.pts[0][1]*H + oy);
    ctx.stroke();
  }
}

// Grown/graded shadow room removed 2026-08-19 at peetz's call, after three
// renders that each traded one fault for another: at full strength it grew a
// second tree in ground meant only to be shaded, at half strength it produced
// nothing at all, and at 85% the tree still would not settle onto the ground.
// The mask is the stroke and nothing else now — draw where the thing goes,
// including down to where it meets the ground, and let the model work out the
// shadow the way it works out everything else in the frame.

// A reusable offscreen canvas, kept rather than allocated per redraw, because a
// redraw happens on every pointermove.
function skLayer(key, W, H){
  const c = SK[key] || (SK[key] = document.createElement('canvas'));
  if(c.width !== W || c.height !== H){ c.width = W; c.height = H; }
  else c.getContext('2d').clearRect(0, 0, W, H);
  return c;
}

function skRedraw(){
  const cv = $('skCanvas');
  if(!cv.width) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const all = SK.cur ? SK.strokes.concat([SK.cur]) : SK.strokes;

  if(all.length){
    // Painted opaque into its own canvas and composited once. Setting
    // globalAlpha and painting straight onto the stage stacks every overlapping
    // stroke, and the overlaps then read darker than the strokes themselves.
    const marks = skLayer('layerMarks', cv.width, cv.height);
    skPaint(marks.getContext('2d'), all, cv.width, cv.height, null);
    ctx.globalAlpha = 0.45; ctx.drawImage(marks, 0, 0);
    ctx.globalAlpha = 1;
  }
  skCursor(ctx, cv.width, cv.height);
}

// The brush lays down a round stamp — measured 86x86 for a 10% brush, area
// 0.998 of a true circle — but the pointer was a crosshair, which tells you
// nothing about how much of the frame that stamp covers. So the pointer is the
// stamp: a ring at its real size. Drawn last so it sits over the strokes, and
// never exported — skMaskBlob paints a fresh canvas.
function skCursor(ctx, W, H){
  if(!SK.hover) return;
  const short = Math.min(W, H);
  const rad = Math.max(2, skBrushSize() / 100 * short) / 2;
  const x = SK.hover[0] * W, y = SK.hover[1] * H;
  ctx.save();
  // A dark ring under a light one, so the cursor reads on a bright sky and on
  // dark asphalt without knowing which it is over.
  ctx.lineWidth = 3; ctx.strokeStyle = '#00000088';
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI*2); ctx.stroke();
  ctx.lineWidth = 1.4; ctx.strokeStyle = SK_TYPE_BY_ID[SK.type].color;
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI*2); ctx.stroke();
  ctx.restore();
}

// The frame with this pass's strokes stamped into it, at the exact size the
// pass will work at.
//
// This is the piece that was missing for a year of attempts. A mask is a
// permission, not a shape: it says which pixels may change and nothing at all
// about what belongs there, so the drawn silhouette never reached the model —
// which is why a leaning trunk came back as no trunk. Stamping it into the
// pixels hands it to FLUX.2 through ReferenceLatent, the model's own channel
// for reading the picture it is editing. Inside the mask the sampler still
// starts from pure noise, so the flat colour itself does not survive into the
// result; only the shape does.
//
// Measured 2026-08-20 on a finished 1968x1056 exterior, one drawn tree leaning
// hard to the left, everything else identical: unpainted came back as a canopy
// with no trunk at all, painted came back as a full tree whose trunk follows
// the drawn line down to the ground. Outside the mask 3.14 vs 3.37 — the frame
// is no more disturbed than before.
function skPaintedBlob(imgEl, type, W, H){
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, W, H);

  const t = SK_TYPE_BY_ID[type];
  const mine = SK.strokes.filter(st => st.type === type);
  const lay = document.createElement('canvas');
  lay.width = W; lay.height = H;
  const lctx = lay.getContext('2d');
  // Softened, so the model is not asked to reproduce a hard paint edge.
  lctx.filter = 'blur(' + Math.max(1, Math.round(Math.min(W, H) / 400)) + 'px)';
  // The thin-stroke rule only means anything alongside a thick one. A tree
  // drawn entirely with a small brush is a tree, not a bare trunk — and
  // stamping every stroke in bark left the model no green anywhere, so it
  // invented a canopy at a size and a place of its own choosing. Measured
  // 2026-08-20 on peetz's own run: a brown squiggle at x 0.41 came back as a
  // pine filling the right half of the frame.
  const hasCanopy = mine.some(st => st.size >= SK_THIN);
  if(t.paintThin && hasCanopy){
    skPaint(lctx, mine.filter(st => st.size >= SK_THIN), W, H, t.paint);
    skPaint(lctx, mine.filter(st => st.size <  SK_THIN), W, H, t.paintThin);
  }else{
    skPaint(lctx, mine, W, H, t.paint);
  }
  lctx.filter = 'none';
  // Clip the paint back to the stroke exactly. The blur carries colour a few
  // pixels past the edge, and those pixels lie outside the mask — where
  // nothing is regenerated, so they survive verbatim into the result. Measured
  // 2026-08-20: without this, a drawn canopy came back wearing a green halo
  // against the sky.
  //
  // The clip is built whole on its own canvas first. destination-in composites
  // once per drawing operation, so stroking the shapes straight onto the layer
  // would intersect them instead of uniting them — two strokes came back as
  // only the patch where they crossed.
  const clip = document.createElement('canvas');
  clip.width = W; clip.height = H;
  skPaint(clip.getContext('2d'), mine, W, H, '#fff');
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(clip, 0, 0);
  ctx.drawImage(lay, 0, 0);
  return new Promise(r => c.toBlob(r, 'image/png'));
}

// How much of the drawing came back as drawing.
//
// This mode has one failure that looks like success from a distance: the
// sampler runs its full time and hands back the stamped colour, unchanged, as
// flat paint sitting on top of the render. The first version of this check
// measured the whole frame and missed it — on peetz's run of 2026-08-20 the
// frame had moved 10.28 overall, comfortably "fine", while 16.5% of the result
// was still literally the paint colour and two flat blobs were sitting in the
// picture. Averages hide a local disaster.
//
// So count the pixels instead. Real foliage does land near the stamped green
// here and there, so the line is not at zero — measured across nine renders,
// eight that worked came in between 0.04% and 0.65%, and the one that failed
// came in at 19.98%. Three percent sits five times above the worst good run
// and seven times below the bad one.
const SK_PAINT_LEFT = 0.03;

async function skPaintLeft(type, resultImg){
  try{
    const t = SK_TYPE_BY_ID[type];
    const wanted = [t.paint, t.paintThin].filter(Boolean).map(hexToRGB);
    if(!wanted.length) return null;
    const im = await skLoadImage(await (await fetch(viewUrlFor(resultImg))).blob());
    const W = im.naturalWidth, H = im.naturalHeight;
    if(!W) return null;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently:true });
    x.drawImage(im, 0, 0, W, H);
    const px = x.getImageData(0, 0, W, H).data;
    let left = 0;
    for(let i = 0; i < W*H; i++){
      for(const [r, g, b] of wanted){
        if(Math.abs(px[i*4] - r) < 12 && Math.abs(px[i*4+1] - g) < 12 && Math.abs(px[i*4+2] - b) < 12){ left++; break; }
      }
    }
    return left / (W*H);
  }catch(e){
    // A measurement that cannot be taken must not stop a run that succeeded.
    return null;
  }
}

function hexToRGB(hex){
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Decoded through a blob URL rather than straight off the server, because a
// cross-origin image taints the canvas it is drawn on and toBlob then throws.
function skLoadImage(blob){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('decode failed'));
    im.src = url;
  });
}

// Masks are exported at the source's own aspect ratio, capped on the long edge:
// the sampler rescales the mask to the latent anyway, but a mask with a
// different aspect ratio would arrive stretched.
function skMaskSize(){
  const img = $('skImg');
  const s = Math.min(1, 1536 / Math.max(img.naturalWidth, img.naturalHeight));
  return [Math.max(8, Math.round(img.naturalWidth * s)), Math.max(8, Math.round(img.naturalHeight * s))];
}

// Pick the size the frame is worked at: both sides multiples of 16, so the VAE
// has nothing left to crop, and as close to the source's own ratio as a pair of
// integers allows. Ratio is weighted far above pixel count because a frame
// 2% under the requested megapixels looks identical and a frame 0.8% out of
// proportion does not — it stops lining up with the original.
function skWorkSize(w, h, megapixels){
  const target = Math.max(0.25, megapixels) * 1024 * 1024;
  const aspect = w / h;
  const err = (ww, hh) => Math.abs(ww / hh - aspect) / aspect;

  // The size the old megapixel path ended up at, after the VAE had cropped each
  // side down to a multiple of 16. It is a candidate, not just history: FLUX
  // draws its noise to the shape of the latent, so changing the canvas by even
  // 16px makes the same seed a different picture. A frame whose proportion was
  // never wrong should therefore keep the exact canvas it had, or every seed
  // peetz has already judged stops meaning anything. Measured on the frame that
  // caught this: 860x858 came back with different light and materials purely
  // because 1440x1440 became 1456x1456, and both are exactly square.
  const s = Math.sqrt(target / (w * h));
  const legacy = [Math.max(16, Math.floor(Math.round(w * s) / 16) * 16),
                  Math.max(16, Math.floor(Math.round(h * s) / 16) * 16)];

  // The megapixel setting is a budget, not a suggestion. Weighting proportion a
  // thousand times above pixel count used to let an exact-ratio candidate win
  // however far over budget it was, and for a source already aligned to 16 the
  // exact-ratio candidate is the source itself: "1 MP" handed back 1504x816,
  // 17% over. That is not a rounding detail. Sketch to Add runs img2img, whose
  // strength is quantised to whole sampler steps, and how much of the schedule
  // one step is worth moves with the canvas — 1504x816 needed 19 steps of 20 to
  // change anything at all where 1312x704 needed 17. A canvas that quietly
  // grows past what was measured takes the settings out from under the user.
  //
  // So: nothing over budget, then the truest proportion, then the closest to
  // the budget. 1504x816 at 1 MP now lands on 1328x720 — 0.07% off in
  // proportion, which is a pixel and a half across the frame.
  // Truest proportion first, then as many pixels as that allows. Scoring the
  // two against each other with a weight was the mistake: any weight either
  // buys a rounding-error's worth of proportion with a quarter of the
  // resolution, or the reverse. Ranking them instead — smallest error wins, and
  // among the ones that tie within a rounding error, the largest — needs no
  // weight and gives a defensible answer at every aspect tried.
  const centre = Math.round(Math.sqrt(target / aspect) / 16) * 16;
  const cands = [];
  for(let hh = centre - 128; hh <= centre + 128; hh += 16){
    if(hh < 64) continue;
    const ww = Math.max(64, Math.round(hh * aspect / 16) * 16);
    if(ww * hh > target * 1.06) continue;
    cands.push({ w: ww, h: hh, e: err(ww, hh) });
  }
  // The legacy size floors both sides, so it is always inside the budget and
  // there is always something to fall back to.
  if(!cands.length) return legacy;
  const floor = Math.min(...cands.map(c => c.e));
  // 0.05% of proportion is well under a pixel across a 1500px frame. Anything
  // looser started trading a visible 16:9 frame away for 18% more pixels.
  const tied = cands.filter(c => c.e <= floor + 0.0005);
  const best = tied.reduce((a, b) => (b.w * b.h > a.w * a.h ? b : a));
  // Only move the canvas when moving it actually buys a truer proportion.
  return err(legacy[0], legacy[1]) <= err(best.w, best.h) + 1e-9 ? legacy : [best.w, best.h];
}

// Sketch to Add edits a photograph that is already the size it wants to be, so
// it works at that size and hands it back unchanged. Everything else in the
// tool is a render, where the megapixel setting picks the output; here the
// input IS the output, and resizing it was silently moving the picture.
//
// peetz said the frame felt like it was shifting, and it was: 1376x592 in came
// back 1488x640 — bigger than it went in — and 1504x816 came back 1328x720.
// Not a drift inside the frame (an offset search over the untouched half of
// eight renders finds dx=0 dy=0 every time), just a different size and a
// hundredth of a percent of aspect each round trip.
//
// Frames out of this tool are already multiples of 16, so almost always there
// is nothing to do. A frame from somewhere else is nudged to the nearest 16,
// at most 8px a side. Only something too big to sample is handed to the
// megapixel path, and the run says so when that happens.
const SK_MAX_PIXELS = 2.25 * 1024 * 1024;

function skSketchSize(w, h, megapixels){
  if(w % 16 === 0 && h % 16 === 0 && w * h <= SK_MAX_PIXELS) return [w, h];
  const near = [Math.max(16, Math.round(w / 16) * 16), Math.max(16, Math.round(h / 16) * 16)];
  if(near[0] * near[1] <= SK_MAX_PIXELS) return near;
  return skWorkSize(w, h, megapixels);
}

// The mask is the drawing plus a margin, and the margin is the whole point.
//
// A mask that hugs the stroke exactly forces every leaf inside a solid blob, so
// a drawn canopy comes back as a dense ball with no branches and no shadow —
// the same tree, generated with no mask at all, comes back airy and casts one.
// Measured 2026-08-20 against the untouched frame, outside the drawn shape:
//
//   margin        the tree                far houses   road
//   0             a solid ball                  3.19   3.86
//   5%            natural, casts a shadow       8.55   5.51
//   11%           real branching structure     19.23   7.86
//   no mask       real branching structure     13.52  14.17
//
// So it is one dial, not a choice: room for the tree is paid for in scenery
// that gets regenerated with it. 5% buys most of the tree for little of the
// frame, which is why it is the default.
//
// This is the "shadow room" that failed in August and had to be pulled — it
// grew a second tree in ground that was only meant to be shaded. It works now
// because the frame that goes up is painted: the grown ring shows ground and
// sky, so there is nothing there inviting a second tree. Without the paint,
// do not bring this back.
// Which types stand on the ground and therefore throw a shadow across it. Not
// the lights, which give light rather than take it, and not the framing, which
// is in front of the camera and has no ground of its own.
const SK_ON_GROUND = { tree:1, canopy:1, trunk:1, rock:1, people:1, car:1, animal:1 };

function skMaskBlob(type, W, H, grow, foot){
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  const mine = SK.strokes.filter(s => s.type === type);
  skPaint(ctx, mine, W, H, '#fff', Math.max(0, grow || 0));

  // A trunk that stops inside the frame needs somewhere to put its base. The
  // mask is otherwise exactly the stroke, and a base is wider than the trunk it
  // holds up and sits on ground that has to close around it — with nothing
  // spare, the first attempt came back as a pole sawn off in mid-air above the
  // pavement. So a short wedge at the foot of each stroke, wider than the
  // stroke and reaching a little below where it ended. Only at the foot: widen
  // the whole thing and the trunk is fat again, which is the bug this replaced.
  // The ground the shadow lands on has to be inside the mask or it cannot be
  // drawn at all — that is the whole reason a masked render had no shadow while
  // an unmasked one did, and no wording could bridge it, because the pixels
  // outside a mask are written back every step at the latent level.
  //
  // So the mask reaches down to the bottom of the frame from just above where
  // the drawing meets the ground. Measured on the same drawing and seed, how
  // much darker beside the tree than away from it, and what it cost:
  //
  //   mask alone           +1.3   no shadow          frame moved 7.66
  //   mask + this apron    -4.1   shadow             frame moved 8.37
  //   no mask at all       -1.2   weaker shadow      frame moved 9.36
  //
  // Better than regenerating everything on both counts: the building, the sky
  // and the far side of the street stay locked, and only the ground opens up.
  if(SK_ON_GROUND[type]){
    const low = mine.reduce((m, st) => Math.max(m, ...st.pts.map(p => p[1])), 0);
    // A quarter of the frame is as far up as it goes; a canopy drawn high with
    // no trunk must not turn the apron into half the picture.
    const top = Math.max(low - 0.04, 0.75);
    ctx.fillStyle = '#fff';
    // The apron used to run the full width of the frame, which was harmless
    // while nothing outside the mask was kept — but once the result is
    // composited back (see buildKleinSketchPrompt) the apron is the only part
    // of the ground still being redrawn, and it was being redrawn everywhere.
    // Measured 2026-09-02 on a four-pass run: above the apron the frame now
    // holds at 2.72 against the original, inside it 40.94, and the driveway
    // came back 16.7 darker than it went in.
    //
    // So the apron follows the drawing instead of the frame: a column under
    // each stroke, widened by how tall that stroke is, because with the sun
    // anywhere near 45 degrees a shadow reaches about as far sideways as the
    // thing is high. A dog gets a little ground; a tree gets a lot.
    for(const st of mine){
      const xs = st.pts.map(p => p[0]);
      const ys = st.pts.map(p => p[1]);
      const tall = (Math.max(...ys) - Math.min(...ys)) * H;
      const room = Math.min(Math.max(tall, 0.06 * W), 0.35 * W);
      const x0 = Math.max(0, Math.round(Math.min(...xs) * W - room));
      const x1 = Math.min(W, Math.round(Math.max(...xs) * W + room));
      ctx.fillRect(x0, Math.round(top * H), x1 - x0, H - Math.round(top * H));
    }
  }

  if(foot){
    for(const st of mine){
      const low = st.pts.reduce((a, b) => (b[1] > a[1] ? b : a), st.pts[0]);
      // Wide enough for the base and the ground it stands on. Long enough for a
      // cast shadow it is not: extending it to 7.5% of the frame below each
      // foot changed the ground brightness under the trunks from 52.0 to 52.2,
      // which is nothing. A framing element cut off by the frame does not get
      // a shadow out of this graph — see the note in memory before trying
      // again.
      skPaint(ctx, [{ type, size: st.size * 4,
        pts: [[low[0], low[1] - 0.015], [low[0], low[1] + 0.03]] }], W, H, '#fff');
    }
  }
  return new Promise(r => c.toBlob(r, 'image/png'));
}
// Only a trunk has a foot worth showing.
const SK_HAS_FOOT = { fgtrunk:1 };

// Framing is masked whatever the scope says, because the mask is what makes a
// drawn width come back as that width — and width is the whole control for
// something standing in front of the lens. Everything else follows the scope
// the user picked, which defaults to the unmasked run: that is the one that
// throws shadows, and peetz picked it on the strength of SSS_00577.
const SK_ALWAYS_MASK = { fgtrunk:1, fgleaf:1 };

// The settle pass. A masked run puts the thing exactly where it was drawn and
// cannot cast its shadow, because the shadow lands on ground the mask is
// holding still — measured, the ground beside a masked tree stays at 160.6
// against 161.2 untouched, while an unmasked run takes it to 153.5. Room does
// not buy it back either; a shadow crosses half the picture.
//
// So the shadow is a second pass rather than a compromise on the first. It adds
// nothing — there is no drawing in it and nothing to place — it only asks that
// what is already standing in the light drop a shadow, unmasked so the ground
// is free to darken. Measured on a masked render that had none: ground 160.6 ->
// 153.0, whole frame moved 8.10, and the tree itself stayed put.
//
// At 0.85 it does not cast a shadow, it just dims the picture — and that took
// peetz's own frames to find, because the one I measured it on happened to
// work. Measured on his 1520x800 render, how much darker near the tree than
// far from it:
//
//   0.85    +1.7   near darkened LESS than far — no shadow, just a duller frame
//   0.90    +4.7   still none
//   0.95    -4.6   a dappled shadow on the road, visible
//
// So 0.95. It moves the frame more — 10.86 against 6.41 — which is the price
// of letting the ground be redrawn enough to have a shadow put on it.
//
// It runs once at the end, not once per chip, so a three-chip run costs one
// extra pass and not three.
const SK_SETTLE = `This is a finished photograph. Leave it exactly as it is — the same place, the same objects in the same positions, the same materials, the same colours, the same lighting and the same camera. Nothing already in the frame is moved, replaced, restyled or removed. The one thing that is completed is the light: everything standing in it casts its own shadow onto the ground, falling in the same direction and with the same softness as the shadows already there.`;

// How many separate things were drawn — not how many strokes it took to draw
// them. Strokes that touch are one object.
//
// This used to count strokes, and it was harmless while the drawing was only a
// mask: a canopy blob and a trunk line really were two marks in two places.
// Once the drawing became a shape the model reads, it stopped being harmless.
// A tree drawn the natural way — one fat stroke for the crown, one thin one for
// the trunk — counted as two, so the prompt asked for "trees", and the run came
// back with the painted crown untouched and a second tree grown beside it.
// Measured 2026-08-20, and it is the whole reason that frame failed.
function skGroupCount(strokes){
  const img = $('skImg');
  const W = img.naturalWidth || 1, H = img.naturalHeight || 1;
  const short = Math.min(W, H);
  // Points are normalised to each side; put both on the short side's scale so
  // one distance means the same thing horizontally and vertically.
  const sx = W / short, sy = H / short;
  const rad = st => (Math.max(2, st.size / 100 * short + 2) / 2) / short;
  const parent = strokes.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for(let i = 0; i < strokes.length; i++){
    for(let j = i + 1; j < strokes.length; j++){
      if(find(i) === find(j)) continue;
      const rr = rad(strokes[i]) + rad(strokes[j]);
      let hit = false;
      for(const a of strokes[i].pts){
        for(const b of strokes[j].pts){
          const dx = (a[0] - b[0]) * sx, dy = (a[1] - b[1]) * sy;
          if(dx*dx + dy*dy <= rr*rr){ hit = true; break; }
        }
        if(hit) break;
      }
      if(hit) parent[find(i)] = find(j);
    }
  }
  return new Set(strokes.map((_, i) => find(i))).size;
}

// Passes in the order the types were first drawn, so the list on screen and the
// order they render in are the same thing.
// Ordered by the type's own pass order first — a trunk needs the canopy already
// in the frame to grow up and meet — then by the order the types were drawn, so
// anything the table treats as equal still renders in the order it was sketched.
function skPasses(){
  const drawn = [], byType = {};
  for(const s of SK.strokes){
    if(!byType[s.type]){ drawn.push(s.type); byType[s.type] = []; }
    byType[s.type].push(s);
  }
  return drawn
    // A stroke that stops inside the frame is a trunk whose foot you can see,
    // and a foot needs a base — peetz asked for it after drawing down to the
    // grass and getting a pole that just ended. One that runs off the bottom
    // edge has no foot to show. The drawing already says which, so nothing new
    // to set: the lowest point decides it.
    .map((t, i) => ({ type: t, count: skGroupCount(byType[t]), order: SK_TYPE_BY_ID[t].order, seq: i,
      grounded: byType[t].every(st => st.pts.every(p => p[1] < 0.97)) }))
    .sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
}

function skRefreshPrompt(){
  const p = skPasses()[0];
  $('skPrompt').value = p ? buildSketchPromptP({ type: p.type, count: p.count, desc: SK_DESC[p.type], grounded: p.grounded }) : '';
}

function skRefreshUI(){
  skBrushRefresh();
  // The badge counts things, the same way the prompt does, so the number on the
  // chip is the number the model will be asked for.
  const counts = {};
  skPasses().forEach(p => counts[p.type] = p.count);

  const chips = $('skChips');
  chips.innerHTML = '';
  SK_TYPES.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sk-chip' + (SK.type === t.id ? ' on' : '');
    b.innerHTML = '<span class="sw" style="background:' + t.color + '"></span><span>' + t.label + '</span>'
      + (counts[t.id] ? '<span class="n">' + counts[t.id] + '</span>' : '');
    b.addEventListener('click', () => { SK.type = t.id; skRefreshUI(); });
    chips.appendChild(b);
  });

  const list = $('skPassList');
  list.innerHTML = '';
  const passes = skPasses();
  if(!passes.length){
    const d = document.createElement('div');
    d.className = 'sk-pass';
    d.style.cssText = 'color:var(--ink-faint);font-size:12px;';
    d.textContent = 'ยังไม่ได้วาดอะไรลงไป';
    list.appendChild(d);
  }else{
    passes.forEach((p, i) => {
      const t = SK_TYPE_BY_ID[p.type];
      const row = document.createElement('div');
      row.className = 'sk-pass';
      row.innerHTML = '<span class="sw" style="background:' + t.color + '"></span>'
        + '<span class="lbl">' + (i+1) + ' · ' + t.label + '</span>'
        + '<span class="cnt">×' + p.count + '</span>';
      const inp = document.createElement('input');
      inp.type = 'text';
      // On the naming chips this field is not "extra detail", it is the whole
      // difference between a tree and no tree — so the placeholder asks for the
      // name and shows what a working answer looks like. English for plants:
      // the Thai name of a Thai tree drew nothing, while the same tree named in
      // English drew fine. Animals are not like that — "แมว" returns a cat.
      inp.placeholder = SK_DESC_HINT[p.type] || 'รายละเอียดเพิ่มเติม (ไม่ใส่ก็ได้)';
      inp.value = SK_DESC[p.type] || '';
      // Only the prompt preview is rebuilt while typing — rebuilding this list
      // would take the focus out of the field on every keystroke.
      inp.addEventListener('input', () => { SK_DESC[p.type] = inp.value; skRefreshPrompt(); });
      row.appendChild(inp);
      list.appendChild(row);
    });
  }
  skRefreshPrompt();
  updateRunEnabled();
}

function skSetStage(which){
  SK.stage = which;
  const on = state.workflow === 'sketch';
  $('sketchStage').style.display = (on && which === 'sketch') ? 'flex' : 'none';
  $('cmp').style.display = (on && which === 'sketch') ? 'none' : '';
  document.querySelectorAll('#stageTabs .stg').forEach(b => b.classList.toggle('active', b.dataset.stg === which));
  if(on && which === 'sketch') skFitCanvas();
}

// The two scopes use different controls, and a control that does nothing is
// worse than no control — the Feather box sat there for weeks doing nothing.
function skSyncScope(){
  // Room only means something when there is a mask for it to grow.
  $('skRoomField').style.display = $('skScope').value !== 'masked' ? 'none' : '';
}

function skSyncMode(){
  const on = state.workflow === 'sketch';
  $('stageTabs').style.display = on ? '' : 'none';
  // Leaving the mode hides the canvas without going through skSetStage, which
  // would record "result" as the stage to come back to and lose the drawing.
  if(on){
    skSetStage(SK.stage);
  }else{
    $('sketchStage').style.display = 'none';
    $('cmp').style.display = '';
  }
  updateRunEnabled();
}

(function skInit(){
  const cv = $('skCanvas');
  // A zero-sized rect divides to NaN, and a NaN point paints nothing at all —
  // which reaches the GPU as an all-black mask that regenerates nothing and
  // reports no error. Refuse the point instead.
  const at = e => {
    const r = cv.getBoundingClientRect();
    if(!r.width || !r.height) return null;
    return [
      Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    ];
  };
  cv.addEventListener('pointerdown', e => {
    e.preventDefault();
    const p = at(e);
    if(!p) return;
    cv.setPointerCapture(e.pointerId);
    SK.hover = p;
    SK.cur = { type: SK.type, size: skBrushSize(), pts: [p], line: !!SK_TYPE_BY_ID[SK.type].line };
    skRedraw();
  });
  // Runs whether or not a stroke is in progress: the ring has to follow the
  // pointer before the first press, which is when its size matters most.
  cv.addEventListener('pointermove', e => {
    const p = at(e);
    if(!p) return;
    SK.hover = p;
    // A line stroke keeps two points: where it started and where the pointer
    // is now. Appending would record the hand's path and paint that instead.
    if(SK.cur) SK.cur.line ? (SK.cur.pts[1] = p) : SK.cur.pts.push(p);
    skRedraw();
  });
  cv.addEventListener('pointerleave', () => { SK.hover = null; skRedraw(); });
  const finish = () => {
    if(!SK.cur) return;
    SK.strokes.push(SK.cur);
    SK.cur = null;
    skRedraw();
    skRefreshUI();
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);

  $('skBrush').addEventListener('input', skBrushRefresh);
  $('skUndo').addEventListener('click', () => { SK.strokes.pop(); skRedraw(); skRefreshUI(); });
  $('skClear').addEventListener('click', () => { SK.strokes = []; skRedraw(); skRefreshUI(); });
  document.querySelectorAll('#stageTabs .stg').forEach(b =>
    b.addEventListener('click', () => skSetStage(b.dataset.stg)));
  $('btnRandSeedSketch').addEventListener('click', () => {
    $('skSeed').value = Math.floor(Math.random()*1_000_000_000);
  });
  // The stage resizes for reasons a window resize never reports — the chip row
  // wraps to two lines the first time a count badge appears, which shortens the
  // box under the canvas. The image is object-fit:contain so it re-centres
  // itself; the canvas is absolutely positioned and would not, and every stroke
  // after that would land somewhere else in the mask than on screen.
  // Held on SK rather than left unreferenced, which engines have been known to
  // collect. There is nothing to observe it from otherwise, and a stage whose
  // overlay stops following it puts every later stroke somewhere else in the
  // mask than on screen.
  // Refit only when the stage really changed size. The observer fires for any
  // reported size, including the one it is already at, and every refit resizes
  // the canvas element — which clears it and repaints it. That is the flash
  // peetz saw while dragging the brush.
  let fitW = 0, fitH = 0;
  SK.ro = new ResizeObserver(() => {
    if(SK.stage !== 'sketch') return;
    const w = $('skWrap').clientWidth, h = $('skWrap').clientHeight;
    if(w === fitW && h === fitH) return;
    fitW = w; fitH = h;
    skFitCanvas();
  });
  SK.ro.observe($('skWrap'));
  $('skScope').addEventListener('change', skSyncScope);
  skSyncScope();
  skRefreshUI();
})();

async function uploadBlob(blob, name){
  const form = new FormData();
  form.append('image', new File([blob], name, { type:'image/png' }));
  form.append('overwrite', 'true');
  const res = await fetch(baseUrl() + '/upload/image', { method:'POST', body: form });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()).name;
}

async function runSketchPasses(){
  const passes = skPasses();
  if(!passes.length){ log('ยังไม่ได้วาดอะไรลงไป — เลือกชนิดแล้วลากทับตำแหน่งที่ต้องการก่อน', 'err'); return; }

  const [mw, mh] = skMaskSize();
  // Two ways to run, and peetz chose the first on 2026-08-20 after seeing both.
  //
  // full   — no mask at all, denoise below 1. The model reads the painted frame
  //          and rewrites the whole picture from it, so the tree grows branches,
  //          breaks its own outline and throws a shadow. The scenery pays: the
  //          road and the far houses come back regenerated. Measured against the
  //          untouched frame, outside the drawn shape: road 14.17, far houses
  //          13.52, chairs 5.10 — the building and the furniture barely move,
  //          the distance does.
  // masked  — the mask holds everything outside it, so the frame is exact and
  //          the canopy is a solid ball, because every leaf has to fit inside
  //          what was drawn. Room around the stroke buys some of it back.
  //
  // Proportions are identical either way: node 45 is handed both sides already
  // multiples of 16 and holding the source's ratio, so nothing is cropped and
  // the frame comes out of the VAE the shape it went in. Measured 1968x1056
  // in, 1312x704 out, 1.863636 both.
  const full = $('skScope').value !== 'masked';
  const room = Math.round(Math.min(mw, mh) * (parseFloat($('skRoom').value) || 0) / 100);
  const seed = parseInt($('skSeed').value);
  const img = $('skImg');
  const common = {
    megapixels: parseFloat($('skMegapixels').value),
    // Fixed for the whole run, from the frame that was uploaded. Every pass
    // works at one size, so chaining cannot drift the proportions either.
    scaleTo: skSketchSize(img.naturalWidth, img.naturalHeight, parseFloat($('skMegapixels').value)),
    // Klein starts from an empty latent, so there is no source latent to hold
    // back and no denoise to hold it with. The drawing reaches the model as
    // pixels in the reference image and as the mask that buildKleinSketchPrompt
    // composites through — nothing else.
    denoise: 1
  };

  if(common.scaleTo[0] !== img.naturalWidth || common.scaleTo[1] !== img.naturalHeight){
    log('ภาพถูกปรับขนาดจาก ' + img.naturalWidth + '×' + img.naturalHeight
      + ' เป็น ' + common.scaleTo[0] + '×' + common.scaleTo[1] + ' เพื่อให้เจนได้', 'err');
  }

  const stamp = Date.now();
  // The frame each pass starts from, as a decoded image rather than a name:
  // every pass stamps its own strokes into it before sending it up, so the
  // silhouette reaches the model as pixels and not only as a permission.
  let curImg = img;
  let last = null;

  for(let i = 0; i < passes.length; i++){
    const p = passes[i];
    const passMasked = !full || SK_ALWAYS_MASK[p.type];
    log('รอบที่ ' + (i+1) + '/' + passes.length + ' · ' + SK_TYPE_BY_ID[p.type].label + ' · ' + p.count
      + ' ชิ้น · ' + (!passMasked
        ? (common.denoise >= 1
            ? 'วาดใหม่ทั้งภาพ ' + skSteps + ' สเต็ป'
            : 'เจนทั้งภาพ denoise ' + common.denoise.toFixed(2) + ' = ' + Math.round(skSteps * common.denoise) + '/' + skSteps + ' สเต็ป')
        : 'เฉพาะรอบที่วาด'));

    let inputName, maskName, painted;
    try{
      const [ww, wh] = common.scaleTo;
      painted = await skPaintedBlob(curImg, p.type, ww, wh);
      inputName = await uploadBlob(painted, 'sketchpaint_' + stamp + '_' + p.type + '.png');
      maskName  = (full && !SK_ALWAYS_MASK[p.type]) ? undefined
        : await uploadBlob(await skMaskBlob(p.type, mw, mh,
            SK_TYPE_BY_ID[p.type].noRoom ? 0 : room, SK_HAS_FOOT[p.type] && p.grounded),
            'sketchmask_' + stamp + '_' + p.type + '.png');
    }catch(e){
      log('อัปโหลดภาพที่วาดไม่สำเร็จ: ' + e.message, 'err');
      break;
    }

    const skOpts = Object.assign({}, common, {
      imageName: inputName,
      maskImage: maskName,
      // A mask has nothing to protect unless the sampler starts from the
      // source's own latent, which is the denoise-1 branch.
      denoise: maskName ? 1 : common.denoise,
      // A different seed per pass: the same one twice correlates what appears
      // in two unrelated masks.
      seed: seed + i,
      prompt: buildSketchPromptP({ type: p.type, count: p.count, desc: SK_DESC[p.type], grounded: p.grounded })
    });
    const img = await submitAndWait(buildKleinSketchPrompt(skOpts), SAVE_IMAGE_NODE_ID_KLEIN);

    if(!img){ log('หยุดที่รอบ ' + (i+1) + ' — ผลของรอบก่อนหน้ายังใช้ได้', 'err'); break; }
    last = img;

    const leftOver = await skPaintLeft(p.type, img);
    if(leftOver !== null && leftOver > SK_PAINT_LEFT){
      log('รอบนี้สีที่วาดยังค้างอยู่ในภาพ ' + (leftOver*100).toFixed(1) + '% — ไม่ได้กลายเป็นของจริง', 'err');
      log('ยิ่งวาดพื้นที่ใหญ่ ยิ่งต้องใช้ denoise สูงขึ้น — ลองเพิ่มทีละ 0.05 จนถึง 1.00 หรือวาดให้เล็กลง');
    }

    // Feed this pass into the next one. SaveImage writes to ComfyUI's output
    // folder and LoadImage reads its input folder, so the frame has to come
    // back over /view — and it comes back as an image rather than a name
    // because the next pass has to draw on it.
    if(i < passes.length - 1){
      try{
        const res = await fetch(viewUrlFor(img));
        if(!res.ok) throw new Error('HTTP ' + res.status);
        curImg = await skLoadImage(await res.blob());
      }catch(e){
        log('ส่งภาพต่อเข้ารอบถัดไปไม่ได้: ' + e.message, 'err');
        break;
      }
    }
  }

  // The settle pass is gone with FLUX.2. It re-ran the finished frame at
  // denoise 0.95 to coax out a shadow, which needs a source latent to start
  // from — Klein has none, so on this engine it would be a full redraw of the
  // whole picture and would undo the composite that keeps the frame still. It
  // was already off by default after it was measured dimming the image rather
  // than casting anything.

  if(last){
    showRunResult(last);
    skSetStage('result');
  }
}

// upload handling
const dropZone = $('dropZone'), fileInput = $('fileInput');
dropZone.addEventListener('click', ()=>fileInput.click());
['dragover','dragenter'].forEach(ev=>dropZone.addEventListener(ev, e=>{e.preventDefault();dropZone.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>dropZone.addEventListener(ev, e=>{e.preventDefault();dropZone.classList.remove('drag');}));
dropZone.addEventListener('drop', e=>{
  const f = e.dataTransfer.files[0];
  if(f) handleFile(f);
});
fileInput.addEventListener('change', e=>{
  const f = e.target.files[0];
  if(f) handleFile(f);
});

async function handleFile(file){
  clearLog();
  log('Uploading image to ComfyUI...');
  // local preview
  const url = URL.createObjectURL(file);
  state.origPreviewURL = url;
  // Read the surface colours once the preview has decoded, then rebuild the
  // hidden prompt so the sentence is in it before Run is pressed.
  $('previewImg').onload = () => { applyPromptType(); refreshWorkNotes(); };
  $('previewImg').src = url;
  $('previewBox').style.display = 'block';
  showBeforeOnly(url);
  skSetImage(url);

  try{
    const form = new FormData();
    form.append('image', file);
    form.append('overwrite', 'true');
    const res = await fetch(baseUrl() + '/upload/image', { method:'POST', body: form });
    if(!res.ok) throw new Error('Upload failed: HTTP '+res.status);
    const data = await res.json();
    state.uploadedName = data.name;
    log('Upload successful: ' + data.name, 'ok');
  }catch(e){
    log('Upload error: ' + e.message, 'err');
  }
  updateRunEnabled();
}

// Clear the source image and everything derived from it.
//
// Reproduced 2026-09-01: state.uploadedName is written in exactly one place —
// handleFile — and nothing ever reassigns it, so it kept pointing at the file
// dropped in at the start of the session no matter what ran afterwards. Skp to
// Render survived that because its graph carries a scaleTo and downscales the
// source to 2.5MP first. buildMagnificPrompt has no downscale node at all: it
// wires LoadImage straight into UltimateSDUpscale.
//
// So rendering a 4000x2323 SketchUp export and then clicking the Upscale tab
// fed 9.29MP into a graph the user believed was working on the 2176x1264 frame
// on screen — and 4x-UltraSharp runs at its native x4 whatever Upscale x is set
// to, which makes a 16000x9292 intermediate: 1.8GB for one tensor on a 12GB
// card. That is the 10240x5760 crawl already described above buildMagnificPrompt.
//
// upscaleLastResult and sketchLastResult always did the right thing — they
// re-upload the result and work on that. The mode tabs simply bypassed them,
// so the button and the tab gave different answers from the same screen with
// nothing visible to tell them apart. peetz's call: changing mode resets, and
// the new mode starts from a fresh upload. Nothing stale can survive the hop.
function resetSource(){
  state.uploadedName  = null;
  state.origPreviewURL = null;
  state.lastResult    = null;
  state.autoMaterials = '';

  $('previewBox').style.display = 'none';
  $('previewImg').removeAttribute('src');
  // Re-picking the same file has to re-fire change, and it only does that if
  // the input no longer holds it.
  $('fileInput').value = '';

  $('cmpEmpty').style.display = '';
  $('cmpAfterImg').style.display = 'none';
  $('cmpAfterImg').removeAttribute('src');
  $('cmpBeforeWrap').style.display = 'none';
  $('cmpLabelBefore').style.display = 'none';
  $('cmpLabelAfter').style.display = 'none';
  $('cmpLine').style.display = 'none';
  $('cmpDot').style.display = 'none';
  cmpRange.style.display = 'none';
  $('dlLink').removeAttribute('href');
  $('dlOrigLink').removeAttribute('href');
  $('actionsBottom').style.display = 'none';

  SK.strokes = []; SK.cur = null; SK.hover = null;
  $('skImg').removeAttribute('src');
  $('skImg').style.display = 'none';
  $('skCanvas').style.display = 'none';
  $('skEmpty').style.display = '';

  // The material sentence was read off the image that just went away, and the
  // work-size notes measure an image that is no longer there.
  applyPromptType();
  refreshWorkNotes();
  updateRunEnabled();
}

function updateRunEnabled(){
  // Sketch to Add has nothing to do until something is actually drawn — the
  // mask is the instruction, so an empty canvas is an empty request.
  const drawn = state.workflow !== 'sketch' || SK.strokes.length > 0;
  btnRun.disabled = !(state.connected && state.uploadedName && drawn);
}

$('btnRandSeedMagnific').addEventListener('click', ()=>{
  $('pSeed').value = Math.floor(Math.random()*1_000_000_000);
});

// SeedVR2 has no text encoder and takes exactly one step, so the three controls
// that only mean something to the diffusion refiner are hidden rather than left
// on screen doing nothing. Upscale By and Seed apply to both engines.
function applyUpscaleEngine(){
  const seed = upscaleEngine() === 'seedvr2';
  for(const id of ['pPromptField','pDenoiseField','pStepsField']){
    const el = $(id);
    if(el) el.style.display = seed ? 'none' : '';
  }
  const hintU = $('pHintUsdu'), hintS = $('pHintSeedvr2');
  if(hintU) hintU.style.display = seed ? 'none' : '';
  if(hintS) hintS.style.display = seed ? '' : 'none';
}
if($('pEngine')) $('pEngine').addEventListener('change', applyUpscaleEngine);
applyUpscaleEngine();

// Klein is guidance-distilled and starts from an empty latent, so Guidance,
// Quality/steps and Denoise never had anything to act on and their controls are
// gone. What is left is the floor: Klein was measured at 2.5MP and the HTML
// default of 1 belonged to FLUX.2, so lift it once at load.
(function renderSizeFloor(){
  const mp = $('sMegapixels');
  if(mp && parseFloat(mp.value) < 2.5) mp.value = '2.5';
})();
$('btnRandSeedSSS').addEventListener('click', ()=>{
  $('sSeed').value = Math.floor(Math.random()*1_000_000_000);
});
$('btnRandSeedPeople').addEventListener('click', ()=>{
  $('apSeed').value = Math.floor(Math.random()*1_000_000_000);
});

btnRun.addEventListener('click', runWorkflow);
$('btnUpscaleResult').addEventListener('click', upscaleLastResult);
$('btnSketchResult').addEventListener('click', sketchLastResult);

// The working size for whichever mode is about to run, from the frame that was
// uploaded. Sketch to Add has done this since 2026-08-19; the other flux2 modes
// were left on the old path and drift the same 0.82%, which peetz sees as the
// two halves of the compare slider refusing to line up. Same fix here: both
// sides multiples of 16 so the VAE has nothing to crop, chosen to hold the
// source's own ratio. Falls back to the old megapixel path if the preview has
// not reported its size yet, which only ever leaves it as it was.
function workSizeForPreview(megapixels){
  const pv = $('previewImg');
  if(!pv || !pv.naturalWidth || !pv.naturalHeight) return undefined;
  return skWorkSize(pv.naturalWidth, pv.naturalHeight, megapixels);
}

// A seed only reproduces a picture together with the canvas it was drawn on:
// FLUX generates its noise to the shape of the latent, so the same seed on a
// 90x90 latent and a 91x91 one are unrelated draws. peetz found this the hard
// way when a canvas moved by 16px and the light and materials came back
// different. The size is therefore shown next to the seed, so two runs can be
// told apart at a glance and a result worth keeping can be written down as the
// pair it actually is.
function refreshWorkNotes(){
  const rows = [
    ['sWorkNote',  'sMegapixels',  $('previewImg')],
    ['apWorkNote', 'apMegapixels', $('previewImg')],
    ['skWorkNote', 'skMegapixels', $('skImg')]
  ];
  for(const [noteId, mpId, img] of rows){
    const el = $(noteId);
    if(!el || !$(mpId)) continue;
    if(!img || !img.naturalWidth){ el.textContent = ''; continue; }
    const [w, h] = noteId === 'skWorkNote'
      ? skSketchSize(img.naturalWidth, img.naturalHeight, parseFloat($(mpId).value))
      : skWorkSize(img.naturalWidth, img.naturalHeight, parseFloat($(mpId).value));
    const kept = (w === img.naturalWidth && h === img.naturalHeight);
    el.textContent = 'ผืนผ้าใบ ' + w + '×' + h
      + (noteId === 'skWorkNote' && kept ? ' · เท่าภาพที่อัปโหลดพอดี' : '')
      + ' · seed ใช้ซ้ำได้เฉพาะกับภาพและขนาดนี้';
  }
}
['sMegapixels','apMegapixels','skMegapixels'].forEach(id => {
  const el = $(id);
  if(el) el.addEventListener('input', refreshWorkNotes);
});

async function runWorkflow(){
  btnRun.disabled = true;
  $('actionsBottom').style.display = 'none';
  if(state.origPreviewURL) showBeforeOnly(state.origPreviewURL);
  clearLog();

  // Sketch to Add runs its own loop: one masked pass per element type, each
  // starting from the previous pass's output, so it never reaches the
  // single-graph path below.
  if(state.workflow === 'sketch'){
    await freeIfModelSwitch('klein9b');
    await runSketchPasses();
    btnRun.disabled = false;
    return;
  }

  let prompt, saveImageNodeId;
  if(state.workflow === 'sss'){
    const opts = {
      imageName: state.uploadedName,
      prompt: $('sPromptType').value === 'custom' ? $('sPrompt').value : hiddenPromptCache,
      megapixels: parseFloat($('sMegapixels').value),
      scaleTo: workSizeForPreview(parseFloat($('sMegapixels').value)),
      seed: parseInt($('sSeed').value)
    };
    prompt = buildKleinPrompt(opts);
    saveImageNodeId = SAVE_IMAGE_NODE_ID_KLEIN;
  }else if(state.workflow === 'people'){
    // Same graph as Sketchup-to-Render. The mode differs only in the text it
    // sends: see buildAddPeoplePromptP for why a shorter prompt is the whole
    // mechanism and no img2img pass is involved.
    prompt = buildKleinPrompt({
      imageName: state.uploadedName,
      prompt: buildAddPeoplePromptP({
        pose: $('apPose').value, count: parseInt($('apCount').value), desc: $('apDesc').value
      }),
      megapixels: parseFloat($('apMegapixels').value),
      scaleTo: workSizeForPreview(parseFloat($('apMegapixels').value)),
      seed: parseInt($('apSeed').value)
    });
    saveImageNodeId = SAVE_IMAGE_NODE_ID_KLEIN;
  }else{
    const opts = {
      imageName: state.uploadedName,
      prompt: $('pPrompt').value,
      upscaleBy: parseFloat($('pUpscaleBy').value),
      denoise: parseFloat($('pDenoise').value),
      steps: parseInt($('pSteps').value),
      seed: parseInt($('pSeed').value)
    };
    prompt = buildUpscalePrompt(opts);
    saveImageNodeId = upscaleSaveNodeId();
  }

  await freeIfModelSwitch(
    state.workflow === 'magnific' ? upscaleModelKind() : 'klein9b');

  const img = await submitAndWait(prompt, saveImageNodeId);
  if(img) showRunResult(img);
  btnRun.disabled = false;
}

// Three families are still reachable: Klein 9B for Render, Add People and
// Sketch to Add; flux1-dev-fp8 for the Upscale card's detail engine; SeedVR2 for
// its fast one. ComfyUI's own eviction did not reliably swap between them on
// this box — measured 2026-08-17, when a stale load left only 743MB of 12.8GB
// free and the next model partially offloaded to system RAM, taking 10x longer
// than normal. Forcing an unload only on an actual model-family switch, not on
// repeat runs of the same workflow, avoids paying that reload when it is not
// needed. Now that every generative mode is Klein, the only switch left in
// ordinary use is stepping into or out of Upscale.
async function freeIfModelSwitch(modelKind){
  if(state.lastModelKind && state.lastModelKind !== modelKind){
    log('Switching model family (' + state.lastModelKind + ' -> ' + modelKind + '), freeing GPU memory first...');
    try{
      await fetch(baseUrl() + '/free', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ unload_models:true, free_memory:true })
      });
    }catch(e){ /* best effort — a failed free just means a slower load, not a broken run */ }
  }
  state.lastModelKind = modelKind;
}

// Build the /view URL for one SaveImage output entry.
function viewUrlFor(img){
  return baseUrl() + '/view?filename=' + encodeURIComponent(img.filename)
    + '&subfolder=' + encodeURIComponent(img.subfolder || '')
    + '&type=' + encodeURIComponent(img.type || 'output');
}

function showRunResult(img){
  const viewUrl = viewUrlFor(img);
  showCompare(state.origPreviewURL, viewUrl);
  $('dlLink').href = viewUrl;
  $('dlLink').download = img.filename;
  // Remembered so Upscale This knows what to work on. Every mode routes its
  // output through here, so the button works from all four without each one
  // having to hand it anything.
  state.lastResult = img;
  const up = $('btnUpscaleResult');
  if(up) up.disabled = !state.connected;
  const sk = $('btnSketchResult');
  if(sk) sk.disabled = !state.connected;
  $('actionsBottom').style.display = 'flex';
}

// Send the frame that was just produced into Sketch to Add, as its source.
//
// The route peetz works in is Skp to Render, then Sketch to Add, then Upscale,
// and every hop used to mean downloading the result and dropping it back in as
// a new upload. handleFile does exactly the right thing with it — it becomes
// the new original, the compare slider's before, and the sketch canvas's
// backdrop — so this only has to fetch it and hand it over.
async function sketchLastResult(){
  if(!state.lastResult){ log('ยังไม่มีภาพผลลัพธ์ให้วาดทับ', 'err'); return; }
  const btn = $('btnSketchResult');
  btn.disabled = true;
  try{
    log('ส่งภาพผลลัพธ์เข้าโหมด Sketch to Add...');
    const res = await fetch(viewUrlFor(state.lastResult));
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const file = new File([await res.blob()], 'sketch_' + Date.now() + '.png', { type:'image/png' });
    document.querySelector('.wf-opt[data-wf="sketch"]').click();
    await handleFile(file);
    $('paramsCardSketch').scrollIntoView({ behavior:'smooth', block:'start' });
  }catch(e){
    log('ส่งภาพเข้าโหมดวาดไม่สำเร็จ: ' + e.message, 'err');
  }
  btn.disabled = false;
  updateRunEnabled();
}

// Send the frame that was just produced straight into SSS Upscale.
//
// peetz's finding, 2026-08-20: rendering at 1MP with 20 steps gives the quality
// he wants for a fraction of the time that rendering at 2MP costs, and the
// stiffness that leaves is exactly what the upscale pass is for. Doing that by
// hand meant downloading the result and uploading it again as a new job, so the
// button does it in place.
//
// It reads the Upscale card's own settings whether or not that card is on
// screen, so the numbers behind the button are always the ones the user can see
// by switching to that mode — there is no second hidden set.
async function upscaleLastResult(){
  if(!state.lastResult){ log('ยังไม่มีภาพผลลัพธ์ให้ upscale', 'err'); return; }
  const btn = $('btnUpscaleResult');
  btn.disabled = true;
  btnRun.disabled = true;
  clearLog();

  let inputName;
  try{
    log('ส่งภาพผลลัพธ์กลับขึ้นไปเป็นภาพตั้งต้นของ Upscale...');
    const res = await fetch(viewUrlFor(state.lastResult));
    if(!res.ok) throw new Error('HTTP ' + res.status);
    inputName = await uploadBlob(await res.blob(), 'upscale_' + Date.now() + '.png');
  }catch(e){
    log('ส่งภาพขึ้นไปไม่สำเร็จ: ' + e.message, 'err');
    btn.disabled = false; updateRunEnabled(); return;
  }

  // Upscale is the only mode that leaves the flux2 family, so coming from any
  // other mode is always a model-family switch — the one case where ComfyUI's
  // own eviction was measured not to keep up. Which family it lands on now
  // depends on the engine.
  await freeIfModelSwitch(upscaleModelKind());

  log(upscaleEngine() === 'seedvr2'
    ? 'Upscale ×' + $('pUpscaleBy').value + ' · SeedVR2 7B (ในห้อง)'
    : 'Upscale ×' + $('pUpscaleBy').value + ' · denoise ' + $('pDenoise').value + ' · ' + $('pSteps').value + ' steps');
  const out = await submitAndWait(buildUpscalePrompt({
    imageName: inputName,
    prompt: $('pPrompt').value,
    upscaleBy: parseFloat($('pUpscaleBy').value),
    denoise: parseFloat($('pDenoise').value),
    steps: parseInt($('pSteps').value),
    seed: parseInt($('pSeed').value)
  }), upscaleSaveNodeId());

  if(out) showRunResult(out);
  btn.disabled = false;
  updateRunEnabled();
}

// Queue one graph and wait for it, returning its first SaveImage output entry,
// or null if the run failed. Split out of runWorkflow because Sketch to Add
// queues one masked pass per element type, each starting from the previous
// pass's output, so submit-and-poll has to be callable more than once per Run.
async function submitAndWait(prompt, saveImageNodeId){
  log('Sending request to ComfyUI...');
  let promptId;
  try{
    const res = await fetch(baseUrl() + '/prompt', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ prompt, client_id: state.clientId })
    });
    const data = await res.json();
    if(!res.ok){
      let detail = (data.error && (data.error.message || JSON.stringify(data.error))) || ('HTTP '+res.status);
      if(data.node_errors && Object.keys(data.node_errors).length){
        detail += '\n\nError details by node:';
        for(const [nodeId, info] of Object.entries(data.node_errors)){
          detail += '\n\n[node ' + nodeId + '] class_type: ' + (info.class_type || '?');
          (info.errors || []).forEach(e=>{
            detail += '\n  - ' + (e.message || '') + (e.details ? (' | ' + e.details) : '');
          });
        }
      }
      throw new Error(detail);
    }
    promptId = data.prompt_id;
    log('Queued. prompt_id = ' + promptId, 'ok');
  }catch(e){
    log('Request failed: ' + e.message, 'err');
    log('Please try again. Contact support if the problem persists.');
    return null;
  }

  // poll history
  const start = Date.now();
  let result = null, done = false;
  while(!done){
    await new Promise(r=>setTimeout(r, 1500));
    const elapsed = ((Date.now()-start)/1000).toFixed(0);
    try{
      const res = await fetch(baseUrl() + '/history/' + promptId);
      const data = await res.json();
      const entry = data[promptId];
      if(entry){
        if(entry.status && entry.status.completed === true){
          done = true;
          log('Done (' + elapsed + 's)', 'ok');
          const node = entry.outputs[saveImageNodeId];
          if(node && node.images && node.images.length){
            result = node.images[0];
          }else{
            log('No output image found in the SaveImage node — check that the node id matches the actual workflow', 'err');
          }
        }else if(entry.status && entry.status.status_str === 'error'){
          done = true;
          log('ComfyUI reported an error during the run — check the ComfyUI console log', 'err');
        }else{
          log('Processing... (' + elapsed + 's)');
        }
      }else{
        log('Waiting in queue... (' + elapsed + 's)');
      }
    }catch(e){
      log('Status check failed: ' + e.message, 'err');
    }
    if(Date.now()-start > 10*60*1000){ // 10 min timeout
      done = true;
      log('Timed out (over 10 minutes) — the job may still be running, check ComfyUI directly', 'err');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tutorial carousel — original copy + hand-drawn SVG diagrams (not derived
// from any uploaded reference material).
function tutCube(mode){
  if(mode === 'outline'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="50,10 85,28 50,46 15,28" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
      <polygon points="15,28 50,46 50,86 15,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
      <polygon points="85,28 50,46 50,86 85,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    </svg>`;
  }
  if(mode === 'soft'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="50,10 85,28 50,46 15,28" fill="#e7e7e7"/>
      <polygon points="15,28 50,46 50,86 15,68" fill="#bdbdbd"/>
      <polygon points="85,28 50,46 50,86 85,68" fill="#8c8c8c"/>
    </svg>`;
  }
  if(mode === 'messy'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="48,8 78,22 92,50 74,58 80,82 46,92 20,80 8,52 26,40 18,20" fill="#eeeeee" stroke="#171717" stroke-width="2" stroke-linejoin="round"/>
      <line x1="48" y1="8" x2="80" y2="82" stroke="#171717" stroke-width="1.3"/>
      <line x1="8" y1="52" x2="92" y2="50" stroke="#171717" stroke-width="1.3"/>
      <line x1="18" y1="20" x2="74" y2="58" stroke="#171717" stroke-width="1.3"/>
    </svg>`;
  }
  if(mode === 'clean'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <polygon points="50,10 85,28 50,46 15,28" fill="#f2f2f2" stroke="#171717" stroke-width="1.4" stroke-linejoin="round"/>
      <polygon points="15,28 50,46 50,86 15,68" fill="#d8d8d8" stroke="#171717" stroke-width="1.4" stroke-linejoin="round"/>
      <polygon points="85,28 50,46 50,86 85,68" fill="#bcbcbc" stroke="#171717" stroke-width="1.4" stroke-linejoin="round"/>
    </svg>`;
  }
  if(mode === 'flat'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <rect x="14" y="20" width="72" height="60" rx="3" fill="#c9c9c9"/>
    </svg>`;
  }
  if(mode === 'grain'){
    return `<svg viewBox="0 0 100 100" width="92" height="92">
      <rect x="14" y="20" width="72" height="60" rx="3" fill="#d8d3c9"/>
      <path d="M16 32 Q40 28 50 33 T86 30" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
      <path d="M16 46 Q40 42 50 47 T86 44" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
      <path d="M16 60 Q40 56 50 61 T86 58" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
      <path d="M16 74 Q40 70 50 75 T86 72" stroke="#8a7a63" stroke-width="1.3" fill="none"/>
    </svg>`;
  }
  return '';
}

const TUT_SLIDES = [
  {
    title: 'Check these 5 things before uploading',
    body: [
      'Good results start with a good source image. Run through the checklist below once before you upload — it will save you a lot of re-runs later:',
      '<b>1)</b> Set real materials in the model &nbsp; <b>2)</b> Clean up the geometry &nbsp; <b>3)</b> Reduce heavy outlines &nbsp; <b>4)</b> Use a high-resolution source image &nbsp; <b>5)</b> Match the site options to what you want'
    ]
  },
  {
    title: 'Set real materials in the model from the start',
    body: [
      'The system only interprets what actually exists in the image — <b>it doesn&#39;t guess what material you want</b>. If the surfaces in your model are still plain gray or white, the result will look just as flat.',
      'Apply realistic colors and materials (e.g. wood tone, tile color) while modeling, before you export.'
    ],
    compare: { left:'flat', leftLabel:'No material set', right:'grain', rightLabel:'Real material set' }
  },
  {
    title: 'Good geometry = good results',
    body: [
      'The system mainly follows the shape of your existing model. If the model has odd proportions or messy angles, the result tends to inherit those same odd volumes.',
      'Tidy up proportions and clean the geometry before uploading, especially around the focal point of the shot.'
    ],
    compare: { left:'messy', leftLabel:'Messy geometry', right:'clean', rightLabel:'Clean geometry' }
  },
  {
    title: 'Reduce overly thick outlines',
    body: [
      'Heavy contour/profile lines when exporting from SketchUp often make the image read as an illustration or cartoon rather than a real photo.',
      'Turn off or thin out the outlines before uploading — the smoother your source image looks, the more naturally the system will read it as a photograph.'
    ],
    compare: { left:'outline', leftLabel:'Outline too heavy', right:'soft', rightLabel:'No outline' }
  },
  {
    title: 'Use a high-resolution source image',
    body: [
      'A sharp image with enough resolution gives the system more detail to build on.',
      'Avoid blurry images, ones with watermarks, or heavily compressed images with visible blocking — detail that&#39;s already lost can&#39;t be accurately recreated.'
    ]
  },
  {
    title: 'Match the site options to what you want',
    body: [
      'Before you hit Run, check the options on the left — Time of Day, Clouds, Weather, Background, People/Vehicles, Focus Mode (Exterior) or Room Type/Artificial Lighting (Interior) — and set them to match what you want up front.',
      'Getting the settings right from the start saves a lot of re-runs later.'
    ]
  }
];

let tutIndex = 0;
function tutRender(){
  const s = TUT_SLIDES[tutIndex];
  let html = `<h3>${s.title}</h3>` + s.body.map(p=>`<p>${p}</p>`).join('');
  if(s.compare){
    html += `<div class="tut-compare">
      <div class="col">
        <div class="box">${tutCube(s.compare.left)}</div>
        <div class="tag bad">✕ ${s.compare.leftLabel}</div>
      </div>
      <div class="col">
        <div class="box">${tutCube(s.compare.right)}</div>
        <div class="tag good">✓ ${s.compare.rightLabel}</div>
      </div>
    </div>`;
  }
  $('tutBody').innerHTML = html;
  $('tutBadge').textContent = (tutIndex+1) + '/' + TUT_SLIDES.length;
  $('tutPrev').disabled = tutIndex === 0;
  $('tutNext').textContent = tutIndex === TUT_SLIDES.length - 1 ? 'Done ✓' : 'Next →';
  $('tutDots').innerHTML = TUT_SLIDES.map((_,i)=>`<span class="${i===tutIndex?'active':''}" data-i="${i}"></span>`).join('');
  $('tutDots').querySelectorAll('span').forEach(dot=>{
    dot.addEventListener('click', ()=>{ tutIndex = parseInt(dot.dataset.i); tutRender(); });
  });
}
function tutOpen(){ tutIndex = 0; tutRender(); $('tutOverlay').classList.add('open'); }
function tutClose(){ $('tutOverlay').classList.remove('open'); }
$('tutBtn').addEventListener('click', tutOpen);
$('tutClose').addEventListener('click', tutClose);
$('tutOverlay').addEventListener('click', (e)=>{ if(e.target === $('tutOverlay')) tutClose(); });
$('tutPrev').addEventListener('click', ()=>{ if(tutIndex>0){ tutIndex--; tutRender(); } });
$('tutNext').addEventListener('click', ()=>{
  if(tutIndex < TUT_SLIDES.length-1){ tutIndex++; tutRender(); } else { tutClose(); }
});


// ===================== HOME SCRIPT =====================
(function(){

function cubeSVG(mode){
  if(mode === 'outline') return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
  return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#e7e7e7"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#bdbdbd"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#8c8c8c"/>
  </svg>`;
}

// Placeholder examples — swap `before`/`after` for real image URLs once available.
const SHOWCASE = [
  { cat:'Exterior', title:'Weekend house', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'Interior',  title:'Modern living room', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'Exterior', title:'Office building', before: cubeSVG('outline'), after: cubeSVG('soft') }
];

const showcase = document.getElementById('showcase');
SHOWCASE.forEach(p=>{
  const card = document.createElement('div');
  card.className = 'scard';
  card.innerHTML = `
    <div class="cmp">
      <div class="after">${p.after}</div>
      <div class="before-wrap" style="clip-path:inset(0 50% 0 0);">${p.before}</div>
      <div class="cmp-line" style="left:50%;"></div>
      <div class="cmp-dot" style="left:50%;">
        <svg width="16" height="9" viewBox="0 0 20 11" fill="none"><path d="M6 1L1 5.5L6 10M14 1L19 5.5L14 10" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="cmp-label b">Original</div>
      <div class="cmp-label a">Result</div>
    </div>
    <div class="meta">
      <div class="tag">${p.cat}</div>
      <div class="title">${p.title}</div>
    </div>`;
  showcase.appendChild(card);
  initSlider(card.querySelector('.cmp'));
});

function initSlider(el){
  const wrap = el.querySelector('.before-wrap');
  const line = el.querySelector('.cmp-line');
  const dot = el.querySelector('.cmp-dot');
  let dragging = false;
  function setPct(clientX){
    const rect = el.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    wrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    line.style.left = pct + '%';
    dot.style.left = pct + '%';
  }
  el.addEventListener('pointerdown', (e)=>{ dragging = true; setPct(e.clientX); });
  window.addEventListener('pointermove', (e)=>{ if(dragging) setPct(e.clientX); });
  window.addEventListener('pointerup', ()=> dragging = false);
}

})();


// ===================== LOGIN SCRIPT =====================
(function(){

const $ = id => document.getElementById(id);
function showLoading(text){
  $('googleBtn').style.display = 'none';
  $('loginForm').classList.add('hide');
  document.querySelector('.divider').classList.add('hide');
  $('statusText').textContent = text;
  $('status').classList.add('show');
}
function showSuccess(email){
  $('status').classList.remove('show');
  $('formArea').style.display = 'none';
  $('successEmail').textContent = 'Signed in as ' + email;
  $('successView').classList.add('show');
  if(typeof window.appSetLoggedIn === 'function') window.appSetLoggedIn(email);
}
$('googleBtn').addEventListener('click', ()=>{
  showLoading('Connecting to Google...');
  setTimeout(()=> showSuccess('Google Account'), 1400);
});
$('emailBtn').addEventListener('click', ()=>{
  const email = $('email').value.trim() || 'you@studio.com';
  showLoading('Signing in...');
  setTimeout(()=> showSuccess(email), 900);
});

})();


// ===================== UPGRADE SCRIPT =====================
(function(){

const $ = id => document.getElementById(id);
$('tglMonthly').addEventListener('click', ()=> setBilling('m'));
$('tglYearly').addEventListener('click', ()=> setBilling('y'));
function setBilling(mode){
  $('tglMonthly').classList.toggle('active', mode === 'm');
  $('tglYearly').classList.toggle('active', mode === 'y');
  document.querySelectorAll('.pprice[data-m]').forEach(el=>{
    const val = mode === 'm' ? el.dataset.m : el.dataset.y;
    const suffix = mode === 'm' ? '/mo' : '/mo billed yearly';
    el.innerHTML = '฿' + Number(val).toLocaleString() + '<span>' + suffix + '</span>';
  });
}

})();


// ===================== GALLERY SCRIPT =====================
(function(){

function cubeSVG(mode){
  if(mode === 'outline') return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#ffffff" stroke="#171717" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
  return `<svg viewBox="0 0 100 100" width="56%" height="56%">
    <polygon points="50,10 85,28 50,46 15,28" fill="#e7e7e7"/>
    <polygon points="15,28 50,46 50,86 15,68" fill="#bdbdbd"/>
    <polygon points="85,28 50,46 50,86 85,68" fill="#8c8c8c"/>
  </svg>`;
}

// Placeholder project data — replace `before`/`after` with real image URLs when available.
const PROJECTS = [
  { cat:'exterior', title:'Vacation House', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'interior', title:'Modern Living Room', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'exterior', title:'Office Building', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'interior', title:'Minimalist Bedroom', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'exterior', title:'Two-Storey Townhome', before: cubeSVG('outline'), after: cubeSVG('soft') },
  { cat:'interior', title:'Loft-Style Kitchen', before: cubeSVG('outline'), after: cubeSVG('soft') }
];

const grid = document.getElementById('grid');

function render(filter){
  grid.innerHTML = '';
  PROJECTS.filter(p => filter === 'all' || p.cat === filter).forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'gcard';
    card.innerHTML = `
      <div class="gcmp" data-i="${i}">
        <div class="after">${p.after}</div>
        <div class="before-wrap" style="clip-path:inset(0 50% 0 0);">${p.before}</div>
        <div class="gcmp-line" style="left:50%;"></div>
        <div class="gcmp-dot" style="left:50%;">
          <svg width="16" height="9" viewBox="0 0 20 11" fill="none"><path d="M6 1L1 5.5L6 10M14 1L19 5.5L14 10" stroke="#fff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <div class="gcmp-label b">Original</div>
        <div class="gcmp-label a">Result</div>
      </div>
      <div class="meta">
        <div class="tag">${p.cat === 'exterior' ? 'Exterior' : 'Interior'}</div>
        <div class="title">${p.title}</div>
      </div>`;
    grid.appendChild(card);
    initSlider(card.querySelector('.gcmp'));
  });
}

function initSlider(el){
  const wrap = el.querySelector('.before-wrap');
  const line = el.querySelector('.gcmp-line');
  const dot = el.querySelector('.gcmp-dot');
  let dragging = false;

  function setPct(clientX){
    const rect = el.getBoundingClientRect();
    let pct = ((clientX - rect.left) / rect.width) * 100;
    pct = Math.max(0, Math.min(100, pct));
    wrap.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    line.style.left = pct + '%';
    dot.style.left = pct + '%';
  }
  el.addEventListener('pointerdown', (e)=>{ dragging = true; setPct(e.clientX); });
  window.addEventListener('pointermove', (e)=>{ if(dragging) setPct(e.clientX); });
  window.addEventListener('pointerup', ()=> dragging = false);
}

document.querySelectorAll('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    render(tab.dataset.f);
  });
});

render('all');

})();

// ===================== DARK MODE TOGGLE (global) =====================
(function(){
  const btn = document.getElementById('themeToggle');
  const iconMoon = 'M9 1.5V3.3M9 14.7V16.5M16.5 9H14.7M3.3 9H1.5M14.1 3.9L12.8 5.2M5.2 12.8L3.9 14.1M14.1 14.1L12.8 12.8M5.2 5.2L3.9 3.9';
  const iconRays = document.getElementById('themeIcon').querySelector('path');
  const iconCircle = document.getElementById('themeIcon').querySelector('circle');
  btn.addEventListener('click', ()=>{
    const isDark = document.body.classList.toggle('dark');
    const stroke = isDark ? '#f0f0f0' : '#171717';
    iconCircle.setAttribute('stroke', stroke);
    if(isDark){
      // moon icon
      iconRays.setAttribute('d', 'M14.5 10.2A6 6 0 1 1 7.8 3.5A5 5 0 0 0 14.5 10.2Z');
      iconCircle.setAttribute('stroke', 'none');
      iconCircle.setAttribute('fill', stroke);
      iconRays.setAttribute('stroke', 'none');
      iconRays.setAttribute('fill', stroke);
    } else {
      iconRays.setAttribute('d', iconMoon);
      iconRays.setAttribute('fill', 'none');
      iconRays.setAttribute('stroke', stroke);
      iconCircle.setAttribute('fill', 'none');
      iconCircle.setAttribute('stroke', stroke);
    }
  });
})();

