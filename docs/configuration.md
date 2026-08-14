# Configuration

Every block of the card config, with worked examples. The complete option
tables — types and defaults — live in the
[README config reference](../README.md#configuration-reference); this document
is about *how the pieces fit together*.

Everything here can also be set in the visual editor (⋮ → Edit card). The
editor's **Show YAML** toggle prints exactly what it will write.

---

## The smallest possible card

```yaml
type: custom:floorplan-3d-card
```

No model, no entities, no camera: the card builds the procedural demo house
(levels `basement`, `ground`, `upper`), frames it, and starts rendering. Use it
to confirm the resource is loaded before you debug your own model.

---

## `model`

Where the geometry comes from and how it is placed in world space.

```yaml
model:
  url: /local/house.glb?v=4
  scale: 1
  rotation: [0, 0, 0]
  offset: [0, -0.15, 0]
  glassNodes: [window, glass, "*_pane"]
  dracoPath: /local/draco/
```

- `url` — absent (or `demo: true`) means the demo house. `config/www/x.glb` is
  served as `/local/x.glb`; bump `?v=` after every re-export or the browser will
  serve a stale file.
- `plan` — build the house from a floor plan instead of loading a mesh. See
  [`model.plan`](#modelplan) below.
- `scale` — 1 world unit is 1 metre. A model authored in centimetres needs
  `0.01`.
- `rotation` — degrees, applied XYZ. A Z-up export needs `[-90, 0, 0]`.
- `offset` — metres. Use it to put the finished floor of the ground level at
  `y = 0`.
- `glassNodes` — node-name patterns whose materials become transmissive. Without
  this, opaque window panes hide the entire interior.
- `dracoPath` — only for Draco-compressed files; the trailing slash matters.
  Meshopt-compressed files need nothing. KTX2/Basis textures are rejected with
  an explicit error — re-export those as PNG/JPEG.

See [`model-guide.md`](model-guide.md) for how to produce the file.

## `model.plan`

If what you have is a floor plan and a ruler rather than a 3D model, describe the
building and let the card build it. No modelling tool, no export, no upload.

```yaml
model:
  plan:
    units: m
    exteriorWall: 0.30      # defaults: 0.33 exterior, 0.15 interior, 0.30 slab
    interiorWall: 0.12
    levels:
      - id: ground
        name: Ground floor
        elevation: 0        # finished floor level; ground floor is 0
        height: 2.80        # floor to floor
        # Closed polygon of the OUTER face, in metres. +X is east and +Z is
        # south, so north is -Z. Put the origin on the north-west corner and
        # every number stays positive; the card recentres the result.
        outline: [[0, 0], [12, 0], [12, 8], [0, 8]]
        rooms:
          # Each room is its CLEAR INTERIOR as [x1, z1, x2, z2]. Leave exactly
          # `interiorWall` between two rooms and the partition between them is
          # built for you — once, however many rooms touch it.
          - { id: hall, rect: [0.30, 0.30, 1.50, 7.70] }
          - { id: kitchen, rect: [1.62, 0.30, 6.00, 3.50], wet: true }
          - { id: living, rect: [1.62, 3.62, 11.70, 7.70] }
          # `openTo` suppresses the partition, for an open-plan space:
          - { id: dining, rect: [6.12, 0.30, 11.70, 3.50], openTo: [kitchen] }
        openings:
          # `at` is the plan coordinate along the facade — x for a north/south
          # wall, z for east/west. `sill` is above the finished floor.
          - { kind: window, wall: s, at: 4.00, width: 2.00, sill: 0.90 }
          - { kind: sliding, wall: n, at: 8.00, width: 2.40 }
          - { kind: door, wall: w, at: 2.00, width: 1.10 }
          # An interior door needs no coordinates at all:
          - { kind: door, wall: { between: [hall, living] }, width: 0.90 }
        stairs:
          - { id: stairs, room: hall, from: [0.90, 6.90], to: [0.90, 1.50],
              width: 1.10, steps: 15 }
    roof:
      kind: mono            # or `gable`, or `flat`
      highSide: n
      eaveHeight: 4.40      # absolute, same scale as `elevation`
      ridgeHeight: 5.60
      overhang: 0.30
    site:
      - { id: terrace, kind: terrace, rect: [0, -4, 12, 0], level: -0.10 }
```

The full field list, with defaults and the two other ways to name a wall, is in
`src/engine/model/plan-types.ts` — every field is documented there.

A plan can also live **outside** the repository and be loaded by path, which is
what you want for a real building you would rather not publish:

```yaml
model:
  plan: /local/haus-plan.json
```

Source precedence is `demo: true` > `plan` > `url`. Anything that fails — a
missing file, malformed JSON, a plan the validator rejects — falls back to the
demo house with the reason shown on the card, naming the exact path inside the
plan that is wrong.

## `model.levels`

Storeys drive the level selector, the *isolate level* cross-section, and the
`level` field on every placed entity.

```yaml
model:
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
      nodes: [upper, roof_dormer]
```

- Levels are **half-open ranges**: `[elevation, elevation + height)`. Give
  `ground` `elevation: 0`, `height: 2.9` and `upper` `elevation: 2.9` and there
  is no gap and no overlap.
- `id` is what presets (`visibleLevels`) and entities (`level`) reference. Keep
  it short and stable — renaming it orphans those references.
- `nodes` lists glTF node names belonging to the level. Omit it and membership
  is derived from geometry bounds.

**Omit `levels` entirely** and the card auto-detects them: it reads
`userData.level`, then the first segment of `<level>/<room>/<part>` node names,
then the `level_` / `floor_` / `storey_` / `EG` / `OG` / `UG` / `L0` / `L1`
prefixes, and finally clusters floor-slab heights. Auto-detection is a good
default but produces generic names — define levels explicitly as soon as you
start writing presets.

Press **Auto-detect levels** in the editor's Model tab to clear an explicit list
and go back to detection.

---

## `camera`

How the orbit control behaves. Nothing here sets *where* the camera is — that is
what presets are for.

```yaml
camera:
  fov: 45
  near: 0.1
  far: 500
  minDistance: 2
  maxDistance: 60
  damping: 0.08
  transitionDuration: 1.1
  autoRotate: false
  autoRotateSpeed: 0.4
  idleReturnAfter: 120
```

- `maxPolarAngle` is in **radians** in YAML (default `1.5508`, i.e. just under
  90°, so the user cannot orbit under the floor). The editor shows and writes it
  in degrees for you.
- `idleReturnAfter: 120` returns to the default preset after two minutes of no
  interaction — the setting you want on a wall tablet in a hallway.
- `transitionDuration: 0` makes preset switches instant.

---

## `presets`

A preset is a named viewpoint plus, optionally, the cross-section and level
visibility that go with it.

```yaml
presets:
  - id: overview
    name: Overview
    icon: mdi:home
    position: [12.5, 9.0, 12.5]
    target: [0, 1.2, 0]
    default: true
    inTour: true

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
    inTour: true

  - id: kitchen
    name: Kitchen
    icon: mdi:silverware-fork-knife
    position: [-1.2, 2.1, 3.4]
    target: [-2.6, 1.4, 0.2]
    fov: 60
```

### Capturing presets from the UI

Do not type coordinates. Instead:

1. Open the card and orbit/zoom until the view is what you want.
2. Optionally set the level selector and cross-section too.
3. **Save current view** in the card toolbar.
4. The preset is appended to your config through `config-changed`, with the
   position and target rounded to three decimals.
5. Rename it, give it an icon and set `default` / `inTour` in the editor's
   **Presets** tab.

That is why the Presets tab shows position and target read-only: a hand-typed
camera almost never frames the shot you were imagining, and there is a one-click
alternative.

### Notes

- Exactly one preset should have `default: true`; it is applied on load. With
  none, the card frames the whole house.
- `visibleLevels: null` (or absent) means all levels. `visibleLevels: [ground]`
  restores that selection with the viewpoint.
- `orthographic: true` gives the flat "architect's floorplan" look. Pair it with
  a top-down `position` and a tiny Z offset (`0.01`) so the up-vector stays
  well-defined.
- Jump to a preset from anywhere with an action:

  ```yaml
  tap_action:
    action: preset
    preset_id: kitchen
  ```

---

## `section`

The cross-section state the card starts in. Users can still change it live; only
what you write here is persisted.

**Isolate one storey** — the most common setup:

```yaml
section:
  mode: level
  levelId: ground
  caps: true
  capColor: "#8a8f98"
  ghostAbove: true
```

**Cut planes** — a doll's-house slice:

```yaml
section:
  mode: plane
  planes:
    - axis: y
      position: 2.4
      enabled: true
      invert: false
    - axis: x
      position: 0
      enabled: false
      invert: false
    - axis: z
      position: 0
      enabled: false
      invert: false
  caps: true
```

**Clip box** — keep only one room:

```yaml
section:
  mode: box
  box:
    min: [-4.2, 0, -3.0]
    max: [0.5, 2.9, 2.4]
  caps: true
```

- `caps: true` fills the cut surfaces so a sliced wall reads as a solid wall.
  This uses a stencil pass; if the WebGL context has no stencil buffer, the card
  degrades gracefully to hollow shells instead of failing.
- `ghostAbove: true` fades the levels above the active one instead of hiding
  them — good for understanding how storeys stack.
- `invert: true` keeps the other half of a plane cut.
- The box is easiest to produce by dragging its handles in the card and saving a
  preset; the editor does not ask you to type an AABB.

---

## `entities`

Entities anchored to a point in the model. The `light` domain becomes real
illumination; everything else becomes a marker.

The easy way to add these is drag & drop: put the dashboard in edit mode and
drag an entity onto the 3D view. It lands on the surface under your finger, is
assigned the level it fell into, and its position is rounded to millimetres.
The **Entities** tab is for fine-tuning afterwards.

### A full light example

```yaml
entities:
  - entity: light.kitchen_ceiling
    name: Kitchen downlights
    level: ground
    position: [-2.15, 2.62, 1.4]
    light:
      kind: spot
      angle: 48
      penumbra: 0.5
      intensity: 1.2
      distance: 8
      decay: 2
      targetOffset: [0, -1, 0]
      useEntityColor: true
      castShadow: true
      bloom: 1.2
      fixture:
        show: true
        radius: 0.07
        emissive: 2.5
    marker:
      shape: dot
      showState: false
    tap_action:
      action: toggle
    hold_action:
      action: more-info
```

How the light behaves:

- **Brightness → candela** through a perceptual power curve (exponent 2.2), so
  dimming looks linear to the eye. `intensity` multiplies the result.
- **Colour** comes from the entity (`rgb_color`, `hs_color`,
  `color_temp_kelvin`) while `useEntityColor: true`. Set it to `false` and give a
  fixed `color` for a light that should always be, say, warm white.
- **`distance: 8`** is the default falloff radius — deliberately *not* infinite,
  so one bulb does not wash out the whole model. `distance: 0` restores infinite
  range.
- **`castShadow: true`** requests a real shadow map. At most **four** lights cast
  shadows at once on the high quality tier; the engine picks them by brightness
  and camera proximity. A fifth costs nothing, it just may not be chosen.
- **The luminaire** (`fixture`) is a small emissive body drawn at the light
  position, on the selective-bloom layer — that is what glows when the light is
  on. A bright wall never blooms.

Light kinds:

| `kind` | Use for | Key options |
| --- | --- | --- |
| `point` | bulbs, table lamps | `distance`, `decay` |
| `spot` | downlights, wall washers | `angle`, `penumbra`, `targetOffset` |
| `rect` | LED panels, light coves | `size: [w, h]` |
| `emissive` | strips bound to geometry | no illumination, only glow — pair with `bindNode` |

### Non-light entities

```yaml
entities:
  - entity: sensor.living_room_temperature
    position: [3.4, 1.5, 2.1]
    level: ground
    marker:
      shape: pill
      showName: true
      showState: true
      maxDistance: 18

  - entity: binary_sensor.front_door
    position: [-0.4, 1.1, 5.2]
    level: ground
    marker:
      shape: icon
      icon: mdi:door
      color: "#e5b400"

  - entity: cover.garage_door
    position: [-5.2, 1.1, 4.8]
    level: ground
    tap_action:
      action: toggle
    hold_action:
      action: more-info

  - entity: media_player.living_room
    position: [2.2, 0.9, -2.4]
    level: ground
    bindNode: ground/living/tv_screen
    tap_action:
      action: navigate
      navigation_path: /lovelace/media
```

- `role` overrides the visual treatment derived from the domain. `role: marker`
  turns anything into a plain labelled point.
- `marker.shape: none` keeps the entity interactive (and its light, if any)
  without drawing a label.
- `marker.fixedSize: false` makes markers shrink with distance instead of
  staying a constant screen size.
- `bindNode` ties a glTF node to the entity's state — the node is tinted or
  animated as the entity changes. Use the full node path,
  `ground/living/tv_screen`.
- `level: null` (or omitting it) derives the storey from the Y position.

### Actions

`tap_action`, `hold_action` and `double_tap_action` follow the standard Lovelace
shape, plus one extra action type:

```yaml
tap_action:
  action: call-service
  service: light.turn_on
  target:
    entity_id: light.kitchen_ceiling
  data:
    brightness_pct: 60
  confirmation:
    text: Turn the kitchen lights to 60%?

hold_action:
  action: preset
  preset_id: kitchen        # fly the camera to a saved viewpoint
```

Available actions: `more-info` (default), `toggle`, `call-service`,
`perform-action`, `navigate`, `url`, `preset`, `none`.

---

## `render`

```yaml
render:
  quality: auto
  shadows: true
  bloom: true
  bloomStrength: 0.55
  bloomRadius: 0.5
  bloomThreshold: 0.72
  exposure: 1.0
  ambientIntensity: 0.28
  daylight: true
  daylightEntity: sun.sun
  background: ""
  maxPixelRatio: 2
  onDemand: true
  fpsLimit: 60
```

- `quality` picks a tier: shadow map size, pixel ratio and post-processing.
  `auto` decides from the device. It never reduces geometry. The `low` tier
  disables post-processing, so bloom will not appear there regardless of
  `bloom: true`.
- `daylight` adds a sun/sky rig driven by `daylightEntity`'s `elevation` and
  `azimuth` attributes. Point it at `sun.sun` (the default) and the model gets
  darker in the evening on its own.
- `ambientIntensity` is the base fill that keeps an all-lights-off house
  readable. Raise it if your interiors are too dark; lower it for drama.
- `exposure` is the ACES filmic tone-mapping exposure — the correct knob for
  "everything is slightly too bright/dark", in preference to touching every
  light.
- `background: ""` follows the dashboard theme. Any CSS colour works.
- `onDemand: true` idles the render loop when nothing changed. Leave it on.

A tablet-friendly profile:

```yaml
render:
  quality: medium
  shadows: false
  bloom: true
  maxPixelRatio: 1
  onDemand: true
  fpsLimit: 30
```

---

## `ui`

```yaml
ui:
  showToolbar: true
  showPresetBar: true
  showLevelSelector: true
  showSectionControls: true
  showLegend: false
  showFps: false
  compact: false
  theme: auto
  height: 560px
  aspectRatio: ""
```

- `height` accepts any CSS length and is ignored in panel mode.
- `aspectRatio` (`16:9`, `4:3`, …) overrides `height` when set — better for
  responsive dashboards viewed on both phone and desktop.
- `compact: true` shrinks the chrome for narrow columns.
- `theme: auto` follows Home Assistant's light/dark mode.
- A kiosk-style card with no controls at all:

  ```yaml
  ui:
    showToolbar: false
    showPresetBar: false
    showLevelSelector: false
    showSectionControls: false
  camera:
    autoRotate: true
    autoRotateSpeed: 0.25
  ```

---

## `config_version`

Written by the card's migrations (current version: `1`). Do not edit it by hand;
if you downgrade the card below the version that wrote your config, the older
build will not understand it.
