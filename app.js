
function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  var el = document.getElementById('view-'+name);
  if(el) el.classList.add('active');
  window.scrollTo(0,0);
}


// ===================== APP SCRIPT =====================

// ---------------------------------------------------------------------------
// API-format prompt template for "Magnific Fast" (reconstructed from the
// workflow JSON: LoadImage -> UltimateSDUpscale(4x-UltraSharp + Flux refine)
// -> SaveImage). Node ids match the original graph.
// ---------------------------------------------------------------------------
function buildMagnificPrompt(opts){
  return {
    "1": { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    "2": { class_type:"UNETLoader", inputs:{ unet_name:"flux1-dev-fp8.safetensors", weight_dtype:"default" } },
    "3": { class_type:"DualCLIPLoader", inputs:{ clip_name1:"t5xxl_fp8_e4m3fn.safetensors", clip_name2:"clip_l.safetensors", type:"flux", device:"default" } },
    "4": { class_type:"VAELoader", inputs:{ vae_name:"ae.safetensors" } },
    "5": { class_type:"UpscaleModelLoader", inputs:{ model_name:"4x-UltraSharp.pth" } },
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
    "124": { class_type:"PreviewImage", inputs:{ images:["125",0] } },
    "45":  { class_type:"ImageScaleToTotalPixels", inputs:{ upscale_method:"lanczos", megapixels: opts.megapixels, resolution_steps:1, image:["124",0] } },

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
// Exterior prompt: assembled from fixed core paragraphs (from the reference
// prompt) + modular paragraphs that change based on the selected category
// (time/weather, clouds, background, people, free-form extra).
const EXT_INTRO = `You are a professional architectural photographer. Transform this SketchUp model into a real-world architectural photograph captured with a full-frame camera and a premium architectural lens. The exact lighting condition, time of day, and weather are specified later in this brief in the "Time of Day", "Clouds", and "Weather" sections — follow those precisely rather than assuming daytime, and make sure the direction, color, and softness of every shadow and light source is fully consistent with the sky and light source described there (e.g. a night sky must never be paired with hard, sun-cast daytime shadows).

This is a photography task, not a rendering task. The result must be indistinguishable from a real photograph and must never resemble CGI, 3D visualization, illustration, or digitally generated imagery.`;

const EXT_GEOMETRY = `Geometry & Camera:
Preserve the architecture exactly as modeled. Do not modify, redesign, relocate, remove, invent, replace, distort, or reinterpret any building volume, façade, structure, slab, balcony, landscaping, or spatial relationship. Maintain the exact camera position, height, perspective, framing, field of view, and composition — do not crop, zoom, rotate, tilt, or reframe.

Do not change the solid-versus-opening pattern of any surface. Every wall, panel, or cladding section that is solid and opaque in the original image must remain solid and opaque — never convert it into a window, door, glass opening, or any other void. Likewise, every window, door, or opening in the original image must stay exactly the same size, shape, and position — never filled in, resized, or converted into a solid wall. Do not add new openings, windows, doors, or joints that do not exist in the original image, and do not remove or merge any that do exist. Material realism must be applied strictly on top of the existing surface type, never by changing what that surface fundamentally is.

Ground-plane surface lock: every ground surface keeps the exact category it has in the original image, with the same shape, edges, and boundary — this substitution is never allowed in either direction. A road, driveway, footpath, or any other paved surface — including one directly in front of the building — must remain paved and must never be replaced with grass, lawn, or planting. Likewise, an area that is grass or planting in the original image must never be paved over. A swimming pool, pond, or other water feature must remain a body of water — rendered with realistic water color, transparency, and correct reflections of its surroundings — and must never be replaced with grass or a paved surface, and must never be invented where one doesn't already exist. Do not blur, merge, or feather the boundary between paved, planted, and water areas beyond what already exists in the source image.`;

const EXT_MATERIALS = `Materials:
Render every material exactly as modeled, keeping its original color and tone unchanged — never reinterpret, shift, or recolor a material — but with full photographic realism: authentic texture, subtle imperfections, and believable construction tolerances specific to each material type.

Concrete and masonry: exposed concrete shows real formwork lines, subtle pitting, and tonal variation; brick and block show individual units, mortar joints, and natural color variation; precast concrete panels show joint lines and panel seams.

Metal: corrugated or standing-seam metal sheet roofing/cladding shows real ribbing, subtle oil-canning, and correct specular reflection along its profile direction; structural steel (I-beams, trusses, columns) shows real paint or galvanized finish with appropriate sheen; aluminum composite panel (ACP) cladding shows flat, crisp panel joints and a consistent factory-finish sheen.

Glass and glazing: curtain wall and window glass show real transparency, interior depth, and environment reflection consistent with the time of day; low-iron or tinted glass keeps its correct color cast; polycarbonate panels show a translucent, diffused-light quality rather than clear transparency.

Wood: timber cladding, decking, and louvers show natural grain, board-to-board tonal variation, and weathering appropriate to the wood species and finish already implied by the model.

Stone and tile: natural stone and tile show authentic joints, grout lines, and surface irregularities, keeping the exact piece size and layout already modeled — add realism on top of the existing pattern rather than a different stone/tile arrangement.

Fabric and membrane: tensile membrane or fabric shade structures show realistic fabric tension, subtle wrinkling, and translucency with light passing through where appropriate.

Render finishes: stucco, plaster, or painted render surfaces show slight texture and tonal variation rather than flat digital color.

Avoid flat, plastic, or uniformly clean CGI-looking surfaces on any material; textures must never look painterly or repetitive. Never substitute one material family for another (e.g. do not turn wood into plastic or stone into brick).`;

const EXT_SITE = `Site & Landscape:
Render every non-building element already present in the original image with full photographic realism, exactly as positioned and shaped in the model — do not remove, relocate, resize, or invent any of them.

Vegetation (apply ONLY to areas that are already vegetation/landscaping in the original image): do not add, extend, or invent any grass, plants, or landscaping in areas that are not already vegetation. Render grass and lawn as a healthy, natural green — a mix of mid-green and slightly darker shaded green, realistic blade density, only subtle warm highlights where direct sun hits — never yellow, golden, straw-colored, or shifted by an overall warm cast, with soft natural shadow transitions and no repeating tile-like texture. Avoid all AI-generated vegetation artifacts: no repeating leaf patterns, no overly smooth or glossy foliage, no perfectly round tree crowns.

Paving and roads: roads, driveways, parking areas, and footpaths/sidewalks — including any directly in front of the building — keep their real paving material (asphalt, concrete, pavers, or gravel) with authentic surface texture, joints, and subtle wear, and the same edges/boundaries as the original image; keep any lane markings, curbs, or paving patterns already implied by the model.

Water features: swimming pools, ponds, and fountains are rendered per the ground-plane surface lock above — realistic water color and clarity, correct reflections, coping/tile edge detail, and (for pools) accurate waterline tile if visible. These appear ONLY where already present in the original image — never add one where it doesn't already exist.

Site furniture and infrastructure: utility/electrical poles, streetlights, signage, fences, gates, railings, retaining walls, planters, benches, and bollards already present in the model are rendered with real material texture and correct scale — do not add new ones that are not implied by the original image, and do not remove ones that are.

Vehicles already in the model: any car, motorcycle, or other vehicle already present in the original image is kept in place and rendered as a real, correctly proportioned vehicle with accurate paint reflection and glass — never simplified into a generic blob or removed.

Do not convert any site element (paving, water, furniture, vehicles) into vegetation, and do not convert vegetation into any of the above — every element keeps the category it already has in the original image.`;

const EXT_COLOR = `Color Balance:
Keep overall color grading neutral and accurate — do not let warm sunlight shift the whole image toward yellow or orange. Whites and greens must stay true to their real color; only direct highlights should carry a slight warm tint, while shaded and green areas remain color-accurate. No cyan/orange filter cast, no over-processed contrast.`;

const EXT_PHOTO = `Photographic Quality:
Add only the subtle imperfections of a real photograph — natural sensor grain, gentle depth of field, believable reflections, and authentic contact shadows. Avoid HDR looks, oversaturation, artificial sharpening, or rendering artifacts.`;

const EXT_OUTPUT = `Output an ultra-high-resolution architectural photograph with neutral white balance, accurate color reproduction, and complete photographic realism.`;

// Note: pieces are now assembled directly inside buildExteriorPrompt() in the
// new, more logical order (structure lock → materials → site → atmosphere →
// characters → camera spec → output → final check) rather than a single
// fixed EXT_CORE block.

function extTimeParagraph(time){
  const map = {
    morning: `Time of Day — Morning:
Early morning light: the sun sits low near the horizon, casting long, soft-edged shadows with a warm golden cast on sunlit surfaces while shaded areas carry a cool blue tint. Combine direct low-angle sunlight with ambient skylight so shadow detail remains visible. Avoid lens flare, artificial glow, sun rays (god rays), or HDR/oversaturated grading.`,
    noon: `Time of Day — Midday:
Bright, clear daylight with strong directional sunlight from a high sun angle, casting well-defined but naturally soft-edged shadows (not pitch black). Combine direct sunlight with ambient skylight so shadows retain visible detail and a cool blue-ish tint, while sunlit areas read warm and bright. Avoid lens flare, artificial glow, sun rays (god rays), or HDR/oversaturated grading.`,
    evening: `Time of Day — Evening:
Golden hour light: the sun sits low near the horizon, casting long, soft shadows with a warm amber-orange cast across sunlit surfaces while shaded areas remain cool and detailed. If the building has exterior or window lighting, it may begin to glow softly, consistent with dusk. Avoid harsh midday contrast, lens flare, artificial glow, or HDR/oversaturated grading.`,
    night: `Time of Day — Night:
Night scene lit primarily by the building's own exterior and interior lighting — window lights glowing warm from within, exterior fixtures and any façade lighting turned on and casting realistic pools of light and reflections on nearby surfaces. Supplement with soft ambient moonlight so unlit areas remain faintly visible rather than pure black. Do not invent additional external light sources such as spotlights or streetlights beyond what the building itself would plausibly provide.`
  };
  return map[time] || map.noon;
}

function extCloudsParagraph(clouds, time){
  const night = time === 'night';
  const map = {
    none: night
      ? `Clouds:\nKeep the night sky clear, showing visible stars and a soft moonlit glow.`
      : `Clouds:\nKeep the sky free of clouds, showing a clear, natural gradient consistent with the selected time of day.`,
    thin: night
      ? `Clouds:\nA few thin, wispy clouds catch faint moonlight, with stars visible in the clearer patches — never a single flat or repeated cloud pattern.`
      : `Clouds:\nAdd a few thin, wispy clouds, varying in size and softness, soft-edged and semi-transparent — never a single flat or repeated cloud pattern.`,
    thick: night
      ? `Clouds:\nLarge drifting clouds partially veil the moon, with soft breaks revealing stars — never a single flat or repeated cloud pattern.`
      : `Clouds:\nAdd scattered thick cumulus clouds of varying size, each with visible volume, soft-lit tops, and gently shaded undersides — never a single flat or repeated cloud pattern.`,
    overcast: night
      ? `Clouds:\nA heavy overcast layer hides the moon and stars, leaving only a faint ambient glow.`
      : `Clouds:\nLet a soft, uniform layer of cloud cover most of the sky, diffusing the light evenly.`
  };
  return map[clouds] || map.thin;
}

function extWeatherParagraph(weather){
  if(weather === 'rain') return `Weather — Rain:
Overlay a rainy atmosphere with soft, diffused, directionless light. Wet surfaces (pavement, roofs, glass, foliage) show realistic sheen, reflections, and pooling water where surfaces are already flat and paved in the original image. Add fine rain streaks in the air and subtle mist near the ground. Keep lighting cool and slightly desaturated, consistent with real rainy-day photography.`;
  if(weather === 'snow') return `Weather — Snow:
A light, even layer of snow accumulates naturally on already-existing horizontal surfaces — roofs, ledges, and ground/landscaping areas already present in the original image — without altering the geometry or adding new forms. Keep contrast low, light soft and diffused, and color grading pale and cool, consistent with real snowy-day photography.`;
  return ''; // clear — no additional paragraph needed
}

function extBackgroundParagraph(bg){
  const common = `Background & Horizon:
Do not leave the background empty, flat, or showing a bare, uninterrupted horizon line where sky meets ground.`;
  if(bg === 'low') return `${common} Populate the background — beyond and around the main building — with plausible low-rise buildings and structures (roughly one to three storeys). Every added background structure must be clearly and consistently shorter than the main building's own height — never taller than it, never looming directly behind or above it, and never positioned so it dominates or competes with the main building's silhouette. These structures stay small, distant, and secondary, softening the horizon with rooftops and low massing rather than open sky. If the original image already shows other structures in the background, keep their position and silhouette but render them with realistic atmospheric perspective — slightly softer focus, reduced contrast, and a subtle cool/hazy tone the further they are from the camera. Do not invent large landmarks, towers, or any structure taller than the main building.`;
  if(bg === 'high') return `${common} Populate the background — beyond and around the main building — with a distant high-rise skyline, consistent with an urban context, softening the horizon with layered building silhouettes rather than open sky. Render distant towers with realistic atmospheric perspective — softer focus, reduced contrast, and a cool hazy tone the further they are from the camera — so they read as background depth and never compete with or overshadow the main building. Do not invent recognizable landmarks; keep the skyline generic.`;
  // trees (default)
  return `${common} Populate the background — beyond and around the main building — with natural depth cues such as distant trees, tree lines, and shrubs, consistent with what is already suggested in the original image. These background elements should partially break and soften the horizon line rather than leaving a stark, empty gap of sky directly above open ground. If the original image shows other vegetation in the background, keep its position and silhouette but render it with realistic atmospheric perspective — slightly softer focus, reduced contrast, and a subtle cool/hazy tone the further it is from the camera. Do not invent large new buildings or landmarks; only add plausible, generic greenery needed to avoid an empty horizon.`;
}

function extPeopleParagraph(people, desc){
  if(people === 'yes'){
    if(desc) return `People:
Include people in the scene as described here: ${desc}. Scale them correctly to the architecture, light them consistently with the rest of the scene, keep them secondary to the architecture, and render them photographically — never illustrative or CGI-looking.`;
    return `People:
You may include one or two people naturally present in the scene — walking, standing, or engaged in a plausible activity — scaled correctly to the architecture and lit consistently with the rest of the scene. Keep them secondary to the architecture, realistically dressed, and photographically rendered, never illustrative or CGI-looking.`;
  }
  return `People:
Do not add any people to the scene unless people already appear in the original image.`;
}

function extViewParagraph(view){
  if(view === 'bird') return `View Type — Bird's Eye View:
This overrides the "maintain exact camera position" instruction above — reposition the camera to an elevated aerial view looking down at the building and its site, at a height and angle that clearly reveals the roof plane, overall massing, and surrounding site layout, as if captured by a drone. Keep every building volume, material, and site element exactly as modeled — do not invent new geometry, additional buildings, or site layout to fill the aerial frame beyond what the original model already implies.`;
  if(view === 'isometric') return `View Type — Isometric:
This overrides the "maintain exact camera position" instruction above — reframe the shot as a photographic isometric/axonometric view: camera positioned at an elevated three-quarter angle with parallel, non-converging perspective lines, showing the building's massing, roof, and immediate site consistently from that oblique angle. Keep every building volume, material, and site element exactly as modeled — do not invent new geometry or site layout beyond what the original model implies.`;
  return ''; // eye-level / default — keep the exact camera position already locked in Geometry & Camera
}

function extCarsParagraph(cars){
  if(cars === 'yes') return `Vehicles:
You may include one or two parked or passing vehicles naturally consistent with the setting — realistically scaled, correctly lit and shadowed to match the scene, and positioned in plausible locations such as a driveway, street, or parking area already present in the original image. Keep them secondary to the architecture and photographically rendered, never illustrative or CGI-looking.`;
  return `Vehicles:
Do not add any vehicles to the scene unless vehicles already appear in the original image.`;
}

function extFocusParagraph(focus){
  if(focus === 'shallow') return `Focus Mode — Shallow Depth of Field:
Use a shallow depth of field: keep the main building critically sharp while allowing near-foreground elements (e.g. nearby foliage, railings) and the far background to fall into soft, natural photographic blur, consistent with a wide-aperture architectural lens. The blur must look optical (smooth, gradual falloff) not painted or filtered.`;
  return `Focus Mode — Deep Focus:
Use a deep depth of field: keep the entire scene — foreground, the building itself, and the background — critically sharp and in focus from front to back, consistent with a small-aperture architectural lens. No artistic blur or bokeh anywhere in the frame.`;
}

function extConsistencyReminder(){
  return `Final Consistency Check:
Before finalizing, re-check the ground plane against the original image regardless of which time of day, weather, or lighting condition was applied above: any road, driveway, parking area, or footpath — especially one directly in front of or beside the building — must still read as its correct original category (paved) with the same edges and boundary as the original image. Never let a paved surface become grass, lawn, or landscaping under any lighting condition, including low-light or golden-hour scenes where colors and edges are harder to see. Also confirm no swimming pool, pond, or fountain has been added anywhere that didn't already exist. Finally, re-check that shadow direction, softness, and color are fully consistent with the sky and light source described above — never mix a night or overcast sky with hard, sharp-edged, sun-cast daytime shadows.`;
}

function buildExteriorPrompt(){
  const time = $('sExtTime').value;
  const clouds = $('sExtClouds').value;
  const weather = $('sExtWeather').value;
  const background = $('sExtBackground').value;
  const view = $('sExtView').value;
  const people = $('sExtPeople').value;
  const peopleDesc = $('sExtPeopleDesc').value.trim();
  const cars = $('sExtCars').value;
  const focus = $('sExtFocus').value;
  const extra = $('sExtExtra').value.trim();

  // Ordered for a clearer read: structure lock → view type → materials →
  // site & landscape → wider background context → atmosphere (time/clouds/
  // weather) → characters (people/vehicles) → color & camera spec → output → final check.
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
    EXT_COLOR,
    EXT_PHOTO,
    extFocusParagraph(focus),
    EXT_OUTPUT,
    extConsistencyReminder()
  ].filter(Boolean);
  if(extra) parts.push(`Additional Instructions:\n${extra}`);

  return parts.join('\n\n');
}

// Semi Outdoor — covered terraces, pavilions, breezeways, carports: shares
// every control and building-block with Exterior, only the intro framing differs.
const SEMI_INTRO = `You are a professional architectural photographer. Transform this SketchUp model into a real-world photograph of a semi-outdoor space — a covered terrace, pavilion, breezeway, carport, or similar transitional space that is roofed or covered but open on one or more sides to the outdoors. Captured with a full-frame camera and a premium architectural lens. The exact lighting condition, time of day, and weather are specified later in this brief in the "Time of Day", "Clouds", and "Weather" sections — follow those precisely, keeping in mind that direct sun and sky visibility may be partially filtered by the covering/roof above, while open sides receive full outdoor light. Make sure the direction, color, and softness of every shadow and light source is fully consistent with the sky and light source described there.

This is a photography task, not a rendering task. The result must be indistinguishable from a real photograph and must never resemble CGI, 3D visualization, illustration, or digitally generated imagery.`;

function buildSemiOutdoorPrompt(){
  const time = $('sExtTime').value;
  const clouds = $('sExtClouds').value;
  const weather = $('sExtWeather').value;
  const background = $('sExtBackground').value;
  const view = $('sExtView').value;
  const people = $('sExtPeople').value;
  const peopleDesc = $('sExtPeopleDesc').value.trim();
  const cars = $('sExtCars').value;
  const focus = $('sExtFocus').value;
  const extra = $('sExtExtra').value.trim();

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
    EXT_COLOR,
    EXT_PHOTO,
    extFocusParagraph(focus),
    EXT_OUTPUT,
    extConsistencyReminder()
  ].filter(Boolean);
  if(extra) parts.push(`Additional Instructions:\n${extra}`);

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Interior prompt: same pattern as exterior — a fixed core, plus room type
// and artificial-lighting paragraphs appended after it.
const INT_CORE = [
`You are a professional architectural photographer. Transform this SketchUp model into a real-world interior architectural photograph captured with a full-frame camera and a wide-angle architectural lens.

This is a photography task, not a rendering task. The result must be indistinguishable from a real photograph and must never resemble CGI, 3D visualization, illustration, or digitally generated imagery.`,
`Preserve the space exactly as modeled. Do not modify, redesign, relocate, remove, invent, replace, resize, or reinterpret any wall, ceiling, column, furniture, fixture, window, door, or spatial relationship. Maintain the exact camera position, height, perspective, framing, field of view, and composition — do not crop, zoom, rotate, tilt, or reframe.`,
`Materials:
Render every material exactly as modeled, keeping its original color and tone unchanged — never reinterpret, shift, or recolor a material — but with full photographic realism: flooring shows authentic grain, grout lines, and subtle wear; upholstery shows realistic fold, compression, and fabric texture; painted walls show slight texture irregularities rather than flat digital color; metal and glass show physically accurate reflections and depth. Avoid flat, plastic, or uniformly clean CGI-looking surfaces.`,
`Photographic Quality:
Add only the subtle imperfections of a real photograph: natural sensor grain, gentle depth of field, believable reflections, and authentic contact shadows. Avoid HDR looks, oversaturation, artificial sharpening, or any rendering artifacts. Do not add people unless clearly implied by the scene.`,
`Output an ultra-high-resolution architectural interior photograph with neutral white balance, accurate color reproduction, architectural masterpiece, hyper-detailed, and complete photographic realism.`
].join('\n\n');

function intRoomParagraph(room){
  const map = {
    bedroom: `Room Type — Bedroom:
Do not assume every soft surface is plain woven fabric. Correctly distinguish between materials as actually modeled: leather or faux-leather (headboards, accent chairs) shows natural grain, subtle creasing, and a soft satin sheen with realistic highlight falloff, not a matte cloth look; velvet (cushions, throws, upholstered headboards) shows a soft directional nap whose tone shifts slightly lighter or darker depending on the direction light brushes across it, with a gentle light-catching sheen rather than a flat matte surface; woven fabrics (sheets, linen throws) show visible thread weave and fiber texture; faux-fur or sheepskin throws/rugs show individual strands with volume and soft shadowing between them, never a smooth painted blob. Render bedding with realistic weight and natural folds. Wood headboards or furniture show natural grain with soft, non-glossy sheen. Keep the atmosphere calm and restful, consistent with a lived-in but tidy bedroom.`,
    living: `Room Type — Living Room:
Do not assume every soft surface is plain woven fabric. Correctly distinguish between materials as actually modeled: leather or faux-leather sofas/chairs show natural grain, subtle creasing at stress points, and a soft satin sheen with realistic highlight falloff, not a matte cloth look; velvet upholstery and cushions show a soft directional nap whose tone shifts slightly lighter or darker depending on the direction light brushes across it, with a gentle light-catching sheen rather than a flat matte surface; woven fabrics (linen, cotton cushions, curtains) show visible thread weave and fiber texture; faux-fur or sheepskin throws/rugs show individual strands with volume and soft shadowing between them, never a smooth painted blob. Wood furniture and shelving show natural grain and subtle wear; any rugs show natural pile texture and drape. Keep the atmosphere open, welcoming, and socially inviting, consistent with a well-used communal living space.`,
    kitchen: `Room Type — Kitchen:
Render countertops (stone, quartz, or laminate) with authentic veining, subtle reflections, and believable wear; cabinetry shows natural wood grain or painted-surface texture with realistic hardware; metal appliances and fixtures show accurate brushed or polished reflections. Keep surfaces clean but not sterile — subtle real-world imperfections are expected, consistent with a functional, lived-in kitchen.`,
    bathroom: `Room Type — Bathroom:
Render tile and stone surfaces with authentic grout lines, joints, and subtle sheen, while keeping every tile's color and pattern identical to the original image — do not shift, recolor, or reinterpret tile color under any lighting condition. Glass shower screens and mirrors show accurate, clean transparency and reflection; chrome or matte-black fixtures (faucets, showerheads, towel bars) show physically accurate specular highlights. Do not add any props, towels, toiletries, or accessories that are not already present in the original image. Keep all glass and mirror surfaces clean and dry — do not add water spots, condensation, or moisture.`
  };
  return map[room] || map.living;
}

function intLightingParagraph(lighting){
  if(lighting === 'on') return `Artificial Lighting — On:
Turn on the room's artificial lighting exactly as already modeled — ceiling-mounted fixtures/downlights and wall-mounted lights or sconces glow with a gentle, softly warm-white color temperature (a subtle warmth, like real warm-white LED bulbs, not orange or amber) so the room feels inviting rather than flat or clinical, while material colors still read close to true. Light spreads and falls off naturally from each fixture, casting soft, physically accurate pools of light and gentle shadows. Combine this artificial light believably with any ambient daylight already present, without overexposing fixtures or blowing out highlights. Only activate light fixtures that are already visibly modeled in the source image — never invent new fixtures. Do not add cove, hidden, or recessed lighting unless it is already visibly modeled or the user has explicitly described it in the additional instructions below.`;
  return `Artificial Lighting — Off:
There are absolutely no secondary external light sources, no light coming from behind the camera or off-camera solid walls, no harsh direct sun rays, and no diagonal light beams or god rays. All shadows must be incredibly pale, faint, and soft-edged, creating natural ambient occlusion in corners and under furniture, maintaining a bright, clear, airy atmosphere for pristine spatial readability. Do not turn on any artificial lights — ceiling fixtures, wall lights, and cove/hidden lighting all remain off; the space is lit only by soft, diffused daylight with a gentle, faint warmth rather than a cold or clinical cast, so the image feels natural rather than flat.`;
}

function intFocusParagraph(focus){
  if(focus === 'shallow') return `Focus Mode — Shallow Depth of Field:
Use a shallow depth of field: keep the main compositional subject (e.g. the featured furniture grouping) critically sharp while allowing the immediate foreground and the far background of the room to fall into soft, natural photographic blur, consistent with a wide-aperture lens. The blur must look optical (smooth, gradual falloff), not painted or filtered.`;
  return `Focus Mode — Deep Focus:
Use a deep depth of field: keep the entire room — foreground, mid-ground, and background — critically sharp and in focus from front to back, consistent with a small-aperture architectural lens. No artistic blur or bokeh anywhere in the frame.`;
}

function buildInteriorPrompt(){
  const room = $('sIntRoom').value;
  const lighting = $('sIntLighting').value;
  const focus = $('sIntFocus').value;
  const extra = $('sIntExtra').value.trim();

  const extras = [intRoomParagraph(room), intLightingParagraph(lighting), intFocusParagraph(focus)];
  if(extra) extras.push(`Additional Instructions:\n${extra}`);

  return INT_CORE + '\n\n' + extras.join('\n\n');
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

