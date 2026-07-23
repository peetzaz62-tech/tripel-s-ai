
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
    "2": { class_type:"UNETLoader", inputs:{ unet_name:"flux1-dev.safetensors", weight_dtype:"default" } },
    "3": { class_type:"DualCLIPLoader", inputs:{ clip_name1:"t5xxl_fp16.safetensors", clip_name2:"clip_l.safetensors", type:"flux", device:"default" } },
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
    "68:12": { class_type:"UNETLoader", inputs:{ unet_name:"flux2-dev.safetensors", weight_dtype:"default" } },
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
// Exterior prompt: assembled from fixed core paragraphs (from the reference
// prompt) + modular paragraphs that change based on the selected category
// (time/weather, clouds, background, people, free-form extra).

const EXT_INTRO = `Turn this architectural 3D render into a real photograph of the exact same building, shot from the exact same camera position with identical framing and perspective. Lighting, sky, and weather follow the "Time of Day", "Clouds", and "Weather" sections below, with every shadow consistent with that light source. The result is a straight photograph — nothing about it may look like CGI, a rendering, or an illustration.`;

const EXT_GEOMETRY = `Preserve exactly, without exception:
- Building geometry: every volume, facade, slab, balcony, and structural element keeps its exact shape, position, and proportion. The camera does not move, zoom, tilt, or reframe.
- Openings: every window and door keeps its exact size, shape, and position. Solid walls stay solid; no new openings appear and none are filled in.
- Ground plan: every ground surface keeps its exact category and boundary — paved roads, driveways, and paths stay paved; grass and planting stay planted; pools and ponds stay water with realistic reflections. Nothing swaps category and nothing new is invented.
Realism is added on top of these surfaces, never by changing what they are.`;

const EXT_MATERIALS = `Materials keep their original colors and tones, upgraded to photographic realism: concrete shows formwork lines and subtle tonal variation; brick and stone show real joints and units; metal cladding shows its profile and correct sheen; glass is genuinely transparent with believable reflections and interior depth; wood shows natural grain; painted and rendered surfaces show faint real texture instead of flat digital color. Every material stays in its own family.`;

const EXT_SITE = `Site elements — roads, paths, fences, poles, streetlights, planters, and everything else already visible in the image — stay exactly in place at correct scale and become photographically real. Grass reads as healthy natural green with realistic blade texture, never yellowed by warm grading; trees and shrubs get natural irregular foliage with no repeating patterns. The scene contains exactly what the source image contains: nothing new is introduced anywhere on the site.`;

const EXT_QUALITY = `Color & Photographic Quality: neutral accurate white balance — whites and greens stay true, with warmth only in direct highlights. A natural documentary architectural photograph: subtle sensor grain, believable reflections and contact shadows, gentle atmospheric depth. No HDR look, oversaturation, or artificial sharpening.`;

function extTimeParagraph(time){
  const map = {
    morning: `Time of Day — Morning: low sun near the horizon, long soft-edged shadows, warm light on sunlit surfaces and a cool tint in the shade, with shadow detail kept visible. No lens flare, god rays, or HDR grading.`,
    noon: `Time of Day — Midday: bright clear daylight from a high sun, well-defined but soft-edged shadows that keep visible detail and a slightly cool tint, warm bright sunlit areas. No lens flare, god rays, or HDR grading.`,
    evening: `Time of Day — Evening: golden-hour sun low on the horizon, long soft shadows, warm amber light on lit surfaces while shade stays cool and detailed; building lights may glow softly. No harsh contrast or HDR grading.`,
    night: `Time of Day — Night: the scene is lit by the building's own interior and exterior lights, glowing warm and casting realistic pools of light, with faint ambient moonlight keeping unlit areas readable. No invented external light sources.`
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
      : `Clouds: a soft uniform overcast layer diffusing the light evenly.`
  };
  return map[clouds] || map.thin;
}

