# floorplan-3d-card — Architecture

An interactive 3D floorplan for Home Assistant. Ships as **one ES module**
(`dist/floorplan-3d-card.js`) that registers a custom Lovelace card. No backend,
no add-on, no extra hosting: the card reads live state from the `hass` object it
is handed and writes its configuration back into the dashboard YAML.

## Layer map

```
src/
  main.ts                 entry: registers <floorplan-3d-card> + editor, window.customCards
  types/
    config.ts             THE persisted YAML schema. Never break it silently.
    hass.ts               minimal Home Assistant typings
  util/
    events.ts             Emitter, fireEvent, throttle/debounce
    color.ts              kelvin/hs/hex -> linear RGB
    math.ts               lerp, easings, Vec3 helpers, uid
  engine/                 framework-agnostic three.js core (no lit, no HA imports
                          except types) — reusable from card and panel
    contracts.ts          interfaces between all subsystems (the contract)
    viewer.ts             owns the RenderContext, instantiates + wires subsystems
    core/                 renderer, render loop, resize, quality tiers
    model/                glTF loading, procedural demo house, level detection
    section/              clipping planes, level isolation, cut caps, handles
    camera/               orbit controls, preset capture + flight
    lighting/             HA light state -> three.js lights, daylight rig, postfx
    entities/             markers/hotspots, sprites, hover + pick
    interaction/          pointer routing, drag & drop placement, gizmos
  ha/                     Home Assistant glue (state mapping, actions, registry)
  card/                   <floorplan-3d-card> LitElement + chrome/UI
  editor/                 <floorplan-3d-card-editor> visual config editor
```

## Non-negotiable rules

1. **`engine/` never imports from `card/`, `editor/`, or `ha/` (types are OK).**
   The engine takes plain data in and emits plain events out. This is what keeps
   the same core usable in a card, a panel and a standalone page.
2. **Subsystems talk through `engine/contracts.ts` only.** If you need something
   another subsystem has, it goes through the interface or through `RenderContext`.
3. **Config is YAML.** Everything in `types/config.ts` must survive a JSON
   round-trip and be readable by a human editing their dashboard by hand.
   Round world-space coordinates to 3 decimals before writing.
4. **On-demand rendering.** The loop is idle by default. Anything that changes
   the picture must call `ctx.invalidate()`. Continuous animation takes a
   `ctx.holdContinuous()` lease and releases it.
5. **Dispose everything.** Geometries, materials, textures, render targets,
   event listeners, `ResizeObserver`s. A dashboard mounts and unmounts cards
   constantly; leaks kill wall tablets.
6. **Touch is a first-class input.** Every interaction needs a pointer-events
   path that works with a finger, including drag & drop placement.
7. **Never block the first paint on the model.** Show the shell + a progress
   state immediately, stream the model in.

## Data flow

```
hass.states ──► ha/state-mapper ──► LightSample / EntityVisualState
                                        │
                                        ▼
                             engine/lighting  engine/entities
                                        │
                                        ▼
                                   RenderContext ──► frame

user drag ──► interaction/placement ──► EditIntent ──► card ──► fireEvent('config-changed')
                                                                        │
                                                                        ▼
                                                            Lovelace persists YAML
```

## Coordinate & unit conventions

- **Metres.** One world unit = 1 m. The demo house is built to real dimensions.
- **Y is up.** Floor of level 0 sits at y = 0.
- **Model faces -Z** by default; `model.rotation` corrects imported models.
- Levels are half-open ranges `[elevation, elevation + height)`.

## Rendering

- `WebGLRenderer` with `ACESFilmicToneMapping`, `SRGBColorSpace` output,
  `localClippingEnabled = true`.
- Physically-ish lighting: `useLegacyLights` off, intensities in candela-like
  units, `decay = 2`.
- Bloom is **selective** via a layer (`IPostFx.bloomLayer`): only lit fixtures
  and emissive markers are on it, so a bright wall does not glow.
- Quality tiers downgrade shadow map size, pixel ratio and postfx, not geometry.

## Home Assistant integration points

| Need                        | Mechanism                                             |
| --------------------------- | ----------------------------------------------------- |
| Live state                   | `hass.states` diffed on each `set hass`               |
| Toggle / service call        | `hass.callService(domain, service, data, target)`     |
| Entity dialog                | `fireEvent(this, 'hass-more-info', { entityId })`     |
| Persist config               | `fireEvent(this, 'config-changed', { config })`       |
| Area / device names          | `hass.areas`, `hass.devices`, `hass.entities`         |
| Theme                        | CSS vars `--primary-color`, `--card-background-color` |
| Dark mode                    | `hass.themes.darkMode`                                |

## Build

`npm run build` → `tsc --noEmit` then Vite lib build, everything inlined
(`inlineDynamicImports`), single ESM file. Target ES2021 so it runs on the
Android WebView versions HA companion ships.
