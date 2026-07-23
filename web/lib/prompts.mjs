// Prompt templates for SSS Sketchup-to-Render — SERVER SIDE ONLY.
// Extracted verbatim from the original frontend; builders now take a params object.

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

export function buildInteriorPrompt(p = {}){
  const room = p.room || 'living';
  const lighting = p.lighting || 'off';
  const focus = p.intFocus || 'deep';
  const extra = String(p.intExtra || '').trim();

  const extras = [intRoomParagraph(room), intLightingParagraph(lighting), intFocusParagraph(focus)];
  if(extra) extras.push(`Additional Instructions:\n${extra}`);

  return INT_CORE + '\n\n' + extras.join('\n\n');
}
