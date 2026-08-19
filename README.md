# Floorplan 3D Card

![Three storeys pulled apart, with the view navigator, toolbar and orientation cube](https://raw.githubusercontent.com/PetePete/floorplanhs/main/docs/images/exploded-view.png)

An interactive 3D floorplan for your Home Assistant dashboard. Point it at a
**Sweet Home 3D `.sh3d` file** of your own house and the card turns it into a
live view: lights that actually light the room they are in, cross-sections that
slice the building open, camera views you can fly between, and drag & drop
placement of entities straight onto the geometry. It is one self-contained ES
module, with no add-on, no backend and no external service: the card reads the
`hass` object it is handed and writes its own configuration back into your
dashboard YAML.

> **Sweet Home 3D is the tested route.** Everything here was built and reviewed
> against real `.sh3d` files. glTF/GLB loading is implemented and documented
> below, but it has had no real-world use yet — treat that path as unproven.

The card ships no house of its own: without a model it starts, finds nothing to
draw and says so.

This is a free, open-source alternative to the commercial 3D floorplan products
sold as smart-home add-ons. Nothing phones home, nothing is rendered in a cloud,
and your model file never leaves your Home Assistant instance.

---

## Features

- **Room lighting.** A `light` entity that is on lights its whole room, evenly
  and up to the walls — the reading a floorplan wants. Brightness, RGB colour
  and colour temperature from Home Assistant drive it, not a coloured icon.
  Switch to `lightMode: realistic` for physically based falloff instead.
- **Cross-sections.** Isolate one storey or slide cut planes along X/Y/Z, with
  solid cut caps so walls do not look like empty shells.
- **Camera presets.** Save a viewpoint (plus its cross-section and level
  visibility), give it a name and an icon, and fly to it in one tap. Optional
  slideshow tour and idle return.
- **Drag & drop placement.** Drag an entity onto the model in edit mode; it
  lands on the surface you dropped it on, on the correct level, and the position
  is written back to your YAML rounded to millimetres.
- **Markers & hotspots** for everything that is not a light: sensors, covers,
  climate, media players, people, scripts and scenes — with tap / hold /
  double-tap actions. Any entity can be placed; the chips above the palette are
  the domains a floorplan is usually filled with, and the search box reaches
  the rest.
- **On-demand rendering.** The render loop idles when nothing changes, which is
  what makes this usable on a wall tablet.
- **Visual editor.** Full GUI configuration with a live YAML preview; every
  option below is reachable without touching YAML.
- **Sweet Home 3D files load directly.** Point the card at a `.sh3d` and it
  reads it — no export, no conversion. See below for why that matters.

## Getting your house in

Two routes in, and they are not equals: the Sweet Home 3D one is what this card
was built and tested against.

### Sweet Home 3D (recommended, and the only tested route)

[Sweet Home 3D](https://www.sweethome3d.com/) is free, runs everywhere, and you
can trace your own floor plan over a scanned drawing without any 3D skills.
Draw the walls, drop in doors and windows, add storeys — then copy the saved
file straight into `config/www/`:

```yaml
model:
  url: /local/house.sh3d
```

**Save it, do not export it.** `.sh3d` is Sweet Home 3D's own format, and the
card reads it natively. That is deliberately the recommended route: `.sh3d`
carries the storeys, the room names and the wall structure, whereas Sweet Home
3D's OBJ export flattens everything into one mesh and the card then has to
guess where your floors are.

What comes across: storeys with their real heights and names, walls with their
thicknesses (curved walls included), rooms as named polygons, and doors and
windows as real openings with glass. Furniture is drawn as correctly sized,
correctly rotated blocks — position, footprint, height and angle all come from
the file.

What does not: textures and the photo-realistic look of Sweet Home 3D's own
renderer. This card has its own materials and lighting, so the result is
cleaner and more diagram-like — which is usually what you want on a dashboard.

Files saved by Sweet Home 3D **5.0 or newer** are supported. Older ones are
stored in a legacy binary format; open and re-save such a file once with a
current version.

### glTF / GLB

**Untested.** The loader is written and the options below are real, but no
actual export has been through it in anger. If you take this route, expect to
find bugs — and please report them.

Anything that exports glTF should work — Blender, SketchUp, IFC/BIM via
BlenderBIM or IfcOpenShell:

```yaml
model:
  url: /local/house.glb?v=3
```

Metres, Y up, Draco and meshopt compression supported, KTX2/Basis textures are
not. Name your nodes `<level>/<room>/<part>` and the card picks up your storeys
and rooms; otherwise it detects storeys from the geometry.

## Installation

### HACS

This is the way to install it. The repository is not in the HACS default store,
so it is added once by hand; after that it behaves like anything else in there,
updates included.

1. HACS → **Frontend** → ⋮ → **Custom repositories**.
2. Repository `https://github.com/PetePete/floorplanhs`, category **Lovelace**
   (newer HACS versions call it **Dashboard**). Add.
3. Open **Floorplan 3D Card** in the list and install it.
4. Reload the browser (Ctrl/Cmd + Shift + R).

HACS downloads the bundle from the [release
assets](https://github.com/PetePete/floorplanhs/releases) and registers the
dashboard resource for you. Every later release shows up as an update, and the
resource entry moves with it — which is the whole reason to prefer this over
copying the file around.

Your `.sh3d` still goes into `config/www/` by hand: it is your floor plan, and
no package manager can ship it for you. See [Quick start](#quick-start).

### Without HACS

For a build that has no release yet — a branch you are testing, or your own
working copy.

1. Build the bundle, or download `floorplan-3d-card.js` from the
   [latest release](https://github.com/PetePete/floorplanhs/releases):

   ```bash
   npm ci
   npm run build   # → dist/floorplan-3d-card.js
   ```

2. Copy it to `config/www/floorplan-3d-card.js` — that path is served as
   `/local/floorplan-3d-card.js`.
3. **Settings → Dashboards → ⋮ → Resources → Add resource**:

   | Field | Value |
   | ----- | ----- |
   | URL   | `/local/floorplan-3d-card.js?v=1` |
   | Type  | **JavaScript module** (`type: module`) |

   In YAML-mode dashboards:

   ```yaml
   resources:
     - url: /local/floorplan-3d-card.js?v=1
       type: module
   ```

   Bump the `?v=` query after every rebuild, or the browser will keep serving
   the old bundle. That bookkeeping is exactly what HACS takes off your hands.

Minimum Home Assistant version: **2024.4.0**.

## Quick start

The card ships no house, so it needs one line to be worth looking at — point it
at the `.sh3d` you copied into `config/www/`:

```yaml
type: custom:floorplan-3d-card
model:
  url: /local/haus.sh3d?v=1
```

Storeys, rooms and openings come out of the file. The card offers an
**Overview** of the whole building plus one view per storey it finds, so there
is nothing to declare before you can look around.

A fuller setup with levels, presets and placed lights:

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
ui:
  height: 560px
```

## How it works

### Lighting

A placed entity in the `light` domain is not a marker — it changes what the
model looks like. There are two ways it can do that, chosen with `lightMode`.

#### `lightMode: room` (default)

The lamp lights **the whole room it stands in**, evenly, stopping at the walls.
A dashboard answers "which rooms are on" at a glance, and that reading is
exactly what a physically correct light destroys: real falloff puts a bright
spot under the bulb and leaves the corners dark.

- **Which room.** Taken from the model: floors, ceilings and furniture carry
  their room from the file, and walls — which are merged into one mesh per
  storey, and in Sweet Home 3D carry no room at all — are classified per vertex
  by looking a few centimetres along the surface normal into the room the face
  points at. That is what makes a shared wall light on the correct side.
- **Cost.** The rooms are resolved once, at load, and baked into the geometry;
  a lit room is one array lookup per pixel.
- **Two lamps in one room** do not add up to twice the brightness. The colours
  mix, the strongest lamp sets the level.
- **Override** with `room:` on the placed entity when a lamp sits in a doorway
  and lands on the wrong side. Tune the overall level with `roomFillStrength`.

Rooms come from `userData.room`, or from `<level>/<room>/<part>` node names in
glTF. A model with no rooms at all falls back to no fill — use `realistic`.

#### `lightMode: realistic`

A real three.js light at the lamp position:

- **Brightness → candela.** Home Assistant's `brightness` (0–255) is mapped
  through a perceptual power curve (exponent 2.2) to a candela-like intensity,
  so dimming *looks* like dimming instead of collapsing to black halfway down.
- **Falloff.** Point and spot lights default to an **8 m falloff radius** rather
  than infinite range, with `decay: 2` (physically correct). That keeps a single
  bulb from washing out the whole model. `distance: 0` restores infinite range.

Both modes share the colour handling: `rgb_color`, `hs_color` and
`color_temp_kelvin` are converted to linear RGB. Set `useEntityColor: false`
plus a fixed `color` when you want a constant tint.

### Cross-sections

`section.mode` picks the technique:

- `level` — isolate one storey; everything above and below is clipped away.
- `plane` — up to three clipping planes, one per axis, draggable in the card.

Cut surfaces are filled with solid caps using a stencil pass so a sliced wall
reads as a wall. If the WebGL context has no stencil buffer available, the card
falls back to hollow shells rather than failing.

### Presets

A preset stores the camera position and target, and optionally the field of
view, the cross-section state and which levels were visible.
Frame the shot in the card, hit **Save current view** in the toolbar, and the
preset is written into your dashboard YAML. Presets with `inTour: true` are
included in the auto-rotate slideshow; the one with `default: true` is applied
on load.

### Drag & drop

The card follows the dashboard: put the dashboard in edit mode and the placement
tools appear, with no switch of the card's own to keep track of. A drop is
raycast against the building shell, so the entity lands on the surface under your
finger, gets the storey it fell into, and its position is rounded to millimetres
before being written back through `config-changed`. Touch is a first-class path —
this works with a finger, not just a mouse.

**Anchor and label are two things.** The dot is the entity — where the lamp
hangs, where its light comes from. The chip is a caption, and a plan is full of
places a caption reads better than directly on top of what it names. So drag the
**dot** to move the entity, and drag the **chip** to move only the label; a
leader line keeps saying which dot the chip belongs to. Nothing is lost either
way: the entity keeps its room and its level while its label goes wandering.

**Where it sticks.** In the dashboard's edit mode, where you placed it. Home
Assistant gives every view a `lovelace` object that owns the dashboard config
and can save it, so the card writes the placement into its own YAML directly —
full-size view, no postage-stamp preview to aim in. Three conditions, and each
one is deliberate:

| | |
| --- | --- |
| Dashboard in **edit mode** | The state that put the placement tools on screen in the first place. |
| A **storage** dashboard | A YAML dashboard is your file; the card does not rewrite it. Copy the block from the editor's YAML preview instead. |
| This card **identifiable** in the config | With two identical floorplan cards and nothing to tell them apart, saving would move the lamp on the wrong one. |

The card editor works too — its preview hands each drop to the editor, which is
the only thing Lovelace takes a config from in that dialog. If none of the
routes are open, the drop still applies to what is on screen and the card says
once that it is not saved, rather than letting you find out after a reload.

---

## Configuration reference

Every option, straight from `src/types/config.ts`. Options marked *(engine
default)* have no explicit value in the YAML schema; the listed value is what
the engine uses when the key is absent.

### Key naming

**Option names are camelCase — `levelPresets`, `showToolbar`, `roomFillStrength`.**
The snake_case spelling of every one of them (`level_presets`, `show_toolbar`,
`room_fill_strength`) is accepted as well, because most Home Assistant cards use it
and reaching for it is a reasonable reflex.

camelCase is the canonical form for one concrete reason: this card **writes its
own configuration back**. Saving a view or dropping an entity onto the model
emits YAML, and what it emits is camelCase. If snake_case were canonical, your
file would be quietly rewritten the first time you saved anything.

The one deliberate exception is the action block — `tap_action`, `hold_action`,
`double_tap_action`, `navigation_path`, `url_path`. Those mirror Home
Assistant's own action schema field for field, so they keep its spelling; using
a different one there would be worse than the inconsistency.

### Top level

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `type` | string | — | Required. `custom:floorplan-3d-card`. |
| `title` | string | — | Optional heading rendered above the view. |
| `model` | [`ModelConfig`](#model) | — | Where the geometry comes from and how it is placed. Without it the card renders nothing and says so. |
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
| `url` | string | — | `/local/house.sh3d` (Sweet Home 3D) or `/local/house.glb` (glTF/GLB). The bytes decide the format, so a `.sh3d` under the wrong extension still loads. |
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

**Which view the card opens in**, in this order:

1. The preset marked `default: true`.
2. Otherwise the **first** preset in the list — so the order of `presets:`
   decides, and saving a storey view as your first one makes that storey the
   opening view.
3. With no presets at all: the whole building, framed to fit. That is the
   *Overview*, and it is what an unconfigured card does.

Independently of the camera, `section:` from the config is applied first. A
`section.mode: level` in the YAML opens on that storey no matter which preset
runs — if the card starts in a storey you did not expect, look there before the
presets.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | string | — | Required. Referenced by `action: preset`. |
| `name` | string | — | Required. Label in the preset bar. |
| `icon` | string | — | MDI icon. |
| `position` | `[x, y, z]` | — | Required. Camera position in metres. |
| `target` | `[x, y, z]` | — | Required. Look-at point. |
| `fov` | number | inherits `camera.fov` | Per-preset field of view. |
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
| `mode` | `none` \| `level` \| `plane` | `none` | Which cutting technique is active. |
| `planes` | `ClipPlaneState[]` | one disabled plane per axis at `position: 0` | Used when `mode: plane`. |
| `levelId` | string \| null | `null` | Used when `mode: level`. |
| `caps` | boolean | `true` | Fill cut surfaces so walls read as solid. |
| `capColor` | string | `#8a8f98` | Colour of the cut caps. |

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
| `tap_action` | `ActionConfig` | `toggle`, or nothing | What a tap does. Entities that can be operated (lights, switches, covers, …) toggle; entities you can only read do nothing, because a floorplan on a wall gets touched by people walking past and a sensor is not a control. Set `more-info` to open the dialog on tap. |
| `hold_action` | `ActionConfig` | `more-info` | What a long press does. Opens the dialog for anything, so nothing is out of reach. |
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
| `fixture.show` | boolean | `true` *(engine default)* | Draw a visible luminaire body. |
| `fixture.radius` | number | `0.06` *(engine default)* | Luminaire radius, metres. |
| `fixture.emissive` | number | `2` *(engine default)* | Luminaire emissive strength. |
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
| `offset` | `[x, y, z]` | `[0, 0.34, 0]` | Where the label sits, in metres from the anchor. Set by dragging the label itself; the leader line follows it back to the entity. |

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

### Shortcuts

Entities that belong to the house but not to a *place* in it — a script is an
errand ("good night", "leave home"), not a thing hanging on a wall. Pinning one
to a spot on the floor says something false about it, and puts it behind
whichever wall the camera is on the wrong side of. These sit in a panel under
the navigator instead, in the order you put them.

```yaml
shortcuts:
  - script.good_night
  - entity: scene.movie
    name: Film
    icon: mdi:movie
```

Drag one there from the entity palette in edit mode, or write it by hand. A tap
runs it — `script.turn_on`, not `toggle`, so a running script is not stopped
half way. Anything can go there, not only scripts: a scene, a switch you reach
for constantly. What decides is whether it belongs *somewhere*.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `entity` | string | — | Required. Entity id. A bare string is the whole item. |
| `name` | string | the entity's own | Label in the panel. |
| `icon` | string | from the domain | MDI icon. |
| `tap_action` | `ActionConfig` | `toggle` | What a tap does. |
| `hold_action` | `ActionConfig` | `more-info` | What a long press does. |

### Render

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `style` | `solid` \| `wireframe` | `wireframe` | `wireframe` is a hidden-line drawing: surfaces still occlude what is behind them, but only the edges are painted. `solid` is shaded surfaces with no edge lines. A lit room reads in both — the fill is washed onto the floor area. |
| `palette` | `model` \| `mono-light` \| `mono-dark` | `model` | `mono-*` flattens every surface to one neutral tone and drops textures, so the only colour left is the light your lamps cast. Pair with the opposite `background` — `mono-dark` on a dark theme is invisible. |
| `lightMode` | `room` \| `realistic` | `room` | `room` lights the whole room a lamp stands in, evenly and up to its walls. `realistic` puts a physically based light at the lamp instead: inverse-square falloff, a hotspot underneath and dark corners. |
| `roomFillStrength` | number | `1` | How strongly a lit room is tinted, 0–2. Only used by `lightMode: room`. |
| `edgeColor` | string | `''` (theme) | Edge-line colour. Empty follows the dashboard theme — light ink on dark, dark on light. |
| `quality` | `low` \| `medium` \| `high` \| `auto` | `auto` | Tier picks pixel ratio and antialiasing — never geometry. |
| `toneMapping` | `aces` \| `linear` \| `none` | `aces` | The filmic curve, and what the card is tuned against. `linear` applies `exposure` and nothing else, so a surface comes out exactly the colour you gave it — flatter, and a fair choice for a pure line drawing. |
| `exposure` | number | `1.0` | Brightness multiplier. Ignored by `toneMapping: none`. |
| `ambientIntensity` | number | `0.34` | Base fill so an all-lights-off house is not pitch black. |
| `background` | string | `transparent` | `transparent` lets the card show through; `light` / `dark` pin a neutral backdrop against the theme; `system` follows the theme but stays opaque. Any CSS colour also works. |
| `maxPixelRatio` | number | `2` | Device pixel-ratio cap. Set to `1` on tablets. |
| `onDemand` | boolean | `true` | Idle the render loop when nothing changed. |
| `fpsLimit` | number | `60` | Frame cap while animating. |

### UI

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `authorTools` | `auto` \| `never` \| `always` | `auto` | Master switch for every authoring affordance — section panel, entity palette, inspector, save-view. The card follows the *dashboard's* edit mode; it has no switch of its own. `auto` shows the tools while the dashboard is being edited; `never` hides them even then (the wall-tablet case); `always` keeps them visible. It outranks the individual `show*` flags below. |
| `room` *(per entity)* | string | — | The room this entity belongs to. Sets which room a light fills in `lightMode: room`, and draws a leader line back to that room when the entity is placed outside it. |
| `snapPlacement` | boolean | `false` | Drop an entity where you dropped it (default), or move it to the height the fixture would really sit at — a light to the ceiling, a switch to 1.10 m. |
| `showCeilings` | boolean | `true` | Draw the ceiling slabs. Off is often the better floorplan: a ceiling is the one surface you never look at, and in a plan or exploded view it is all you see of the storey below it. |
| `explode` | number | `0` | Pull the storeys apart along Y by this many metres per step, so you can see into all of them at once. Everything moves together — geometry, room tints, markers and their leader lines, and the cross-section. Positions in the config stay the real ones. |
| `explodeDuration` | number | `0.7` | Seconds the storeys take to travel when the exploded view is switched on or off. `0` puts them straight there. |
| `showToolbar` | boolean | `true` | Top toolbar. |
| `showPresetBar` | boolean | `false` | The old saved-views strip along the bottom. The side panel carries the same views; this brings the strip back for its drag-reordering and per-view tour toggle. |
| `showViewCube` | boolean | `true` | Orientation cube, top right. Click a face/edge/corner to snap, drag to orbit. |
| `showZoomSlider` | boolean | `true` | Vertical zoom control under the cube. |
| `levelPresets` | boolean | `true` | Add one generated isometric view per detected storey to the view bar. They follow the model, so they are not editable and never written to the config; saved views come first. |
| `showLevelSelector` | boolean | `true` | The navigator down the side: the building, its storeys, and your saved views. This is the card's navigation. The chevron in its corner folds it down to a single chip showing where you are, for when it is over the part of the house you are looking at. On a narrow card it starts folded, since the panel is a third of a phone screen; unfold it once and that choice stands. The fold lasts the session, not the config. |
| `showSectionControls` | boolean | `false` | Cross-section controls. Shown anyway while author tools are visible. |
| `showFps` | boolean | `false` | FPS counter (diagnostics). |
| `theme` | `auto` \| `light` \| `dark` | `auto` | Which way round the card's own chrome and line work are drawn. `auto` follows Home Assistant; the other two overrule it, for a drawing that has to read on a wall tablet in daylight whatever theme the dashboard is wearing. Entity colours still come from the dashboard's palette. |
| `height` | string | `520px` | Any CSS length. Ignored in panel mode. |
| `aspectRatio` | string | `''` | e.g. `16:9`. Overrides `height` when set. |

---

## Browser & performance notes

- **WebGL2 is required.** Every modern desktop and mobile browser has it; some
  locked-down kiosk browsers and very old Android WebViews do not. The card
  shows an explicit message rather than a black rectangle when it is missing.
- **Wall tablets.** Start with `render.quality: medium`, `maxPixelRatio: 1`,
  `onDemand: true` and `fpsLimit: 30`. That combination keeps
  an older Fire HD or iPad usable.
- **On-demand rendering** is the difference between a card that idles at ~0% GPU
  and one that pins a tablet's battery. Leave it on unless you are debugging.
## Troubleshooting

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for symptom → cause →
fix on black cards, 404/CORS failures, wrong scale or rotation, invisible
lights, hollow cross-sections, touch drag & drop and performance.

## Documentation

- [`docs/model-guide.md`](docs/model-guide.md) — getting a model of *your* house
  into the card: Sweet Home 3D and `.sh3d`, Blender, SketchUp, IFC/BIM, node
  naming, units, optimisation and Draco.
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
`https://github.com/PetePete/floorplanhs`; please keep `npm run build`
clean and add a vitest case for anything with logic in it.

## Coffee

This card is free, ad-free, and staying that way. Nothing phones home, there is
no account and no upsell. If it earns a place on your dashboard and you feel
like it, buy me a coffee:

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-%E2%98%95-FFDD00?style=for-the-badge)](https://buymeacoffee.com/petepete)

<https://buymeacoffee.com/petepete>

## Licence

**GPL-3.0-or-later** — see [`LICENSE`](LICENSE).

Use it, run it, change it, pass it on. What the GPL adds over a permissive
licence is one condition: if you distribute a modified version, it goes out
under the GPL too, with its source. A card someone improved should come back
improvable.

Third-party components keep their own licences, and both are redistributed
inside `dist/floorplan-3d-card.js`:

| Component | Licence | Text |
| --- | --- | --- |
| [three.js](https://threejs.org/) | MIT | [`licenses/MIT-three.js.txt`](licenses/MIT-three.js.txt) |
| [Lit](https://lit.dev/) | BSD-3-Clause | [`licenses/BSD-3-Clause-lit.txt`](licenses/BSD-3-Clause-lit.txt) |
| [fflate](https://github.com/101arrowz/fflate) | MIT | [`licenses/MIT-fflate.txt`](licenses/MIT-fflate.txt) |
| Chakra Petch (Cadson Demak) | SIL Open Font License 1.1 | [`licenses/OFL-ChakraPetch.txt`](licenses/OFL-ChakraPetch.txt) |

Each of those notices also rides in the bundle's own header, because a
`LICENSE` in a repository never reaches the person who installs the file.

The font is embedded as a base64 `woff2` rather than fetched from a CDN — a
Home Assistant instance may have no route to the internet, and a font request
would tell a third party about every dashboard load.
