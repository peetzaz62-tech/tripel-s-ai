// Prompt templates for SSS Sketchup-to-Render — SERVER SIDE ONLY.
// v2: rewritten ~4x shorter. Long negation-heavy prompts dilute model attention
// and "do not change X" phrasing pulls attention toward changing X; this version
// uses compact, mostly positive phrasing with the critical locks first and last.

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

const EXT_INTRO = `Turn this architectural 3D render into a real photograph of the exact same building, shot from the exact same camera position with identical framing and perspective. Lighting, sky, and weather follow the "Time of Day", "Clouds", and "Weather" sections below, with every shadow consistent with that light source. The result is a straight photograph — nothing about it may look like CGI, a rendering, or an illustration.`;

const EXT_GEOMETRY = `Preserve exactly, without exception:
- Building geometry: every volume, facade, slab, balcony, and structural element keeps its exact shape, position, and proportion. The camera does not move, zoom, tilt, or reframe.
- Openings: every window and door keeps its exact size, shape, and position. Solid walls stay solid; no new openings appear and none are filled in.
- Ground plan: every ground surface keeps its exact category and boundary — paved roads, driveways, and paths stay paved; timber decks and terraces stay timber decking; grass and planting stay planted; pools and ponds stay water with realistic reflections. Nothing swaps category and nothing new is invented.
Realism is added on top of these surfaces, never by changing what they are.`;

const EXT_MATERIALS = [ENHANCE_NOT_CHANGE, CAMERA_ADDS].join('\n\n');

const EXT_SITE = `Site elements — roads, paths, fences, poles, streetlights, planters, and everything else already visible in the image — stay exactly in place at correct scale and become photographically real. Grass reads as healthy natural green with realistic blade texture, never yellowed by warm grading; trees and shrubs get natural irregular foliage with no repeating patterns. The scene contains exactly what the source image contains: nothing new is introduced anywhere on the site.`;

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

// Known limitation, not a bug to keep chasing in prose: on a source that
// already contains parked cars, switching this on adds more of them. A
// conditional rewrite ("only where the source contains no vehicle at all")
// was tested on 2026-07-29 and did not help — mentioning vehicles is what
// produces vehicles. The dropdown label carries the warning instead, and the
// wording here stays short.
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

