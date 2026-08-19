
function showView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  var el = document.getElementById('view-'+name);
  if(el) el.classList.add('active');
  window.scrollTo(0,0);
}


// ===================== APP SCRIPT =====================

// ---------------------------------------------------------------------------
// API-format prompt template for "Magnific Fast":
// LoadImage -> ImageScaleBy(lanczos) -> UltimateSDUpscaleNoUpscale -> SaveImage.
//
// There is deliberately NO ESRGAN model here any more. Measured 2026-08-18 on a
// real 3904x2112 SSS exterior, comparing native-resolution crops region by
// region: essentially all of the grain people complained about was created by
// the ESRGAN, which turns the source's fine pixel-level noise into larger
// blotchy mottle. The diffusion pass adds none of it — it slightly reduces it —
// and steps/denoise are irrelevant (20 vs 60 steps moved grain by 0.004).
//
// Replacing the ESRGAN with a plain lanczos resize cuts grain hard on every
// flat man-made surface, which is most of an archviz frame:
//   window frame  3.08 -> 0.87   balcony glass 2.84 -> 0.80
//   concrete slab 2.22 -> 0.74   block wall    2.18 -> 0.73
//   paving block  2.12 -> 1.23   road asphalt  1.19 -> 0.58
// Edge sharpness costs 10-19% there. The one real loss is grass, which needs
// the high-frequency detail the ESRGAN invents (sharp 127 -> 105, blades blur
// together); peetz chose this tradeoff knowingly on 2026-08-18 because flat
// surfaces dominate these frames.
// ---------------------------------------------------------------------------
function buildMagnificPrompt(opts){
  return {
    "1": { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    "2": { class_type:"UNETLoader", inputs:{ unet_name:"flux1-dev-fp8.safetensors", weight_dtype:"default" } },
    "3": { class_type:"DualCLIPLoader", inputs:{ clip_name1:"t5xxl_fp8_e4m3fn.safetensors", clip_name2:"clip_l.safetensors", type:"flux", device:"default" } },
    "4": { class_type:"VAELoader", inputs:{ vae_name:"ae.safetensors" } },
    "6": { class_type:"CLIPTextEncode", inputs:{ text: opts.prompt || "", clip:["3",0] } },
    "7": { class_type:"FluxGuidance", inputs:{ conditioning:["6",0], guidance:3.5 } },
    // Resize first, then refine the already-sized image tile by tile. scale_by
    // takes the user's Upscale By directly, so no target dimensions to compute.
    "5": { class_type:"ImageScaleBy", inputs:{ image:["1",0], upscale_method:"lanczos", scale_by: opts.upscaleBy } },
    "8": { class_type:"UltimateSDUpscaleNoUpscale", inputs:{
        upscaled_image:["5",0], model:["2",0], positive:["7",0], negative:["7",0], vae:["4",0],
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
// API-format prompt template for "SSS · Skp to Render" — Flux.2 Dev image-edit.
// Rebuilt directly from the API-format JSON the user provided (node ids kept
// identical, e.g. "68:6", "68:12" ...). Dead/unused branches from the original
// export (LoadImageListFromDir, the disconnected ImageUpscaleWithModel, and
// the ImageCompare preview) are omitted since they don't feed the SaveImage
// output and would otherwise fail validation (missing required inputs).
// ---------------------------------------------------------------------------
// Mode picks two things that used to be welded together by a pair of switch
// nodes: whether the Turbo LoRA is in the model path, and how many steps run.
// They were welded because the exported workflow drove both from one boolean,
// which left the useful third combination — no LoRA, 8 steps — unreachable from
// the UI. That combination is the one that held the ceiling detail and the
// light direction on the kitchen source, so it gets its own option.
//
// The LoRA also lightens dark materials (it is what turned a dark grey fridge
// stainless), so it is left out of the graph entirely unless Turbo asks for it
// rather than loaded and switched around.
// Denoise below 1 turns this into img2img: the sampler starts from the source's
// own latent and runs only the tail of the schedule, so tone and colour survive
// because they were never thrown away. Sixteen renders proved no wording can
// make the model hold a dark deck dark — starting from the dark deck does it
// with no sentence at all.
//
// Granularity: SplitSigmasDenoise cuts on step boundaries, so the setting is
// quantised to 1/steps. On Turbo's 8 steps the whole slider collapses into
// three bands, measured pixel-by-pixel on 1111.jpg:
//
//   <= 0.80          two steps skipped — tone survives, still looks like a render
//   0.85 .. 0.93     one step skipped  — tone survives and it becomes a photograph
//   >= 0.95          nothing skipped   — identical to denoise 1, the bug is back
//
// Values inside a band are pixel-identical (mean abs diff 0.000). Reach for
// Quality's 20 steps when a value between bands is needed.
function buildSSSPrompt(opts){
  const mode = opts.mode || 'turbo';
  const useLora = mode === 'turbo';
  const steps = mode === 'quality' ? 20 : 8;
  const denoise = Number(opts.denoise);
  const img2img = denoise > 0 && denoise < 1;
  const g = {
    "125": { class_type:"LoadImage", inputs:{ image: opts.imageName } },
    // The exported workflow wires node 45 to the PreviewImage node (124), but
    // PreviewImage is an output node with no output slot, so ComfyUI rejects the
    // graph. Read the image straight from LoadImage and drop the preview node.
    "45":  { class_type:"ImageScaleToTotalPixels", inputs:{ upscale_method:"lanczos", megapixels: opts.megapixels, resolution_steps:1, image:["125",0] } },

    "68:38": { class_type:"CLIPLoader", inputs:{ clip_name:"mistral_3_small_flux2_bf16.safetensors", type:"flux2", device:"default" } },
    "68:12": { class_type:"UNETLoader", inputs:{ unet_name:"flux2_dev_fp8mixed.safetensors", weight_dtype:"default" } },
    "68:10": { class_type:"VAELoader", inputs:{ vae_name:"full_encoder_small_decoder.safetensors" } },
    ...(useLora ? { "68:89": { class_type:"LoraLoaderModelOnly", inputs:{ lora_name:"Flux_2-Turbo-LoRA_comfyui.safetensors", strength_model:1, model:["68:12",0] } } } : {}),

    "68:6":  { class_type:"CLIPTextEncode", inputs:{ text: opts.prompt, clip:["68:38",0] } },
    "68:26": { class_type:"FluxGuidance", inputs:{ guidance: opts.guidance, conditioning:["68:6",0] } },

    "68:44": { class_type:"VAEEncode", inputs:{ pixels:["45",0], vae:["68:10",0] } },
    "68:43": { class_type:"ReferenceLatent", inputs:{ conditioning:["68:26",0], latent:["68:44",0] } },
    "68:72": { class_type:"GetImageSize", inputs:{ image:["45",0] } },
    // img2img starts from the encoded source instead, so the empty latent is
    // left out of the graph rather than built and ignored.
    ...(img2img ? {} : { "68:47": { class_type:"EmptyFlux2LatentImage", inputs:{ width:["68:72",0], height:["68:72",1], batch_size:1 } } }),
    "68:48": { class_type:"Flux2Scheduler", inputs:{ steps, width:["68:72",0], height:["68:72",1] } },
    ...(img2img ? { "68:95": { class_type:"SplitSigmasDenoise", inputs:{ sigmas:["68:48",0], denoise } } } : {}),

    "68:25": { class_type:"RandomNoise", inputs:{ noise_seed: opts.seed } },
    "68:16": { class_type:"KSamplerSelect", inputs:{ sampler_name:"euler" } },
    "68:22": { class_type:"BasicGuider", inputs:{ model:[useLora ? "68:89" : "68:12", 0], conditioning:["68:43",0] } },
    "68:13": { class_type:"SamplerCustomAdvanced", inputs:{ noise:["68:25",0], guider:["68:22",0], sampler:["68:16",0],
      sigmas: img2img ? ["68:95",1] : ["68:48",0],
      latent_image: img2img ? ["68:44",0] : ["68:47",0] } },
    "68:8":  { class_type:"VAEDecode", inputs:{ samples:["68:13",0], vae:["68:10",0] } },

    "9": { class_type:"SaveImage", inputs:{ images:["68:8",0], filename_prefix:"SSS" } }
  };

  // Sketch to Add: regenerate only inside a drawn mask.
  //
  // SetLatentNoiseMask only means anything if the sampler starts from the
  // source's own latent — an empty latent has no original for the mask to
  // protect — so latent_image is repointed here rather than left on the
  // empty-latent branch above. Measured 2026-08-19, adding a tree to a
  // finished 3904x2112 exterior at the same seed, difference from the source:
  //
  //                inside mask     outside mask
  //   no mask         45.9          29.5  (68% of pixels moved)
  //   with mask       46.5          10.2  (27% of pixels moved)
  //
  // Inside is regenerated just as strongly either way; outside drops by two
  // thirds. A hard mask edge shows as a seam, hence the feather.
  if(opts.maskImage){
    const f = Math.max(0, Math.round(opts.maskFeather || 0));
    g["900"] = { class_type:"LoadImageMask", inputs:{ image: opts.maskImage, channel:"red" } };
    g["902"] = { class_type:"FeatherMask", inputs:{ mask:["900",0], left:f, top:f, right:f, bottom:f } };
    g["901"] = { class_type:"SetLatentNoiseMask", inputs:{ samples:["68:44",0], mask:["902",0] } };
    g["68:13"].inputs.latent_image = ["901",0];

    // That residual 10.2 is not drift: the whole frame still round-trips the
    // VAE, so outside the mask reads as "the original, very slightly softer".
    // Compositing the untouched pixels back makes it exact — but it also erases
    // any shadow the new object throws beyond the mask, which is the one thing
    // this mode exists to get right. Hence a choice, not the default.
    if(opts.lockOutside){
      g["903"] = { class_type:"ImageCompositeMasked", inputs:{
        destination:["45",0], source:["68:8",0], x:0, y:0, resize_source:false, mask:["902",0] } };
      g["9"].inputs.images = ["903",0];
    }
  }
  return g;
}
const SAVE_IMAGE_NODE_ID_SSS = "9";

// ---------------------------------------------------------------------------
let state = { workflow:"magnific", uploadedName:null, origPreviewURL:null, connected:false, clientId: crypto.randomUUID(), autoMaterials:"", lastModelKind:null };

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
  const map = {
    dawn: `Time of Day — Dawn: low sun near the horizon casting long soft-edged shadows, the light clear and only faintly warm rather than golden, with a cool tint in the shade and shadow detail kept visible. No lens flare, god rays, or HDR grading.` + NEUTRAL_WB,
    noon: `Time of Day — Midday: bright clear daylight from a high sun, well-defined but soft-edged shadows that keep visible detail. The daylight is neutral and very slightly cool, exactly as a camera set to daylight white balance records it. No lens flare, god rays, or HDR grading.` + NEUTRAL_WB,

    // Sunset here is defined by the sun's ANGLE, not its colour. Said any
    // other way the model reaches for golden hour, which is the cast this
    // whole section exists to remove — and it is the tested default now, so
    // that risk is exactly what must not come back.
    sunset: `Time of Day — Sunset: the sun has moved past its highest point but is still well up in the sky, throwing clearly directional shadows of moderate length rather than the long rakes of twilight. The light stays bright and clear and its colour is the same neutral daylight as midday — this reads as late day by the angle of the sun, not by any warming of the light, so nothing in the frame turns golden. No lens flare, god rays, or HDR grading.` + NEUTRAL_WB,
    // Rewritten 2026-08-08 from a reference photo peetz sent: a deep blue sky
    // sinking into a warm orange-and-pink band at the horizon, first stars
    // showing in the blue above. The old text (reused from the pre-rename
    // "evening" key, see the git history) only described light falling on the
    // building and said nothing about the sky itself, which is the entire
    // subject of that reference. The building must stay readable though — a
    // real estate/archviz shot cannot go full silhouette the way a landscape
    // photo can, so that constraint is stated explicitly.
    twilight: `Time of Day — Twilight: the sun has just gone down and the sky itself carries the colour — a deep blue at the top of the frame sinking through dusk into a warm glowing band of orange and pink low on the horizon where the sun went down, with the first faint stars visible in the blue above. The building is lit by the last of that sky light plus its own switched-on lights, which glow warm and cast soft pools near the facade — forms stay readable, never falling into full silhouette. No lens flare, god rays, or HDR grading.`,
    // "moonlight" named a moon into being — the usual failure — so this no
    // longer says where the ambient night fill comes from, only that it
    // exists. Fixed 2026-08-08 after peetz asked for a moonless night.
    night: `Time of Day — Night: the scene is lit by the building's own interior and exterior lights, glowing warm and casting realistic pools of light, with a faint cool ambient glow keeping unlit areas readable rather than pure black. Away from those pools the night stays cool and neutral, not tinted amber. No invented external light sources.`
  };
  return map[time] || map.noon;
}

// The five night variants named "moon"/"moonlight" outright, and a named
// thing appears — this is very likely why a moon disc kept showing up in
// night renders nobody asked for. Fixed 2026-08-08: every ambient-glow phrase
// stays, only the moon itself is gone. Stars are untouched — peetz asked for
// no moon, not no stars.
function extCloudsParagraph(clouds, time){
  const night = time === 'night';
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
  return map[clouds] || map.thin;
}

function extWeatherParagraph(weather){
if(weather === 'rain') return `Weather — Rain: the whole scene sits under a dim, gloomy, heavily overcast light with no sunshine anywhere in it. Wet sheen and standing reflections on paved and hard surfaces, fine rain streaks through the air and light ground mist, cool and slightly desaturated throughout.`;
  if(weather === 'snow') return `Weather — Snow: a light natural layer of snow on existing horizontal surfaces only, soft diffused light, low contrast, pale cool grading. Geometry unchanged.`;
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
  const time = p.time || 'sunset';
  const clouds = p.clouds || 'thin';
  const weather = p.weather || 'clear';
  const background = p.background || 'auto';
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
  const time = p.time || 'sunset';
  const clouds = p.clouds || 'thin';
  const weather = p.weather || 'clear';
  const background = p.background || 'auto';
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

// Two failures this fixes, both seen in testing:
// 1. A turntable's clear acrylic dust cover was read as a window and the model
//    invented a shaft of light blazing off it onto the wall.
// 2. Windows came back as flat white voids.
const NO_PHANTOM_SOURCE = ` Light enters only through the openings that already exist in the source image. Every solid wall and panel in the source stays solid and unbroken: no new opening of any kind appears anywhere, and no existing opening changes its size, shape or position. No new lamp or glowing panel is invented, and no object, screen, glass cover or reflective surface is turned into a light source or mistaken for an opening.`;

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

function intLightingParagraph(mode, fixtures, bg, closeup){
  const m = INT_LIGHT_ON[mode] ? mode : 'white';
  const base = (fixtures === 'off' ? INT_LIGHT_OFF : INT_LIGHT_ON)[m];
  // Only the two modes that describe a lit room take the glow, the high-key
  // exposure and the soft-shadow clause. Evening and night are meant to be
  // dark, and a bright-and-welcoming sentence would fight their own opening
  // line — the kind of self-contradiction that broke the old v5 core.
  const litRoom = (m === 'white' || m === 'warm') ? (INT_GLOW + INT_HIGH_KEY + SOFT_SHADOWS) : '';
  // A close-up frame often contains no glazing at all, so asking for a view
  // through it invites one to be drawn.
  return base + litRoom + NO_PHANTOM_SOURCE + (closeup ? '' : intViewOutsideParagraph(bg, m));
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
    intFixtures: $('sIntFixtures').value, intBg: $('sIntBg').value,
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
['sIntLight','sIntShot','sIntFixtures','sIntBg','sIntFocus','sIntPeople','sIntExtra','sAutoMat'].forEach(id=>{
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
    document.querySelectorAll('.wf-opt').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
    state.workflow = el.dataset.wf;
    $('paramsCardMagnific').style.display = state.workflow === 'magnific' ? '' : 'none';
    $('paramsCardSSS').style.display = state.workflow === 'sss' ? '' : 'none';
    $('paramsCardPeople').style.display = state.workflow === 'people' ? '' : 'none';
    $('paramsCardSketch').style.display = state.workflow === 'sketch' ? '' : 'none';
    skSyncMode();
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
const SK_TYPES = [
  { id:'tree',   label:'ต้นไม้',   color:'#3FA34D' },
  { id:'rock',   label:'หิน',      color:'#8A8F98' },
  { id:'people', label:'คน',       color:'#E0632F' },
  { id:'car',    label:'รถ',       color:'#2D6CDF' },
  { id:'animal', label:'สัตว์',    color:'#9B59B6' },
  { id:'lamp',   label:'ดวงโคม',   color:'#E5B700' },
  { id:'hidden', label:'ไฟซ่อน',   color:'#00A7B5' }
];
const SK_TYPE_BY_ID = Object.fromEntries(SK_TYPES.map(t => [t.id, t]));

// Same opening as Add People, which is already proven for "the input is a
// finished photograph, add something to it".
const SK_BASE = `This is a finished photograph. Leave it exactly as it is — the same place, the same objects in the same positions, the same materials, the same colours, the same lighting and the same camera. Nothing already in the frame is moved, replaced, restyled or removed.`;

// The clause that answers "ผสาน แสง เงา mood ให้เข้ากับงานต้นฉบับ". It never
// states a direction or a softness, it states that both match what is already
// there — so it reads the source instead of being told what the source is.
const SK_DAYLIT = ` It is lit by the light already in the frame, catching that light from the same direction as everything around it, and it casts its own shadow onto the ground in the same direction and with the same softness as the shadows already there.`;
const SK_DAYLIT_PL = ` They are lit by the light already in the frame, catching that light from the same direction as everything around them, and they cast their own shadows onto the ground in the same direction and with the same softness as the shadows already there.`;

// Light sources need the opposite clause: they give light rather than take it.
const SK_EMIT = ` The light it gives off is the same colour temperature as the light already in the picture. Its glow spreads onto the surfaces immediately around it and fades away gradually; nothing further away in the frame changes exposure.`;

const SK_WHAT = {
  tree: n => n === 1
    ? `The only change is that a tree now grows in it: a real tree standing on the ground with a trunk, a branching structure and a full leafy canopy, at a believable size for the space around it.`
    : `The only change is that trees now grow in it: real trees standing on the ground, each with a trunk, a branching structure and a full leafy canopy, at a believable size for the space around them.`,
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
  animal: n => n === 1
    ? `The only change is that an animal is now present in it: an ordinary animal that belongs in a place like this, standing on the ground, correctly scaled to the space.`
    : `The only change is that animals are now present in it: ordinary animals that belong in a place like this, standing on the ground, correctly scaled to the space.`,
  // "of the kind this place already uses" is the conditional form again: it
  // makes the model read the room rather than invent a fitting for it.
  lamp: n => n === 1
    ? `The only change is that a light fitting is now mounted there and switched on: a fitting of the kind this place already uses, giving off light.`
    : `The only change is that light fittings are now mounted there and switched on: fittings of the kind this place already uses, giving off light.`,
  hidden: () => `The only change is that concealed lighting is now switched on there: the fitting itself stays completely out of sight, and only the light it throws across the surface is visible — an even wash, brightest closest to where it is concealed, fading away smoothly.`
};
const SK_EMITTING = { lamp:1, hidden:1 };

function buildSketchPromptP(p = {}){
  const type = SK_WHAT[p.type] ? p.type : 'tree';
  const count = Math.max(1, Math.round(Number(p.count) || 1));
  const tail = SK_EMITTING[type] ? SK_EMIT : (count === 1 ? SK_DAYLIT : SK_DAYLIT_PL);
  const desc = String(p.desc || '').trim();
  // Free text is appended rather than spliced in, so the wording that was
  // actually rendered stays byte-for-byte intact.
  const parts = [SK_BASE + ' ' + SK_WHAT[type](count) + tail];
  if(desc) parts.push(`Additional Instructions:\n${desc}`);
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

// The mask is a hard boundary, and a shadow is something appearing: a canopy
// drawn on its own comes back with no trunk under it and no shadow on the
// ground, because both of those live in pixels the mask forbids touching. No
// wording fixes that — "it casts its own shadow onto the ground" was already in
// the prompt when the first tree came back shadowless on 2026-08-19. So the
// exported mask is grown past the stroke instead: a little in every direction,
// and much further downward, which is where a trunk, a pair of legs, a wheel
// and a contact shadow all are. A light fitting gets an even grow instead —
// its glow spreads in every direction, and it has no trunk.
function skApron(type){
  const v = Math.max(0, parseFloat($('skGround').value) || 0) / 100;
  return SK_EMITTING[type] ? { grow: v, drop: 0 } : { grow: v * 0.4, drop: v * 1.8 };
}

// Smearing the stroke downward in small steps, rather than stamping one big
// shape at the bottom, keeps the grown area the shape of what was drawn.
function skPaintGrown(ctx, strokes, W, H, type, colour){
  const short = Math.min(W, H);
  const { grow, drop } = skApron(type);
  const dropPx = drop * short;
  const steps = dropPx > 0 ? Math.max(1, Math.round(dropPx / 4)) : 0;
  for(let i = steps; i >= 1; i--){
    skPaint(ctx, strokes, W, H, colour, grow * short, dropPx * (i / steps));
  }
  skPaint(ctx, strokes, W, H, colour, grow * short, 0);
}

function skRedraw(){
  const cv = $('skCanvas');
  if(!cv.width) return;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const all = SK.cur ? SK.strokes.concat([SK.cur]) : SK.strokes;
  // The grown area is drawn faintly as well, because it is part of what gets
  // regenerated — someone who cannot see it cannot tell why the frame changed
  // where it did, and cannot tell whether the shadow has room to land.
  ctx.globalAlpha = 0.14;
  for(const t of new Set(all.map(s => s.type))){
    skPaintGrown(ctx, all.filter(s => s.type === t), cv.width, cv.height, t, SK_TYPE_BY_ID[t].color);
  }
  ctx.globalAlpha = 0.42;
  skPaint(ctx, all, cv.width, cv.height, null);
  ctx.globalAlpha = 1;
  skCursor(ctx, cv.width, cv.height);
}

// The brush lays down a round stamp — measured 86x86 for a 10% brush, area
// 0.998 of a true circle — but the pointer was a crosshair, which tells you
// nothing about how much of the frame that stamp covers. So the pointer is the
// stamp: a ring at its real size, with the grown area outlined below it, since
// that outline is the difference between a tree that can cast a shadow and one
// that cannot. Drawn last so it sits over the strokes, and never exported —
// skMaskBlob paints through skPaintGrown alone.
function skCursor(ctx, W, H){
  if(!SK.hover) return;
  const short = Math.min(W, H);
  const rad = Math.max(2, parseFloat($('skBrush').value) / 100 * short) / 2;
  const { grow, drop } = skApron(SK.type);
  const x = SK.hover[0] * W, y = SK.hover[1] * H;
  const gr = rad + grow * short, dy = drop * short;

  ctx.save();
  if(gr > rad + 0.5 || dy > 0.5){
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffffcc';
    ctx.beginPath();
    ctx.arc(x, y, gr, Math.PI, 0);
    ctx.lineTo(x + gr, y + dy);
    ctx.arc(x, y + dy, gr, 0, Math.PI);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // A dark ring under a light one, so the cursor reads on a bright sky and on
  // dark asphalt without knowing which it is over.
  ctx.lineWidth = 3; ctx.strokeStyle = '#00000088';
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI*2); ctx.stroke();
  ctx.lineWidth = 1.4; ctx.strokeStyle = SK_TYPE_BY_ID[SK.type].color;
  ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI*2); ctx.stroke();
  ctx.restore();
}

// Masks are exported at the source's own aspect ratio, capped on the long edge:
// the sampler rescales the mask to the latent anyway, but a mask with a
// different aspect ratio would arrive stretched.
function skMaskSize(){
  const img = $('skImg');
  const s = Math.min(1, 1536 / Math.max(img.naturalWidth, img.naturalHeight));
  return [Math.max(8, Math.round(img.naturalWidth * s)), Math.max(8, Math.round(img.naturalHeight * s))];
}

function skMaskBlob(type, W, H){
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  skPaintGrown(ctx, SK.strokes.filter(s => s.type === type), W, H, type, '#fff');
  return new Promise(r => c.toBlob(r, 'image/png'));
}

// Passes in the order the types were first drawn, so the list on screen and the
// order they render in are the same thing.
function skPasses(){
  const order = [], count = {};
  for(const s of SK.strokes){
    if(!count[s.type]){ order.push(s.type); count[s.type] = 0; }
    count[s.type]++;
  }
  return order.map(t => ({ type: t, count: count[t] }));
}

function skRefreshPrompt(){
  const p = skPasses()[0];
  $('skPrompt').value = p ? buildSketchPromptP({ type: p.type, count: p.count, desc: SK_DESC[p.type] }) : '';
}

function skRefreshUI(){
  const counts = {};
  SK.strokes.forEach(s => counts[s.type] = (counts[s.type] || 0) + 1);

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
      inp.placeholder = 'รายละเอียดเพิ่มเติม (ไม่ใส่ก็ได้)';
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
    SK.cur = { type: SK.type, size: parseFloat($('skBrush').value), pts: [p] };
    skRedraw();
  });
  // Runs whether or not a stroke is in progress: the ring has to follow the
  // pointer before the first press, which is when its size matters most.
  cv.addEventListener('pointermove', e => {
    const p = at(e);
    if(!p) return;
    SK.hover = p;
    if(SK.cur) SK.cur.pts.push(p);
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

  $('skUndo').addEventListener('click', () => { SK.strokes.pop(); skRedraw(); skRefreshUI(); });
  $('skClear').addEventListener('click', () => { SK.strokes = []; skRedraw(); skRefreshUI(); });
  $('skBrush').addEventListener('input', skRedraw);
  $('skGround').addEventListener('input', skRedraw);
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
  new ResizeObserver(() => { if(SK.stage === 'sketch') skFitCanvas(); }).observe($('skWrap'));
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
  const feather = Math.round(Math.min(mw, mh) * (parseFloat($('skFeather').value) || 0) / 100);
  const seed = parseInt($('skSeed').value);
  const common = {
    mode: $('skTurbo').value,
    guidance: parseFloat($('skGuidance').value),
    megapixels: parseFloat($('skMegapixels').value),
    lockOutside: $('skLock').checked,
    maskFeather: feather
  };

  const stamp = Date.now();
  let inputName = state.uploadedName;
  let last = null;

  for(let i = 0; i < passes.length; i++){
    const p = passes[i];
    log('รอบที่ ' + (i+1) + '/' + passes.length + ' · ' + SK_TYPE_BY_ID[p.type].label + ' · ' + p.count + ' จุด');

    let maskName;
    try{
      maskName = await uploadBlob(await skMaskBlob(p.type, mw, mh), 'sketchmask_' + stamp + '_' + p.type + '.png');
    }catch(e){
      log('อัปโหลด mask ไม่สำเร็จ: ' + e.message, 'err');
      break;
    }

    const img = await submitAndWait(buildSSSPrompt(Object.assign({}, common, {
      imageName: inputName,
      maskImage: maskName,
      // A different seed per pass: the same one twice correlates what appears
      // in two unrelated masks.
      seed: seed + i,
      prompt: buildSketchPromptP({ type: p.type, count: p.count, desc: SK_DESC[p.type] })
    })), SAVE_IMAGE_NODE_ID_SSS);

    if(!img){ log('หยุดที่รอบ ' + (i+1) + ' — ผลของรอบก่อนหน้ายังใช้ได้', 'err'); break; }
    last = img;

    // Feed this pass into the next one. LoadImage reads ComfyUI's input folder
    // and SaveImage writes to its output folder, so the frame has to come back
    // over /view and go up again rather than be referenced by name.
    if(i < passes.length - 1){
      try{
        const res = await fetch(viewUrlFor(img));
        if(!res.ok) throw new Error('HTTP ' + res.status);
        inputName = await uploadBlob(await res.blob(), 'sketchstep_' + stamp + '_' + i + '.png');
      }catch(e){
        log('ส่งภาพต่อเข้ารอบถัดไปไม่ได้: ' + e.message, 'err');
        break;
      }
    }
  }

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
  $('previewImg').onload = () => applyPromptType();
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

function updateRunEnabled(){
  // Sketch to Add has nothing to do until something is actually drawn — the
  // mask is the instruction, so an empty canvas is an empty request.
  const drawn = state.workflow !== 'sketch' || SK.strokes.length > 0;
  btnRun.disabled = !(state.connected && state.uploadedName && drawn);
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

  // Sketch to Add runs its own loop: one masked pass per element type, each
  // starting from the previous pass's output, so it never reaches the
  // single-graph path below.
  if(state.workflow === 'sketch'){
    await freeIfModelSwitch('flux2');
    await runSketchPasses();
    btnRun.disabled = false;
    return;
  }

  let prompt, saveImageNodeId;
  if(state.workflow === 'sss'){
    const opts = {
      imageName: state.uploadedName,
      prompt: $('sPromptType').value === 'custom' ? $('sPrompt').value : hiddenPromptCache,
      mode: $('sTurbo').value,
      guidance: parseFloat($('sGuidance').value),
      megapixels: parseFloat($('sMegapixels').value),
      // Add People deliberately does not pass this: its input is already a
      // finished photograph, and starting from its latent would leave no room
      // for the figures to appear.
      denoise: parseFloat($('sDenoise').value),
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
      mode: $('apTurbo').value,
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
      seed: parseInt($('pSeed').value)
    };
    prompt = buildMagnificPrompt(opts);
    saveImageNodeId = SAVE_IMAGE_NODE_ID_MAGNIFIC;
  }

  await freeIfModelSwitch(state.workflow === 'magnific' ? 'flux1' : 'flux2');

  const img = await submitAndWait(prompt, saveImageNodeId);
  if(img) showRunResult(img);
  btnRun.disabled = false;
}

// The Magnific graph loads flux1-dev-fp8; every other mode loads
// flux2_dev_fp8mixed. ComfyUI's own eviction didn't reliably swap these on the
// shared GPU box — measured 2026-08-17: a stale flux2 load left only
// 743MB/12.8GB VRAM free, so the flux1 load partially offloaded to system RAM
// and took 10x longer than normal. Forcing an unload only on an actual
// model-family switch (not on repeat runs of the same workflow) avoids paying
// that reload cost when it isn't needed.
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
  $('actionsBottom').style.display = 'flex';
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

