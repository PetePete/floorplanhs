# Floorplan 3D Card

An interactive 3D floorplan for your Home Assistant dashboard. Load a glTF/GLB
model of your own house — or start with the built-in demo house — and the card
turns it into a live view: lights that actually light the room they are in,
cross-sections that slice the building open, camera presets you can fly between,
and drag & drop placement of entities straight onto the geometry. It is one
self-contained ES module, with no add-on, no backend and no external service:
the card reads the `hass` object it is handed and writes its own configuration
back into your dashboard YAML.

This is a free, open-source alternative to the commercial 3D floorplan products
sold as smart-home add-ons. Nothing phones home, nothing is rendered in a cloud,
and your model file never leaves your Home Assistant instance.

> **Placeholder URLs:** every `https://github.com/USERNAME/floorplan-3d-card`
> link below is a placeholder — replace `USERNAME` with the account that hosts
> your fork or the upstream repository.

---

## Features

- **Real lighting.** A `light` entity becomes a real three.js light. Brightness,
  RGB colour and colour temperature from Home Assistant drive the actual
  illumination, not a coloured icon.
- **Cross-sections.** Isolate one storey, slide cut planes along X/Y/Z, or clip
  to a box — with solid cut caps so walls do not look like empty shells.
- **Camera presets.** Save a viewpoint (plus its cross-section and level
  visibility), give it a name and an icon, and fly to it in one tap. Optional
  slideshow tour and idle return.
- **Drag & drop placement.** Drag an entity onto the model in edit mode; it
  lands on the surface you dropped it on, on the correct level, and the position
  is written back to your YAML rounded to millimetres.
- **Markers & hotspots** for everything that is not a light: sensors, covers,
  climate, media players, people — with tap / hold / double-tap actions.
- **On-demand rendering.** The render loop idles when nothing changes, which is
  what makes this usable on a wall tablet.
- **Visual editor.** Full GUI configuration with a live YAML preview; every
  option below is reachable without touching YAML.
- **Works with no model at all.** The demo house (three storeys, 12.9 × 10 m)
  ships inside the bundle so you can evaluate the card in 30 seconds.

## Installation

### HACS (recommended)

1. HACS → **Frontend** → ⋮ → **Custom repositories**.
2. Repository: `https://github.com/USERNAME/floorplan-3d-card`, category
   **Lovelace / Plugin**. Add.
3. Install **Floorplan 3D Card**, then reload the browser (Ctrl/Cmd + Shift + R).

HACS registers the resource for you. If it does not, add it manually as below.

### Manual