export function buildExteriorPrompt(p = {}){
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
    // forces the cloud layer, so "clear cloudless sky" can never be asked for
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

export function buildSemiOutdoorPrompt(p = {}){
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
    // forces the cloud layer, so "clear cloudless sky" can never be asked for
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
// ---------------------------------------------------------------------------
// Interior — v7. Core chosen by same-seed A/B on 2026-07-27 across two sources
// (a bedroom with flat white wardrobe panels, a café with a terracotta tile
// wall), run against a longer variant that spelled out material rules and a
// shorter one that dropped them entirely. This is the variant peetz picked.
//
// Three rules learned the hard way:
//
// 1. Never name a material in the core — not even to forbid it. Prompt text
//    mentioning a material makes it more likely to appear, so a ban list reads
//    partly as a suggestion. The old room-type presets proposed materials
//    outright ("leather with natural grain, velvet with a directional nap")
//    and silently swapped what the customer had modelled, which is why Room
//    Type is gone; the later ban list was subtler but measurably worse than
//    saying nothing at all.
// 2. No lighting words in the core. An earlier core carrying "warm afternoon
//    sunlight" turned every render orange and dark regardless of the picker.
//    Every light/time word lives in intLightingParagraph and nowhere else.
// 3. Shorter beats longer. The eight-paragraph v5 core contradicted itself and
//    lost the wardrobe case; this three-paragraph core passes it.

const INT_CAMERA = `Convert this 3D interior render into a photorealistic photograph of the exact same room, from the exact same camera position and framing.`;

// The material lock, stated in BOTH directions in a single sentence. Every
// one-directional version failed on one half of the problem: a rule that only
// said "flat surfaces stay flat" stripped the grain off a genuinely wooden oak
// cabinet, and a rule that only said "wood stays wood" left flat wardrobe doors
// free to sprout grain. Naming both cases side by side is what finally held.
// This is also why the old three-paragraph version is gone: length was not the
// lever, the two-way comparison was.
// Shared with Exterior — see ENHANCE_NOT_CHANGE at the top of this file for why
// no material is named. The interior A/B that chose it: a previous version
// listed the materials a plain surface must never become ("timber, stone,
// brick, marble, tile") and it measurably made things worse, washing a
// terracotta tile wall to cream and lifting a near-black ceiling and floor to
// mid-grey, while this version held all three.
const INT_FIDELITY = ENHANCE_NOT_CHANGE;
const INT_CAMERA_ADDS = CAMERA_ADDS;

const INT_LIGHT_PHYSICS = `Light behaves physically: it bounces between surfaces picking up their colour, falls off with distance, wraps softly around edges, and settles into gentle ambient occlusion where surfaces meet.`;

const INT_PHOTO_QUALITY = `The result is a straight photograph taken with a full-frame camera and a sharp prime lens: natural dynamic range, subtle sensor grain, true-to-life colour, no HDR look, no oversaturation, no artificial sharpening.`;

const INT_CORE = [INT_CAMERA, INT_FIDELITY, INT_CAMERA_ADDS].join('\n\n');

// Close-up shot type. A detail view is a different photograph from a room view:
// a real lens this close cannot hold everything sharp, there is no "room" to
// light, and material texture is the subject rather than a finishing touch.
// Reusing the room wording on a close-up asks for deep focus across a frame
// where a real camera would have thrown the background out.
const INT_CAMERA_CLOSEUP = `Convert this 3D interior detail view into a photorealistic close-up photograph of the exact same objects, shot from the exact same camera position with identical framing and perspective. This is a detail shot, not a room view: the objects in frame are the subject.`;

const INT_CLOSEUP_DETAIL = `At this distance the materials themselves are the subject and resolve fully: wood shows open pores, ray fleck and the direction of its grain; fabric and rugs show individual tufts, weave and pile; paper and book cloth show fibre and slightly softened edges; vinyl shows fine concentric groove lines catching the light; metal shows brushed direction and tiny surface marks; painted surfaces show the faint texture of a real sprayed or rolled finish. Fine dust, soft edge wear and the small irregularities of real objects are visible, while the objects stay clean and well kept.`;

// Daylight arrives as a large diffused source, never as a beam. Direct sun
// throwing hard-edged patches and window-frame shadow bands across the floor
// reads as harsh and CG-like — the reference photography is lit by soft window
// light, so every daylight preset carries this clause.
const NO_HARD_SUN = ` The daylight arrives as a broad, diffused glow through the glazing rather than as a direct beam: there are no hard-edged shafts of sunlight, no bright sun patches and no window-frame shadow patterns striped across the floor, walls or furniture. Shadows stay soft and open.`;

// Two failures this fixes, both seen in testing:
// 1. A turntable's clear acrylic dust cover was read as a window and the model
//    invented a shaft of light blazing off it onto the wall. Anything glassy or
//    translucent is a candidate to be mistaken for an opening.
// 2. Windows came back as flat white voids. The reference photography always
//    shows a real view outside, slightly overexposed but readable.
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
// Note the deliberate absence of the words "warm" and "golden" from the white
// option: a stray warmth word anywhere in the prompt tints the whole frame.
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

export function buildInteriorPrompt(p = {}){
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

const AP_STILL = `People: one or two people at rest — seated if the picture already contains seating, otherwise standing — sharp and still, correctly scaled to the space, lit by the light already in the picture, secondary to the place itself. Whatever they rest on is something the picture already contains, and its position and count are left untouched.`;

const AP_MOVING = `People: one person walking through the picture, caught mid-stride during a long exposure so that figure alone is smeared into a soft translucent streak in the direction they are moving, while everything else in the frame stays perfectly sharp — correctly scaled to the space, lit by the light already in the picture, secondary to the place itself.`;

// The still figure is told outright that it stays sharp. An earlier version let
// both figures share one sentence with the long-exposure clause in it and the
// seated person came back soft.
const AP_BOTH = `People: one person at rest — seated if the picture already contains seating, otherwise standing — and one person walking through the picture. The still figure is rendered as sharp as everything around them. Only the walking figure is caught mid-stride during a long exposure and smeared into a soft translucent streak in the direction they are moving; everything else in the frame stays perfectly sharp. Both are correctly scaled to the space, lit by the light already in the picture, and secondary to the place itself. Whatever the still figure rests on is something the picture already contains, and its position and count are left untouched.`;

const AP_POSE = { still: AP_STILL, moving: AP_MOVING, both: AP_BOTH };

export function buildAddPeoplePrompt(p = {}){
  const pose = AP_POSE[p.pose] ? p.pose : 'still';
  const desc = String(p.desc || '').trim();

  const parts = [AP_BASE, AP_POSE[pose]];
  // Free text is appended rather than spliced into the paragraph above, so the
  // wording that was actually rendered stays byte-for-byte intact.
  if(desc) parts.push(`Additional Instructions:\n${desc}`);
  return parts.join('\n\n');
}