function extWeatherParagraph(weather){
  if(weather === 'rain') return `Weather — Rain: soft diffused directionless light, wet sheen and reflections on paved and hard surfaces, fine rain streaks and light ground mist, cool slightly desaturated tones.`;
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

function extCarsParagraph(cars){
  if(cars === 'yes') return `Vehicles: one or two realistic vehicles in plausible spots (driveway, street, or parking area), correctly scaled and lit, secondary to the building.`;
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

  const parts = [
    EXT_INTRO,
    EXT_GEOMETRY,
    extViewParagraph(view),
    EXT_MATERIALS,
    EXT_SITE,
    extBackgroundParagraph(background),
    extTimeParagraph(time),
    extCloudsParagraph(clouds, time),
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

  const parts = [
    SEMI_INTRO,
    EXT_GEOMETRY,
    extViewParagraph(view),
    EXT_MATERIALS,
    EXT_SITE,
    extBackgroundParagraph(background),
    extTimeParagraph(time),
    extCloudsParagraph(clouds, time),
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
// Interior
const INT_CORE = [
`Turn this interior 3D render into a real photograph of the exact same room, shot from the exact same camera position with identical framing and perspective. The result is a straight photograph — nothing may look like CGI, a rendering, or an illustration.`,
`Preserve exactly: every wall, ceiling, column, window, door, furniture piece, and fixture in its exact position, size, and proportion. Materials keep their original colors and tones, upgraded to photographic realism — flooring with true grain, joints, and subtle wear; fabrics with real weave and natural folds; painted walls with faint real texture; metal and glass with physically accurate reflections.`,
`Color & Photographic Quality: neutral white balance, true-to-source colors, subtle sensor grain, believable contact shadows and reflections. No HDR look, oversaturation, or artificial sharpening.`
].join('\n\n');

function intRoomParagraph(room){
  const map = {
    bedroom: `Room — Bedroom: distinguish soft materials correctly as modeled — leather with natural grain and a soft satin sheen, velvet with a directional light-catching nap, woven fabric with visible weave, fur or sheepskin with individual soft strands. Bedding has real weight and natural folds; wood shows soft natural grain. Calm, tidy, lived-in feel.`,
    living: `Room — Living Room: distinguish soft materials correctly as modeled — leather with natural grain, subtle creasing, and a satin sheen; velvet with a directional light-catching nap; woven fabric with visible weave; rugs with real pile texture. Wood furniture shows natural grain and subtle wear. Open, welcoming feel.`,
    kitchen: `Room — Kitchen: countertops with authentic veining and subtle reflections, cabinetry with real wood grain or painted texture and believable hardware, appliances with accurate brushed-metal reflections. Clean but lived-in, not sterile.`,
    bathroom: `Room — Bathroom: tile and stone with real grout lines and subtle sheen, keeping every tile's exact color and pattern; glass and mirrors clean, dry, and accurately reflective; fixtures with physically correct specular highlights. No added props, towels, or accessories.`
  };
  return map[room] || map.living;
}

function intLightingParagraph(lighting){
  if(lighting === 'on') return `Artificial Lighting — On: the fixtures already modeled in the image glow a gentle warm-white (real LED warmth, not orange), light spreading and falling off naturally in soft pools, blended believably with existing daylight without blown highlights. No invented fixtures; no cove or hidden lighting unless modeled or requested.`;
  return `Artificial Lighting — Off: all fixtures stay off; the room is lit only by soft diffused daylight with a faint natural warmth. Shadows are pale and soft-edged with gentle ambient occlusion in corners and under furniture — bright, airy, and clear. No off-camera light sources, sun rays, or light beams.`;
}

function intFocusParagraph(focus){
  if(focus === 'shallow') return `Focus: shallow depth of field — the main furniture grouping critically sharp, immediate foreground and far background in smooth optical blur.`;
  return `Focus: deep depth of field — the whole room sharp from front to back, no blur or bokeh anywhere.`;
}

function buildInteriorPromptP(p = {}){
  const room = p.room || 'living';
  const lighting = p.lighting || 'off';
  const focus = p.intFocus || 'deep';
  const extra = String(p.intExtra || '').trim();

  const extras = [intRoomParagraph(room), intLightingParagraph(lighting), intFocusParagraph(focus)];
  if(extra) extras.push(`Additional Instructions:\n${extra}`);

  return INT_CORE + '\n\n' + extras.join('\n\n')
    + '\n\nFinal check: an ultra-detailed high-resolution photograph in which every wall, opening, furniture piece, and material color matches the source image exactly, and the frame contains no figure, object, or element that was absent from the source image.';
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
    room: $('sIntRoom').value, lighting: $('sIntLighting').value,
    intFocus: $('sIntFocus').value, intExtra: $('sIntExtra').value
  });
}

function updatePeopleDescVisibility(){
  $('sExtPeopleDescWrap').style.display = $('sExtPeople').value === 'yes' ? '' : 'none';
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
['sExtTime','sExtClouds','sExtWeather','sExtBackground','sExtView','sExtPeople','sExtPeopleDesc','sExtCars','sExtFocus','sExtExtra'].forEach(id=>{
  $(id).addEventListener('input', refreshExtPrompt);
});
['sIntRoom','sIntLighting','sIntFocus','sIntExtra'].forEach(id=>{
  $(id).addEventListener('input', ()=>{
    if($('sPromptType').value === 'interior') hiddenPromptCache = buildInteriorPrompt();
  });
});
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
  });
});

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