1. Download `floorplan-3d-card.js` from the
   [latest release](https://github.com/USERNAME/floorplan-3d-card/releases).
2. Copy it to `config/www/floorplan-3d-card.js` — that path is served as
   `/local/floorplan-3d-card.js`.
3. **Settings → Dashboards → ⋮ → Resources → Add resource**:

   | Field | Value |
   | ----- | ----- |
   | URL   | `/local/floorplan-3d-card.js?v=0.1.0` |
   | Type  | **JavaScript module** (`type: module`) |

   In YAML-mode dashboards:

   ```yaml
   resources:
     - url: /local/floorplan-3d-card.js?v=0.1.0
       type: module
   ```

   Bump the `?v=` query after every update, or the browser will keep serving the
   old bundle.

Minimum Home Assistant version: **2024.4.0**.

## Quick start

Zero configuration — this renders the built-in demo house:

```yaml
type: custom:floorplan-3d-card
```

A realistic setup with your own model, levels, presets and placed lights:

```yaml
type: custom:floorplan-3d-card
title: Home
model:
  url: /local/house.glb?v=3
  scale: 1
  rotation: [0, 0, 0]
  levels:
    - id: basement
      name: Basement
      elevation: -2.7
      height: 2.7
      icon: mdi:home-floor-b
    - id: ground
      name: Ground floor
      elevation: 0
      height: 2.9
      icon: mdi:home-floor-g
    - id: upper
      name: Upper floor
      elevation: 2.9
      height: 2.9
      icon: mdi:home-floor-1
  glassNodes: [window, glass]
presets:
  - id: overview
    name: Overview
    icon: mdi:home
    position: [12.5, 9.0, 12.5]
    target: [0, 1.2, 0]
    default: true
  - id: ground_plan
    name: Ground plan
    icon: mdi:floor-plan
    position: [0, 18, 0.01]
    target: [0, 0, 0]
    orthographic: true
    orthoZoom: 26
    visibleLevels: [ground]
    section:
      mode: level
      levelId: ground
      caps: true
entities:
  - entity: light.kitchen_ceiling
    position: [-2.15, 2.62, 1.4]
    level: ground
    light:
      kind: spot
      angle: 48
      penumbra: 0.5
      distance: 8
      castShadow: true
      fixture:
        show: true
        radius: 0.07
  - entity: light.living_room_floor_lamp
    position: [2.8, 1.35, -1.9]
    level: ground
    light:
      kind: point
      intensity: 1.2
      distance: 6
  - entity: sensor.living_room_temperature
    position: [3.4, 1.5, 2.1]
    level: ground
    marker:
      shape: pill
      showState: true
  - entity: cover.garage_door
    position: [-5.2, 1.1, 4.8]
    level: ground
    tap_action:
      action: toggle
render:
  quality: auto
  shadows: true
  bloom: true
  daylight: true
  daylightEntity: sun.sun
ui:
  height: 560px
  showLevelSelector: true
```

## How it works

### Lighting

A placed entity in the `light` domain is not a marker — it is a real light in
the scene:

- **Brightness → candela.** Home Assistant's `brightness` (0–255) is mapped
  through a perceptual power curve (exponent 2.2) to a candela-like intensity,
  so dimming *looks* like dimming instead of collapsing to black halfway down.
- **Colour.** `rgb_color`, `hs_color` and `color_temp_kelvin` are converted to
  linear RGB and applied to the light. Set `useEntityColor: false` plus a fixed
  `color` when you want a constant tint.
- **Falloff.** Point and spot lights default to an **8 m falloff radius** rather
  than infinite range, with `decay: 2` (physically correct). That keeps a single
  bulb from washing out the whole model. `distance: 0` restores infinite range.
- **The luminaire.** A small emissive body is drawn at the light position and
  put on the selective-bloom layer, so it glows when the light is on — a bright
  white wall never blooms, only the fixture does.
- **Shadow budget.** At most **four lights cast real shadows at once** on the
  high quality tier; the engine picks them by brightness and camera proximity
  and swaps them as you move. Mark the important ones with
  `light.castShadow: true`; the rest still illuminate, they just do not occlude.

### Cross-sections

`section.mode` picks the technique:

- `level` — isolate one storey; everything above and below is clipped away (or
  faded, with `ghostAbove: true`).
- `plane` — up to three clipping planes, one per axis, draggable in the card.
- `box` — keep only what is inside a world-space box.

Cut surfaces are filled with solid caps using a stencil pass so a sliced wall
reads as a wall. If the WebGL context has no stencil buffer available, the card
falls back to hollow shells rather than failing.

### Presets

A preset stores the camera position and target, and optionally the field of
view, orthographic mode, the cross-section state and which levels were visible.
Frame the shot in the card, hit **Save current view** in the toolbar, and the
preset is written into your dashboard YAML. Presets with `inTour: true` are
included in the auto-rotate slideshow; the one with `default: true` is applied
on load.

### Drag & drop

In dashboard edit mode the card accepts entities dropped onto the model. The
drop is raycast against the building shell, so the entity lands on the surface
under your finger, gets the level it fell into, and its position is rounded to
three decimals before being written back through `config-changed`. Touch is a
first-class path — this works with a finger, not just a mouse.

---

## Configuration reference

Every option, straight from `src/types/config.ts`. Options marked *(engine
default)* have no explicit value in the YAML schema; the listed value is what
the engine uses when the key is absent.

### Top level

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | — | Required. `custom:floorplan-3d-card`. |
| `title` | string | — | Optional heading rendered above the view. |
| `model` | [`ModelConfig`](#model) | demo house | Where the geometry comes from and how it is placed. |
| `camera` | [`CameraConfig`](#camera) | see below | Orbit and transition behaviour. |
| `presets` | [`CameraPreset[]`](#presets-1) | `[]` | Named viewpoints. |
| `tour` | [`TourConfig`](#tour) | off | Cycle through the saved views automatically. |
| `entities` | [`PlacedEntity[]`](#entities) | `[]` | Entities anchored in the model. |
| `section` | [`SectionState`](#section) | `mode: none` | Initial cross-section. |
| `render` | [`RenderConfig`](#render) | see below | Renderer and post-processing. |
| `ui` | [`UiConfig`](#ui) | see below | Which chrome the card shows. |
| `config_version` | number | `1` | Written by migrations. Do not edit by hand. |

### Model

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `url` | string | — | e.g. `/local/house.glb`. Absent → the procedural demo house. |
| `demo` | boolean | `false` | Force the demo house even when `url` is set. |
| `scale` | number | `1` | Uniform scale. 1 world unit = 1 metre. |
| `rotation` | `[x, y, z]` | `[0, 0, 0]` | Degrees, applied XYZ. Z-up exports usually need `[-90, 0, 0]`. |
| `offset` | `[x, y, z]` | `[0, 0, 0]` | Metres. Use it to put the ground floor at y = 0. |
| `levels` | `LevelDefinition[]` | auto-detected | Explicit storeys. Omit and the engine clusters floor-slab heights. |
| `glassNodes` | string[] | — | Node-name patterns whose materials become see-through glass. |
| `dracoPath` | string | — | Draco decoder directory; only needed for Draco-compressed files. Trailing slash required. |

#### `LevelDefinition`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | — | Required. Stable id referenced by presets and entities. |
| `name` | string | — | Required. Shown in the level selector. |
| `elevation` | number | — | Required. World Y of the finished floor, in metres. |
| `height` | number | — | Required. Storey height; defines the isolate-level clipping box. |
| `nodes` | string[] | — | glTF node names belonging to this level. Empty → derived from bounds. |
| `icon` | string | — | MDI icon for the level selector. |

Levels are half-open ranges `[elevation, elevation + height)`.

### Camera

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `navigation` | `cad` \| `orbit` | `cad` | `cad` follows Fusion/SolidWorks: **middle button drags to orbit, right button pans, the wheel zooms toward the cursor, and the left button does nothing** — it belongs to selecting and dragging entities, so a mis-aimed click can never spin the view. `orbit` restores the plain three.js mapping where left-drag rotates. Touch is identical either way: one finger orbits, two pan and pinch. |
| `fov` | number | `45` | Vertical field of view in degrees. |
| `near` | number | `0.1` | Near clipping distance, metres. |
| `far` | number | `500` | Far clipping distance, metres. |
| `minDistance` | number | `1.5` | Closest the user can zoom in. |
| `maxDistance` | number | `80` | Furthest the user can zoom out. |
| `maxPolarAngle` | number (radians) | `π/2 − 0.02` (≈ 88.9°) | Clamp so the camera cannot orbit under the ground plane. The editor shows this in degrees. |
| `damping` | number | `0.08` | Orbit inertia. Higher is snappier. |
| `transitionDuration` | number | `1.1` | Seconds a preset flight takes. |
| `autoRotate` | boolean | `false` | Slow idle orbit. |
| `autoRotateSpeed` | number | `0.4` | Auto-rotate rate. |
| `idleReturnAfter` | number | `0` | Seconds of no interaction before returning to the default preset. `0` = off. |

### Presets

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | — | Required. Referenced by `action: preset`. |
| `name` | string | — | Required. Label in the preset bar. |
| `icon` | string | — | MDI icon. |
| `position` | `[x, y, z]` | — | Required. Camera position in metres. |
| `target` | `[x, y, z]` | — | Required. Look-at point. |
| `fov` | number | inherits `camera.fov` | Per-preset field of view. |
| `orthographic` | boolean | `false` | Flat top-down floorplan look. |
| `orthoZoom` | number | auto-fit | Orthographic zoom factor. |
| `section` | `SectionState` | — | Cross-section restored with the viewpoint. |
| `visibleLevels` | string[] \| null | `null` | Level ids visible in this preset. `null`/absent = all. |
| `default` | boolean | `false` | Applied when the card loads. Only one preset should set it. |
| `inTour` | boolean | `false` | Included in the auto-rotate slideshow. |

### Tour

Cycles through the saved views. Aimed at a wall tablet nobody is touching.

```yaml
tour:
  autoplay: true
  interval: 12
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `autoplay` | boolean | `false` | Start cycling on load. Never starts when the viewer has `prefers-reduced-motion` set. |
| `interval` | number | `12` | Seconds a view is held before flying to the next. Minimum `3` — a flight alone takes about a second. |
| `include` | `tagged` \| `all` | `tagged` | `tagged` visits presets marked `inTour`, falling back to all of them when none is marked. |
| `showControls` | boolean | `true` | Play/pause button and the per-view tour toggle. `false` removes all three (button, badge, toggle) together. |
| `pauseOnInteraction` | boolean | `true` | Stop as soon as the user moves the camera. |
| `resumeAfter` | number | `60` | Seconds of inactivity before it starts again. `0` = stay paused. |

### Section

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `none` \| `level` \| `plane` \| `box` | `none` | Which cutting technique is active. |
| `planes` | `ClipPlaneState[]` | one disabled plane per axis at `position: 0` | Used when `mode: plane`. |
| `levelId` | string \| null | `null` | Used when `mode: level`. |
| `box` | `{ min: [x,y,z], max: [x,y,z] }` | — | Used when `mode: box`; the AABB that is kept. |
| `caps` | boolean | `true` | Fill cut surfaces so walls read as solid. |
| `capColor` | string | `#8a8f98` | Colour of the cut caps. |
| `ghostAbove` | boolean | `false` | Fade levels above the active one instead of hiding them. |

#### `ClipPlaneState`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `axis` | `x` \| `y` \| `z` | — | Required. Plane normal. |
| `position` | number | `0` | World-space position along the axis, metres. |
| `enabled` | boolean | `false` | Whether this plane cuts. |
| `invert` | boolean | `false` | Keep the other half. |

### Entities

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `entity` | string | — | Required. Entity id. |
| `position` | `[x, y, z]` | — | Required. World position in metres, Y up. |
| `rotation` | `[x, y, z]` | `[0, 0, 0]` | Degrees; mainly for oriented markers and spots. |
| `level` | string \| null | auto | Storey id. Hidden when that level is hidden. `null` = derive from height. |
| `name` | string | friendly name | Label override. |
| `role` | see below | derived from the domain | Forces the visual treatment. |
| `light` | [`LightVisualConfig`](#light-options) | — | Only meaningful for the `light` role. |
| `marker` | [`MarkerConfig`](#marker-options) | — | Marker appearance. |
| `tap_action` | `ActionConfig` | `more-info` | What a tap does. |
| `hold_action` | `ActionConfig` | `more-info` | What a long press does. |
| `double_tap_action` | `ActionConfig` | none | What a double tap does. |
| `bindNode` | string | — | glTF node tinted/animated by this entity's state. |

`role`: `light`, `switch`, `sensor`, `binary_sensor`, `cover`, `climate`,
`media_player`, `camera`, `person`, `marker`.

#### Light options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `point` \| `spot` \| `rect` \| `emissive` | `point` *(engine default)* | Bulb, downlight, area panel, or glow-only. |
| `intensity` | number | `1` *(engine default)* | Multiplier on the intensity derived from brightness. |
| `distance` | number | `8` *(engine default)* | Falloff radius in metres. `0` = infinite. |
| `decay` | number | `2` *(engine default)* | Physical falloff exponent. |
| `angle` | number | `35` *(engine default)* | Spot only. Cone half-angle in degrees. |
| `penumbra` | number | `0.4` *(engine default)* | Spot only. Softness of the cone edge, 0–1. |
| `targetOffset` | `[x, y, z]` | `[0, -1, 0]` *(engine default)* | Spot only. Where the cone points, relative to the light. |
| `color` | string | — | Static colour override; ignored while the entity reports its own. |
| `useEntityColor` | boolean | `true` *(engine default)* | Let the entity's colour drive the light. |
| `castShadow` | boolean | `false` *(engine default)* | Request a real shadow map (max 4 active at once). |
| `fixture.show` | boolean | `true` *(engine default)* | Draw a visible luminaire body. |
| `fixture.radius` | number | `0.06` *(engine default)* | Luminaire radius, metres. |
| `fixture.emissive` | number | `2` *(engine default)* | Luminaire emissive strength. |
| `bloom` | number | `1` *(engine default)* | Per-light bloom weight. |
| `size` | `[width, height]` | `[1, 1]` *(engine default)* | Rect area light dimensions, metres. |

#### Marker options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `shape` | `auto` \| `pill` \| `dot` \| `icon` \| `label` \| `none` | `auto` | `auto` picks by role; `none` hides the marker while keeping the entity. |
| `showState` | boolean | `true` *(engine default)* | Show the state value. |
| `showName` | boolean | `true` *(engine default)* | Show the name. |
| `icon` | string | entity icon | MDI icon override. |
| `fixedSize` | boolean | `true` | Constant screen size. `false` = scales with distance. |
| `scale` | number | `1` *(engine default)* | Size multiplier. |
| `maxDistance` | number | — | Hide when the camera is further away than this, metres. |
| `color` | string | state colour | Marker tint. |
| `offset` | `[x, y, z]` | `[0, 0, 0]` | Lift the marker above the anchor point. |

#### Actions

`tap_action`, `hold_action` and `double_tap_action` take:

| Option | Type | Description |
| --- | --- | --- |
| `action` | `more-info` \| `toggle` \| `call-service` \| `perform-action` \| `navigate` \| `url` \| `preset` \| `none` | Required. |
| `entity` | string | Target entity; defaults to the placed entity. |
| `service` | string | For `call-service`, e.g. `light.turn_on`. |
| `perform_action` | string | For `perform-action` (the modern spelling). |
| `data` | map | Service data. |
| `target` | map | Service target (`entity_id` / `device_id` / `area_id`). |
| `navigation_path` | string | For `navigate`. |
| `url_path` | string | For `url`. |
| `preset_id` | string | For `preset`: the camera preset to fly to. |
| `confirmation.text` | string | Ask before performing the action. |

### Render

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `style` | `solid` \| `shaded` \| `wireframe` | `shaded` | `shaded` adds crisp architectural edge lines to solid surfaces. `wireframe` is a hidden-line drawing: surfaces still occlude, but only the lines are drawn — and nothing is lit, because there is no visible surface for a lamp to fall on. |
| `palette` | `model` \| `mono-light` \| `mono-dark` | `model` | `mono-*` flattens every surface to one neutral tone and drops textures, so the only colour left is the light your lamps cast. |
| `edgeColor` | string | `''` (theme) | Edge-line colour. Empty follows the dashboard theme — light ink on dark, dark on light. |
| `quality` | `low` \| `medium` \| `high` \| `auto` | `auto` | Tier picks shadow map size, pixel ratio and post-processing — never geometry. |
| `shadows` | boolean | `false` | Shadow maps. The single most expensive setting: a shadow-casting point light costs six cube-face passes per refresh. |
| `bloom` | boolean | `true` | Selective bloom on lit fixtures and emissive markers. |
| `bloomStrength` | number | `0.55` | Glow intensity. |
| `bloomRadius` | number | `0.5` | Glow spread. |
| `bloomThreshold` | number | `0.72` | Luminance above which pixels bloom. Lower = more glow. |
| `exposure` | number | `1.0` | ACES filmic tone-mapping exposure. |
| `ambientIntensity` | number | `0.34` | Base fill so an all-lights-off house is not pitch black. |
| `daylight` | boolean | `false` | Sun and sky rig. Off by default so the card looks the same at 3am as at noon and the lamps stay the only thing that changes. |
| `daylightEntity` | string | `sun.sun` | Entity whose elevation/azimuth drives the sun. |
| `background` | string | `''` (theme) | CSS colour behind the model. Empty follows the dashboard theme. |
| `maxPixelRatio` | number | `2` | Device pixel-ratio cap. Set to `1` on tablets. |
| `onDemand` | boolean | `true` | Idle the render loop when nothing changed. |
| `fpsLimit` | number | `60` | Frame cap while animating. |

### UI

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `authorTools` | `auto` \| `never` \| `always` | `auto` | Master switch for every authoring affordance — level selector, section panel, entity palette, inspector, save-view, edit toggle. `auto` shows them only in edit mode; `never` hides them even in a dashboard being edited (the wall-tablet case); `always` keeps them visible. It outranks the individual `show*` flags below. |
| `showToolbar` | boolean | `true` | Top toolbar. |
| `showToolbarInPanel` | boolean | `false` | Panel views are the wall-tablet case, where the saved views and the cube are the whole interface. Set `true` to keep the toolbar there. |
| `showPresetBar` | boolean | `true` | The saved-views strip — the primary navigation. |
| `showViewCube` | boolean | `true` | Orientation cube, top right. Click a face/edge/corner to snap, drag to orbit. |
| `showZoomSlider` | boolean | `true` | Vertical zoom control under the cube. |
| `levelPresets` | boolean | `true` | Add one generated isometric view per detected storey to the view bar. They follow the model, so they are not editable and never written to the config; saved views come first. |
| `showLevelSelector` | boolean | `false` | Opt-in lift-panel storey switcher. Saved views and `levelPresets` cover the same ground with less chrome. |
| `showSectionControls` | boolean | `false` | Cross-section controls. Shown anyway while author tools are visible. |
| `showLegend` | boolean | `false` | Colour/state legend. |
| `showFps` | boolean | `false` | FPS counter (diagnostics). |
| `compact` | boolean | `false` | Smaller chrome for narrow columns. |
| `theme` | `auto` \| `light` \| `dark` | `auto` | `auto` follows Home Assistant. |
| `height` | string | `520px` | Any CSS length. Ignored in panel mode. |
| `aspectRatio` | string | `''` | e.g. `16:9`. Overrides `height` when set. |

---

## Browser & performance notes

- **WebGL2 is required.** Every modern desktop and mobile browser has it; some
  locked-down kiosk browsers and very old Android WebViews do not. The card
  shows an explicit message rather than a black rectangle when it is missing.
- **Wall tablets.** Start with `render.quality: medium`, `maxPixelRatio: 1`,
  `shadows: false`, `onDemand: true` and `fpsLimit: 30`. That combination keeps
  an older Fire HD or iPad usable.
- **On-demand rendering** is the difference between a card that idles at ~0% GPU
  and one that pins a tablet's battery. Leave it on unless you are debugging.
- **Shadow budget.** Only four lights cast real shadows at once. Adding a
  fifth `castShadow: true` light does not cost more — it just means the engine
  picks a different four.
- **Model size is the real budget.** Aim for well under 300 k triangles and a
  handful of materials; see [`docs/model-guide.md`](docs/model-guide.md). The
  demo house is 4 646 triangles across 94 draw calls for comparison.
- **Texture formats.** Draco and meshopt compression are supported. KTX2/Basis
  textures are explicitly rejected with an actionable error — re-export those
  textures as PNG/JPEG.

## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for symptom → cause →
fix on black cards, 404/CORS failures, wrong scale or rotation, invisible
lights, hollow cross-sections, touch drag & drop and performance.

## Documentation

- [`docs/model-guide.md`](docs/model-guide.md) — getting a model of *your* house
  into the card: Sweet Home 3D, Blender, SketchUp, IFC/BIM, node naming, units,
  optimisation and Draco.
- [`docs/configuration.md`](docs/configuration.md) — every config block with
  worked examples.
- [`docs/troubleshooting.md`](docs/troubleshooting.md) — when it does not look
  right.

## Development

```bash
npm i          # install
npm run dev    # Vite dev server with a standalone harness
npm run build  # typecheck + single-file bundle in dist/
npm test       # vitest
npm run typecheck
```

The build inlines everything (three.js included) into
`dist/floorplan-3d-card.js`, targeting ES2021 so it runs on the Android WebView
versions the Home Assistant companion app ships.

Read [`ARCHITECTURE.md`](ARCHITECTURE.md) before contributing — it defines the
layer boundaries (`engine/` never imports from `card/`, `editor/` or `ha/`) that
keep the codebase coherent. Pull requests are welcome at
`https://github.com/USERNAME/floorplan-3d-card`; please keep `npm run build`
clean and add a vitest case for anything with logic in it.

## Licence

MIT — see [`LICENSE`](LICENSE).
