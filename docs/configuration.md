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

No model, no entities, no camera: the card starts, finds nothing to draw and
says so. That is the quickest way to confirm the resource is loaded before you
debug your own model — add `model.url` and the house appears.

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

- `url` — a Sweet Home 3D save (`.sh3d`) or a glTF/glb mesh. Without it there
  is nothing to draw. `config/www/x.sh3d` is served as
  `/local/x.sh3d`; bump `?v=` after every re-save or the browser will serve a
  stale file. The bytes decide the format, so a `.sh3d` under the wrong
  extension still loads.
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

- `caps: true` fills the cut surfaces so a sliced wall reads as a solid wall.
  This uses a stencil pass; if the WebGL context has no stencil buffer, the card
  degrades gracefully to hollow shells instead of failing.
- `showCeilings: false` drops the ceiling slabs, line work included. Worth it in
  a plan or exploded view, where the ceiling is all you can see of the storey
  under it — and it opens each storey from above, so you look into the rooms.
- `explode` pulls the storeys apart along Y, an assembly drawing rather than a
  house:

  ```yaml
  ui:
    explode: 2.8           # metres of separation per storey; 0 is off
    explodeDuration: 0.7   # seconds the storeys take to travel; 0 is instant
  ```

  The toolbar has a toggle for it, which uses a storey height when nothing is
  configured. It is a *view*: everything in world space moves together —
  geometry, edge lines, room tints, markers and their leader lines, and the
  level cut — while positions written back to the config stay the real ones. A
  marker dropped on a storey that is drawn three metres up is still recorded at
  the height the building actually has.

  The storeys travel rather than jump, so you can see which one went where;
  `explodeDuration: 0` puts them straight there if you would rather they did.
- `ghostAbove: true` fades the levels above the active one instead of hiding
  them — good for understanding how storeys stack. It also applies to the
  per-storey views the card generates itself (`ui.levelPresets`), together with
  `caps`: the `section` block is the one place that decides how a storey is
  presented.

  A saved preset carries its own `section`, so ghosting can differ from view to
  view. When you would rather decide once for the whole card, set
  **`ui.ghostAbove`** — it outranks every preset:

  ```yaml
  ui:
    ghostAbove: false    # never; `true` = always; omit = let each preset decide
  ```
- `invert: true` keeps the other half of a plane cut.

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
  toneMapping: aces
  exposure: 1.0
  ambientIntensity: 0.28
  background: ""
  maxPixelRatio: 2
  onDemand: true
  fpsLimit: 60
```

- `quality` picks a tier: pixel ratio and antialiasing. `auto` decides from the
  device. It never reduces geometry, and it never changes how the card looks —
  only how finely it is sampled.
- `ambientIntensity` is the base fill that keeps an all-lights-off house
  readable. Raise it if your interiors are too dark; lower it for drama.
- `exposure` is the brightness multiplier — the correct knob for "everything is
  slightly too bright/dark", in preference to touching every light. It is
  applied by `toneMapping`, which defaults to `aces`, the filmic curve the card
  is tuned against. `linear` applies the exposure and nothing else, so colours
  come out exactly as authored; `none` ignores exposure too.
- `background` takes four keywords besides a plain CSS colour:

  | Value | Behaviour |
  | --- | --- |
  | `transparent` (default, also `""` / `none`) | The canvas stays transparent and the Home Assistant card shows through, so the view matches the theme in both polarities. |
  | `light` | Opaque light neutral, regardless of the theme. |
  | `dark` | Opaque dark neutral, regardless of the theme. |
  | `system` (also `auto`) | Opaque, but picks light or dark from the dashboard theme. |

  Pin it with `light` or `dark` when using a mono palette: `palette: mono-dark`
  on a dark dashboard is a dark model on a dark ground and reads as nothing at
  all. The edge ink follows the resolved backdrop, so it flips with the
  keyword — `background: light` gives dark lines even on a dark theme.
- `lightMode` decides what a lit lamp does to the model:

  ```yaml
  render:
    lightMode: room        # default; the whole room lights up
    roomFillStrength: 1    # 0 = off, 2 = double
  ```

  `room` needs the model to *have* rooms. Sweet Home 3D files always do — name
  your rooms in the app and they come across. For glTF, name your nodes
  `<level>/<room>/<part>`. Without rooms nothing lights and you want
  `lightMode: realistic`.

  A lamp is assigned to the room its position falls in. When one sits in a
  doorway or a wall recess and picks the wrong side, name the room explicitly:

  ```yaml
  entities:
    - entity: light.hall_ceiling
      position: [1.1, 2.4, 3.2]
      room: hall
  ```

  `room` does a second job for anything placed *outside* the room it names: the
  marker draws a leader line back to it, the way a drawing labels a part it has
  no space to write inside. That is how to get a legible column of temperature
  readings without covering the plan:

  ```yaml
  entities:
    - entity: sensor.kitchen_temperature
      position: [8.0, 0.1, -2.0]   # clear of the building
      room: kitchen
    - entity: sensor.living_temperature
      position: [8.0, 0.1, -0.8]
      room: living
  ```

  The line appears on its own once the marker is more than about half a metre
  from the room, measured in plan — a sensor mounted high on that room's own
  wall does not get one. `marker.leader: true` or `false` overrules that.

  You do not have to type any of it. In edit mode, **drag the marker out of its
  room** and drop it beside the building: the drop records the room it came
  from and the leader appears. There is no ground plane in the model, so a drop
  beside the house lands on a horizontal plane at that storey's own floor
  level — and once a drag has left the building it stays free until it passes
  over a floor again, so dragging along the outside of a facade does not keep
  catching the wall. Drag it back into a room and the override is
  removed again, because the position says which room it is in and an override
  written now would go stale the next time the model changes.
- `onDemand: true` idles the render loop when nothing changed. Leave it on.

A tablet-friendly profile:

```yaml
render:
  quality: medium
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
