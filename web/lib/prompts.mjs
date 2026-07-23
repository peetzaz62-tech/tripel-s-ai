// Prompt templates for SSS Sketchup-to-Render — SERVER SIDE ONLY.
// v2: rewritten ~4x shorter. Long negation-heavy prompts dilute model attention
// and "do not change X" phrasing pulls attention toward changing X; this version
// uses compact, mostly positive phrasing with the critical locks first and last.

const EXT_INTRO = `Turn this architectural 3D render into a real photograph of the exact same building, shot from the exact same camera position with identical framing and perspective. Lighting, sky, and weather follow the "Time of Day", "Clouds", and "Weather" sections below, with every shadow consistent with that light source. The result is a straight photograph — nothing about it may look like CGI, a rendering, or an illustration.`;

const EXT_GEOMETRY = `Preserve exactly, without exception:
- Building geometry: every volume, facade, slab, balcony, and structural element keeps its exact shape, position, and proportion. The camera does not move, zoom, tilt, or reframe.
- Openings: every window and door keeps its exact size, shape, and position. Solid walls stay solid; no new openings appear and none are filled in.
- Ground plan: every ground surface keeps its exact category and boundary — paved roads, driveways, and paths stay paved; grass and planting stay planted; pools and ponds stay water with realistic reflections. Nothing swaps category and nothing new is invented.
Realism is added on top of these surfaces, never by changing what they are.`;

const EXT_MATERIALS = `Materials keep their original colors and tones, upgraded to photographic realism: concrete shows formwork lines and subtle tonal variation; brick and stone show real joints and units; metal cladding shows its profile and correct sheen; glass is genuinely transparent with believable reflections and interior depth; wood shows natural grain; painted and rendered surfaces show faint real texture instead of flat digital color. Every material stays in its own family.`;

const EXT_SITE = `Site elements — roads, paths, fences, poles, streetlights, planters, and any vehicles already present — stay in place at correct scale and become photographically real. Grass reads as healthy natural green with realistic blade texture, never yellowed by warm grading; trees and shrubs get natural irregular foliage with no repeating patterns. Nothing is added to or removed from the site.`;

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
  return `People: no people unless they already appear in the source image.`;
}

function extViewParagraph(view){
  if(view === 'bird') return `View — Bird's Eye (this overrides the fixed camera): an elevated drone view looking down that reveals the roof, overall massing, and site layout, with every building and site element still exactly as modeled.`;
  if(view === 'isometric') return `View — Isometric (this overrides the fixed camera): an elevated three-quarter view with parallel, non-converging perspective lines showing the massing, roof, and immediate site, everything exactly as modeled.`;
  return ''; // eye-level — camera already locked
}

function extCarsParagraph(cars){
  if(cars === 'yes') return `Vehicles: one or two realistic vehicles in plausible spots (driveway, street, or parking area), correctly scaled and lit, secondary to the building.`;
  return `Vehicles: no vehicles unless they already appear in the source image.`;
}

function extFocusParagraph(focus){
  if(focus === 'shallow') return `Focus: shallow depth of field — the building critically sharp, near foreground and far background falling into smooth optical blur.`;
  return `Focus: deep depth of field — sharp from front to back, no blur or bokeh anywhere.`;
}

function extConsistencyReminder(){
  return `Final check: an ultra-detailed high-resolution photograph in which the building's geometry, every opening, and the ground layout (paved stays paved, planted stays planted, water stays water) match the source image exactly, and every shadow matches the sky described above.`;
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
`Color & Photographic Quality: neutral white balance, true-to-source colors, subtle sensor grain, believable contact shadows and reflections. No HDR look, oversaturation, or artificial sharpening. No people unless already implied by the scene.`
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

export function buildInteriorPrompt(p = {}){
  const room = p.room || 'living';
  const lighting = p.lighting || 'off';
  const focus = p.intFocus || 'deep';
  const extra = String(p.intExtra || '').trim();

  const extras = [intRoomParagraph(room), intLightingParagraph(lighting), intFocusParagraph(focus)];
  if(extra) extras.push(`Additional Instructions:\n${extra}`);

  return INT_CORE + '\n\n' + extras.join('\n\n')
    + '\n\nFinal check: an ultra-detailed high-resolution photograph in which every wall, opening, furniture piece, and material color matches the source image exactly.';
}
