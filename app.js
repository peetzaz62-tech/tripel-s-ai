
function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  var el = document.getElementById('view-'+name);
  if(el) el.classList.add('active');
  window.scrollTo(0,0);
}


// ===================== APP SCRIPT =====================

// ---------------------------------------------------------------------------
// API-format prompt template for "Magnific Fast" (reconstructed from the
// workflow JSON: LoadImage -> UltimateSDUpscale(RealESRGAN_x4plus + Flux refine)
// -> SaveImage). Node ids match the original graph.
// ---------------------------------------------------------------------------
function buildMagnificPrompt(opts){
  return {
    "1": { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    "2": { class_type:"UNETLoader", inputs:{ unet_name:"flux1-dev-fp8.safetensors", weight_dtype:"default" } },
    "3": { class_type:"DualCLIPLoader", inputs:{ clip_name1:"t5xxl_fp8_e4m3fn.safetensors", clip_name2:"clip_l.safetensors", type:"flux", device:"default" } },
    "4": { class_type:"VAELoader", inputs:{ vae_name:"ae.safetensors" } },
    "5": { class_type:"UpscaleModelLoader", inputs:{ model_name:"RealESRGAN_x4plus.pth" } },
    "6": { class_type:"CLIPTextEncode", inputs:{ text: opts.prompt || "", clip:["3",0] } },
    "7": { class_type:"FluxGuidance", inputs:{ conditioning:["6",0], guidance:3.5 } },
    "8": { class_type:"UltimateSDUpscale", inputs:{
        image:["1",0], model:["2",0], positive:["7",0], negative:["7",0], vae:["4",0], upscale_model:["5",0],
        upscale_by: opts.upscaleBy, seed: opts.seed, steps: opts.steps, cfg: opts.cfg,
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
// API-format prompt template for "SSS · Skp to Render" — Flux.2 Dev image-edit.
// Rebuilt directly from the API-format JSON the user provided (node ids kept
// identical, e.g. "68:6", "68:12" ...). Dead/unused branches from the original
// export (LoadImageListFromDir, the disconnected ImageUpscaleWithModel, and
// the ImageCompare preview) are omitted since they don't feed the SaveImage
// output and would otherwise fail validation (missing required inputs).
// ---------------------------------------------------------------------------
function buildSSSPrompt(opts){
  return {
    "125": { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    // The exported workflow wires node 45 to the PreviewImage node (124), but
    // PreviewImage is an output node with no output slot, so ComfyUI rejects the
    // graph. Read the image straight from LoadImage and drop the preview node.
    "45":  { class_type:"ImageScaleToTotalPixels", inputs:{ upscale_method:"lanczos", megapixels: opts.megapixels, resolution_steps:1, image:["125",0] } },

    "68:38": { class_type:"CLIPLoader", inputs:{ clip_name:"mistral_3_small_flux2_bf16.safetensors", type:"flux2", device:"default" } },
    "68:12": { class_type:"UNETLoader", inputs:{ unet_name:"flux2_dev_fp8mixed.safetensors", weight_dtype:"default" } },
    "68:10": { class_type:"VAELoader", inputs:{ vae_name:"full_encoder_small_decoder.safetensors" } },
    "68:89": { class_type:"LoraLoaderModelOnly", inputs:{ lora_name:"Flux_2-Turbo-LoRA_comfyui.safetensors", strength_model:1, model:["68:12",0] } },

    "68:94": { class_type:"PrimitiveBoolean", inputs:{ value: opts.turbo } },
    "68:92": { class_type:"ComfySwitchNode", inputs:{ switch:["68:94",0], on_false:["68:12",0], on_true:["68:89",0] } },
    "68:90": { class_type:"PrimitiveInt", inputs:{ value:8 } },
    "68:91": { class_type:"PrimitiveInt", inputs:{ value:20 } },
    "68:93": { class_type:"ComfySwitchNode", inputs:{ switch:["68:94",0], on_false:["68:91",0], on_true:["68:90",0] } },

    "68:6":  { class_type:"CLIPTextEncode", inputs:{ text: opts.prompt, clip:["68:38",0] } },
    "68:26": { class_type:"FluxGuidance", inputs:{ guidance: opts.guidance, conditioning:["68:6",0] } },

    "68:44": { class_type:"VAEEncode", inputs:{ pixels:["45",0], vae:["68:10",0] } },
    "68:43": { class_type:"ReferenceLatent", inputs:{ conditioning:["68:26",0], latent:["68:44",0] } },
    "68:72": { class_type:"GetImageSize", inputs:{ image:["45",0] } },
    "68:47": { class_type:"EmptyFlux2LatentImage", inputs:{ width:["68:72",0], height:["68:72",1], batch_size:1 } },
    "68:48": { class_type:"Flux2Scheduler", inputs:{ steps:["68:93",0], width:["68:72",0], height:["68:72",1] } },

    "68:25": { class_type:"RandomNoise", inputs:{ noise_seed: opts.seed } },
    "68:16": { class_type:"KSamplerSelect", inputs:{ sampler_name:"euler" } },
    "68:22": { class_type:"BasicGuider", inputs:{ model:["68:92",0], conditioning:["68:43",0] } },
    "68:13": { class_type:"SamplerCustomAdvanced", inputs:{ noise:["68:25",0], guider:["68:22",0], sampler:["68:16",0], sigmas:["68:48",0], latent_image:["68:47",0] } },
    "68:8":  { class_type:"VAEDecode", inputs:{ samples:["68:13",0], vae:["68:10",0] } },

    "9": { class_type:"SaveImage", inputs:{ images:["68:8",0], filename_prefix:"SSS" } }
  };
}
const SAVE_IMAGE_NODE_ID_SSS = "9";

// ---------------------------------------------------------------------------
let state = { workflow:"magnific", uploadedName:null, origPreviewURL:null, connected:false, clientId: crypto.randomUUID() };

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
- Ground plan: every ground surface keeps its exact category and boundary — paved roads, driveways, and paths stay paved; timber decks and terraces stay timber decking; grass and planting stay planted; pools and ponds stay water with realistic reflections. Nothing swaps category and nothing new is invented.
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
function extDiffuseTimeParagraph(time){
  const map = {
    morning: `Time of Day — Morning under a closed sky: early daylight with the sun hidden behind cloud, arriving evenly from the whole sky. There is no direct sun anywhere in the scene — nothing casts a shadow onto the ground or across a wall, and the only shading is the gentle ambient occlusion where surfaces meet. Low contrast, cool and clear.`,
    noon: `Time of Day — Midday under a closed sky: bright but completely diffused daylight with the sun hidden behind cloud, arriving evenly from the whole sky. There is no direct sun anywhere in the scene — nothing casts a shadow onto the ground or across a wall, and the only shading is the gentle ambient occlusion where surfaces meet. Low contrast and evenly lit.`,
    afternoon: `Time of Day — Afternoon under a closed sky: full daylight with the sun hidden behind cloud, arriving evenly from the whole sky. There is no direct sun anywhere in the scene — nothing casts a shadow onto the ground or across a wall, and the only shading is the gentle ambient occlusion where surfaces meet. Low contrast and evenly lit.`,
    evening: `Time of Day — Evening under a closed sky: the last of the daylight with the sun already lost behind cloud, dimmer and cooler than midday and flat across the whole scene. There is no direct sun and nothing casts a shadow; building lights may glow softly. Nothing turns golden.`
  };
  return (map[time] || map.noon) + NEUTRAL_WB;
}

function extTimeParagraph(time){
  const map = {
    morning: `Time of Day — Morning: low sun near the horizon casting long soft-edged shadows, the light clear and only faintly warm rather than golden, with a cool tint in the shade and shadow detail kept visible. No lens flare, god rays, or HDR grading.` + NEUTRAL_WB,
    noon: `Time of Day — Midday: bright clear daylight from a high sun, well-defined but soft-edged shadows that keep visible detail. The daylight is neutral and very slightly cool, exactly as a camera set to daylight white balance records it. No lens flare, god rays, or HDR grading.` + NEUTRAL_WB,

    // Afternoon is defined by the sun's ANGLE, not its colour. Said any other
    // way the model reaches for golden hour, which is the cast this whole
    // section exists to remove.
    afternoon: `Time of Day — Afternoon: the sun has moved past its highest point but is still well up in the sky, throwing clearly directional shadows of moderate length rather than the long rakes of evening. The light stays bright and clear and its colour is the same neutral daylight as midday — this is afternoon by the angle of the sun, not by any warming of the light, so nothing in the frame turns golden. No lens flare, god rays, or HDR grading.` + NEUTRAL_WB,
    // Golden hour is genuinely warm, so the amber stays — but confined to the
    // faces the sun actually reaches, with shade and whites held neutral.
    evening: `Time of Day — Evening: sun low on the horizon, long soft shadows, the light warmer than midday but still clean — a gentle amber on the surfaces it directly strikes, while shade stays cool and neutral and white surfaces never turn yellow. Building lights may glow softly. No harsh contrast or HDR grading.`,
    night: `Time of Day — Night: the scene is lit by the building's own interior and exterior lights, glowing warm and casting realistic pools of light, with faint ambient moonlight keeping unlit areas readable. Away from those pools the night stays cool and neutral, not tinted amber. No invented external light sources.`
  };
  return map[time] || map.noon;
}

function extCloudsParagraph(clouds, time){
  const night = time === 'night';
  const map = {
    none: night
      ? `Clouds: a clear night sky with visible stars and soft moonlight.`
      : `Clouds: a clear cloudless sky with a natural daylight gradient.`,
    thin: night
      ? `Clouds: thin wispy clouds catching faint moonlight, stars visible between them.`
      : `Clouds: a few thin wispy semi-transparent clouds of varied size — never a flat repeated pattern.`,
    thick: night
      ? `Clouds: drifting clouds partially veiling the moon, stars in the breaks.`
      : `Clouds: scattered cumulus clouds with real volume, soft-lit tops and gently shaded undersides — never a flat repeated pattern.`,
    overcast: night
      ? `Clouds: heavy overcast hiding moon and stars, faint ambient glow only.`
      : `Clouds: a soft uniform overcast layer diffusing the light evenly.`,

    // Rain gets its own sky rather than borrowing "overcast", which is a bright
    // even white layer — too light to read as weather you would take an
    // umbrella for.
    rain: night
      ? `Clouds: a heavy rain sky with moon and stars completely hidden, only the dim glow of distant city light on the cloud base.`
      : `Clouds: a heavy, low, rain-bearing sky — thick grey cloud with real depth and darker bellies, covering the frame from edge to edge with no break and no patch of blue anywhere. The daylight coming through it is dim and even.`
  };
  return map[clouds] || map.thin;
}

function extWeatherParagraph(weather){
if(weather === 'rain') return `Weather — Rain: the whole scene sits under a dim, gloomy, heavily overcast light with no sunshine anywhere in it. Wet sheen and standing reflections on paved and hard surfaces, fine rain streaks through the air and light ground mist, cool and slightly desaturated throughout.`;
  if(weather === 'snow') return `Weather — Snow: a light natural layer of snow on existing horizontal surfaces only, soft diffused light, low contrast, pale cool grading. Geometry unchanged.`;
  return ''; // clear
}

function extBackgroundParagraph(bg){
  if(bg === 'low') return `Background & Horizon: distant low-rise buildings (one to three storeys), all clearly lower than the main building and never competing with its silhouette, rendered with atmospheric perspective (softer, lower contrast, hazier with distance). No towers or landmarks.`;
  if(bg === 'high') return `Background & Horizon: a distant generic high-rise skyline softened by atmospheric haze, reading as background depth behind the main building, never overpowering it.`;
  return `Background & Horizon: soften the horizon with distant trees and shrubs consistent with the setting, rendered with atmospheric perspective (softer, lower contrast, slightly hazy with distance). No large new buildings or landmarks.`;
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
  const time = p.time || 'noon';
  const clouds = p.clouds || 'thin';
  const weather = p.weather || 'clear';
  const background = p.background || 'trees';
  const view = p.view || 'normal';
  const people = p.people || 'no';
  const peopleDesc = String(p.peopleDesc || '').trim();
  const cars = p.cars || 'no';
  const focus = p.focus || 'deep';
  const extra = String(p.extra || '').trim();

  const closedSky = weather === 'rain' || clouds === 'overcast';

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
    extCloudsParagraph(weather === 'rain' ? 'rain' : clouds, time),
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
  const time = p.time || 'noon';
  const clouds = p.clouds || 'thin';
  const weather = p.weather || 'clear';
  const background = p.background || 'trees';
  const view = p.view || 'normal';
  const people = p.people || 'no';
  const peopleDesc = String(p.peopleDesc || '').trim();
  const cars = p.cars || 'no';
  const focus = p.focus || 'deep';
  const extra = String(p.extra || '').trim();

  const closedSky = weather === 'rain' || clouds === 'overcast';

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
    extCloudsParagraph(weather === 'rain' ? 'rain' : clouds, time),
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

// Daylight arrives as a large diffused source, never as a beam. Direct sun
// throwing hard-edged patches and window-frame shadow bands across the floor
// reads as harsh and CG-like.
const NO_HARD_SUN = ` The daylight arrives as a broad, diffused glow through the glazing rather than as a direct beam: there are no hard-edged shafts of sunlight, no bright sun patches and no window-frame shadow patterns striped across the floor, walls or furniture. Shadows stay soft and open.`;

// Two failures this fixes, both seen in testing:
// 1. A turntable's clear acrylic dust cover was read as a window and the model
//    invented a shaft of light blazing off it onto the wall.
// 2. Windows came back as flat white voids.
const NO_PHANTOM_SOURCE = ` Light enters only through the openings that already exist in the source image. Every solid wall and panel in the source stays solid and unbroken: no new window, glass panel or skylight appears anywhere, and no existing opening changes its size, shape or position. No new lamp or glowing panel is invented, and no object, screen, glass cover or reflective surface is turned into a light source or mistaken for an opening.`;

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
  // For sources modelled with no backdrop at all. Names sky explicitly so the
  // blank window has something definite to be, without opening the door to
  // invented scenery the way a named landscape does.
  sky: `plain open sky with a soft natural gradient and gentle haze, carrying no building, tree, landscape or horizon detail of any kind`,
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

function intViewOutsideParagraph(bg, mode){
  const content = INT_VIEW_CONTENT[bg];
  if(!content) return INT_VIEW_KEEP; // auto, or an unknown value
  const band = mode === 'night' ? 'night' : (mode === 'evening' ? 'evening' : 'day');
  return ` Where the source image already shows glazing with something visible through it, what is seen through that glazing reads as ${content}, ${INT_VIEW_EXPOSURE[band]}.` + INT_VIEW_GUARD;
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
  white: `Lighting: the room's fixtures are switched on and emit a clean neutral-white light, the crisp daylight-balanced white of modern LED, blending with abundant soft daylight from the window. Neutral white balance throughout, white surfaces read as pure white with no colour cast, and every surface keeps its own lightness. Bright, clear and even.`,

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

function intLightingParagraph(mode, fixtures, bg, closeup){
  const m = INT_LIGHT_ON[mode] ? mode : 'white';
  const base = (fixtures === 'off' ? INT_LIGHT_OFF : INT_LIGHT_ON)[m];
  // Only the two daylight modes can produce a hard sun shaft worth banning.
  const sun = (m === 'white' || m === 'warm') ? NO_HARD_SUN : '';
  // A close-up frame often contains no glazing at all, so asking for a view
  // through it invites one to be drawn.
  return base + sun + NO_PHANTOM_SOURCE + (closeup ? '' : intViewOutsideParagraph(bg, m));
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
  const focus = p.intFocus || 'deep';
  const people = p.intPeople || 'no';
  const extra = String(p.intExtra || '').trim();

  const core = closeup
    ? [INT_CAMERA_CLOSEUP, INT_FIDELITY, INT_CLOSEUP_DETAIL, INT_LIGHT_PHYSICS, INT_PHOTO_QUALITY].join('\n\n')
    : INT_CORE;

  const parts = [
    core,
    intLightingParagraph(mode, fixtures, bg, closeup),
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
    cars: $('sExtCars').value, focus: $('sExtFocus').value, extra: $('sExtExtra').value
  };
}
function buildExteriorPrompt(){ return buildExteriorPromptP(readExtParams()); }
function buildSemiOutdoorPrompt(){ return buildSemiOutdoorPromptP(readExtParams()); }
function buildInteriorPrompt(){
  return buildInteriorPromptP({
    intLight: $('sIntLight').value, intShot: $('sIntShot').value,
    intFixtures: $('sIntFixtures').value, intBg: $('sIntBg').value,
    intFocus: $('sIntFocus').value, intPeople: $('sIntPeople').value,
    intExtra: $('sIntExtra').value
  });
}

function updatePeopleDescVisibility(){
  $('sExtPeopleDescWrap').style.display = $('sExtPeople').value !== 'no' ? '' : 'none';
}

let hiddenPromptCache = '';
const PROMPT_MASK = '🔒 Prompt generated and ready to use — hidden to protect this preset.\nSwitch "Image Type" to Custom if you want to write and view your own prompt.';

function applyPromptType(){
  const type = $('sPromptType').value;
  updatePeopleDescVisibility();
  if(type === 'exterior'){
    $('sExtControls').style.display = '';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = buildExteriorPrompt();
    $('sPrompt').value = PROMPT_MASK;
    $('sGuidance').value = '4';
  } else if(type === 'semiOutdoor'){
    $('sExtControls').style.display = '';
    $('sIntControls').style.display = 'none';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = buildSemiOutdoorPrompt();
    $('sPrompt').value = PROMPT_MASK;
    $('sGuidance').value = '4';
  } else if(type === 'interior'){
    $('sExtControls').style.display = 'none';
    $('sIntControls').style.display = '';
    $('sPrompt').readOnly = true;
    hiddenPromptCache = buildInteriorPrompt();
    $('sPrompt').value = PROMPT_MASK;
    // Interior was validated at 3.5, exterior at 4 — the two prompt sets differ
    // enough that one guidance value does not suit both. Still editable after.
    $('sGuidance').value = '3.5';
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
['sExtTime','sExtClouds','sExtWeather','sExtBackground','sExtView','sExtPeople','sExtPeopleDesc','sExtCars','sExtFocus','sExtExtra'].forEach(id=>{
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
['sIntLight','sIntShot','sIntFixtures','sIntBg','sIntFocus','sIntPeople','sIntExtra'].forEach(id=>{
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

// workflow selection
document.querySelectorAll('.wf-opt').forEach(el=>{
  el.addEventListener('click', ()=>{
    if(el.classList.contains('disabled')) return;
    document.querySelectorAll('.wf-opt').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
    state.workflow = el.dataset.wf;
    $('paramsCardMagnific').style.display = state.workflow === 'magnific' ? '' : 'none';
    $('paramsCardSSS').style.display = state.workflow === 'sss' ? '' : 'none';
    $('paramsCardPeople').style.display = state.workflow === 'people' ? '' : 'none';
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
  $('previewImg').src = url;
  $('previewBox').style.display = 'block';
  showBeforeOnly(url);

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

function updateRunEnabled(){
  btnRun.disabled = !(state.connected && state.uploadedName);
}

$('btnRandSeedMagnific').addEventListener('click', ()=>{
  $('pSeed').value = Math.floor(Math.random()*1_000_000_000);
});
$('btnRandSeedSSS').addEventListener('click', ()=>{
  $('sSeed').value = Math.floor(Math.random()*1_000_000_000);
});
$('btnRandSeedPeople').addEventListener('click', ()=>{
  $('apSeed').value = Math.floor(Math.random()*1_000_000_000);
});

btnRun.addEventListener('click', runWorkflow);

async function runWorkflow(){
  btnRun.disabled = true;
  $('actionsBottom').style.display = 'none';
  if(state.origPreviewURL) showBeforeOnly(state.origPreviewURL);
  clearLog();

  let prompt, saveImageNodeId;
  if(state.workflow === 'sss'){
    const opts = {
      imageName: state.uploadedName,
      prompt: $('sPromptType').value === 'custom' ? $('sPrompt').value : hiddenPromptCache,
      turbo: $('sTurbo').value === 'true',
      guidance: parseFloat($('sGuidance').value),
      megapixels: parseFloat($('sMegapixels').value),
      seed: parseInt($('sSeed').value)
    };
    prompt = buildSSSPrompt(opts);
    saveImageNodeId = SAVE_IMAGE_NODE_ID_SSS;
  }else if(state.workflow === 'people'){
    // Same graph as Sketchup-to-Render. The mode differs only in the text it
    // sends: see buildAddPeoplePromptP for why a shorter prompt is the whole
    // mechanism and no img2img pass is involved.
    prompt = buildSSSPrompt({
      imageName: state.uploadedName,
      prompt: buildAddPeoplePromptP({
        pose: $('apPose').value, count: parseInt($('apCount').value), desc: $('apDesc').value
      }),
      turbo: $('apTurbo').value === 'true',
      guidance: parseFloat($('apGuidance').value),
      megapixels: parseFloat($('apMegapixels').value),
      seed: parseInt($('apSeed').value)
    });
    saveImageNodeId = SAVE_IMAGE_NODE_ID_SSS;
  }else{
    const opts = {
      imageName: state.uploadedName,
      prompt: $('pPrompt').value,
      upscaleBy: parseFloat($('pUpscaleBy').value),
      denoise: parseFloat($('pDenoise').value),
      steps: parseInt($('pSteps').value),
      cfg: parseFloat($('pCfg').value),
      seed: parseInt($('pSeed').value)
    };
    prompt = buildMagnificPrompt(opts);
    saveImageNodeId = SAVE_IMAGE_NODE_ID_MAGNIFIC;
  }

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
    btnRun.disabled = false;
    return;
  }

  // poll history
  const start = Date.now();
  let done = false;
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
          const outputs = entry.outputs;
          const node = outputs[saveImageNodeId];
          if(node && node.images && node.images.length){
            const img = node.images[0];
            const viewUrl = baseUrl() + '/view?filename=' + encodeURIComponent(img.filename)
              + '&subfolder=' + encodeURIComponent(img.subfolder || '')
              + '&type=' + encodeURIComponent(img.type || 'output');
            showCompare(state.origPreviewURL, viewUrl);
            $('dlLink').href = viewUrl;
            $('dlLink').download = img.filename;
            $('actionsBottom').style.display = 'flex';
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
  btnRun.disabled = false;
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

