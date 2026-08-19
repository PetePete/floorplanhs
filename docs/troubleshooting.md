# Troubleshooting

Symptom → cause → fix. Start with the two questions that resolve most reports:

1. **Does `type: custom:floorplan-3d-card` with nothing else render a card
   that says it has no model?** If yes, the card is installed correctly and the
   problem is your model or your config. If no, it is installation or the
   browser.
2. **What does the browser console say?** F12 → Console. The card logs its
   failures with a `[floorplan-3d]` prefix and an actionable message.

---

## "Custom element doesn't exist: floorplan-3d-card"

**Cause.** The JavaScript resource is not loaded, or it was registered with the
wrong type.

**Fix.**

- Settings → Dashboards → ⋮ → **Resources**. The entry must be
  `/local/floorplan-3d-card.js` (or `/hacsfiles/floorplan-3d-card/floorplan-3d-card.js`)
  with type **JavaScript module**, not "JavaScript file".
- Hard-reload the browser (Ctrl/Cmd + Shift + R). Lovelace caches resources
  aggressively.
- If you edited a YAML-mode dashboard, resources live in the dashboard's own
  `resources:` block, not in the UI resource list.
- After a manual update, bump `?v=` on the resource URL.

---

## The card is black / blank

| Cause | Fix |
| --- | --- |
| No WebGL2 | The card says so explicitly if it can detect it. Check `chrome://gpu` (or the equivalent). Kiosk browsers and old Android WebViews sometimes ship without it; there is no workaround inside the card. |
| Hardware acceleration disabled | Enable it in the browser settings. Software WebGL will "work" at 2 fps. |
| The model loaded but the camera is inside a wall | Tap a preset, or delete `presets` temporarily so the card auto-frames the house. |
| Exposure or ambient set to 0 | `render.exposure: 1.0`, `render.ambientIntensity: 0.28`. |
| The card has zero height | `ui.height: 520px`, or set `ui.aspectRatio: 16:9`. A card inside a grid with an unusual layout can collapse. |
| Another custom card threw first | One broken card can abort the module that registers the others. Check the console for unrelated errors. |

---

## The model does not load

The card shows a load error and keeps the shell visible. The console message
tells you which of these it is.

**404 — file not found.**

- `config/www/house.glb` is served as `/local/house.glb`. Not `/config/www/...`,
  not `www/house.glb`.
- If you just created `config/www/`, **restart Home Assistant**: the folder is
  only registered as a static path at startup.
- Case matters on Linux. `House.glb` ≠ `house.glb`.
- Test the URL directly: open `https://your-ha:8123/local/house.glb` in a tab.
  You should get a download, not the Home Assistant UI.

**CORS — blocked by the browser.**

- Only happens with models hosted on another origin. The server must send
  `Access-Control-Allow-Origin`.
- The fix is almost always "put the file in `config/www/` instead".

**Draco decode failure.**

- The file is Draco-compressed and `model.dracoPath` is unset or wrong.
- Set `dracoPath: https://www.gstatic.com/draco/v1/decoders/` (trailing slash
  required), or copy the decoder into `config/www/draco/` and use
  `/local/draco/`.

**"KTX2/Basis textures are not supported".**

- Your exporter compressed the textures (`gltfpack -tc`, or the KTX2 option in
  the Blender exporter).
- Re-export with plain PNG/JPEG textures. Geometry compression is fine — both
  Draco and meshopt are supported; only the KTX2 texture format is rejected.

**The old model keeps appearing after re-exporting.**

- Browser cache. Version the URL: `url: /local/house.glb?v=3`, and bump it every
  time.

---

## The house is enormous / microscopic

**Cause.** Unit mismatch. The card works in metres; Sweet Home 3D and SketchUp
often export centimetres or inches.

**Fix.**

```yaml
model:
  scale: 0.01     # centimetres → metres
  # scale: 0.0254 # inches → metres
```

Sanity check: a normal interior door is about 2 m tall. If the camera's
`maxDistance: 80` is not enough to see the whole house, your scale is wrong.

---

## The house is lying on its side / upside down

**Cause.** A Z-up export (Blender's native orientation) instead of Y-up.

**Fix — either** re-export with **+Y Up** ticked in Blender's glTF exporter,
**or** correct it in the config:

```yaml
model:
  rotation: [-90, 0, 0]
```

If the house is right way up but facing the wrong direction, rotate around Y:
`rotation: [0, 180, 0]`.

If it floats above or sinks below the ground plane, move it:

```yaml
model:
  offset: [0, -3.4, 0]   # ground floor should sit at y = 0
```

All three update live in the editor's Model tab.

---

## Lights are not visible

Work down this list:

1. **Is it in the `light` domain?** Only `light.*` entities become real lights.
   A `switch.*` controlling a lamp gets a marker; set `role: light` and give it a
   `light:` block if you want illumination from it.
2. **Is the entity on?** An off light emits nothing, by design.
3. **Is the position inside the house?** A light at `[0, 0, 0]` sits in the floor
   slab and lights nothing. Put it near the ceiling — `y ≈ 2.4–2.7` for a 2.9 m
   storey.
4. **Is its level hidden?** If `entities[].level` points at a level the level
   selector has hidden, the light is hidden too.
5. **Is the falloff too small?** The default `distance` is 8 m. A large open-plan
   room may need `distance: 14`, or `distance: 0` for infinite range.
6. **Is `ambientIntensity` drowning it?** A high ambient makes every light look
   like it does nothing. Try `0.15`.
7. **Is it a `kind: emissive` light?** Those glow but do not illuminate.

---

## Everything is too dark

- Raise `render.exposure` (try `1.3`) before touching individual lights.
- Raise `render.ambientIntensity` (try `0.4`).
- Opaque windows block all indoor light spill. Add the pane materials to
  `model.glassNodes`.
- A `low` quality tier disables post-processing; the image is flatter there.

## Everything is too bright / washed out

- Lower `render.exposure` (try `0.8`).
- Lower `render.ambientIntensity` (try `0.15`).
- Too many overlapping lights at full intensity: reduce per-light `intensity`,
  or reduce `distance` so they stop stacking.

---

## Poor performance on a tablet

Apply in this order — each step is bigger than the one after it:

```yaml
render:
  maxPixelRatio: 1      # 2. quarter the pixels on a retina panel
  quality: medium       # 3. or low
  fpsLimit: 30          # 4. halves the work when animating
  onDemand: true        # 5. must stay true
```

Then look at the model, which is usually the real cause:

- `gltf-transform inspect house.glb` — if you are above ~300 k triangles or ~400
  draw calls, no render setting will save you. Merge meshes by material and
  decimate imported furniture. See [`model-guide.md`](model-guide.md#5-optimisation).
- Reduce texture sizes to 1–2 k px.
- Turn off `ui.showFps` when you are done measuring.

Also: `camera.autoRotate: true` prevents the render loop from ever idling. On a
battery-powered tablet, turn it off.

---

## Cross-section shows hollow walls

**Cause A — `caps` is off.** Set `section.caps: true`.

**Cause B — no stencil buffer.** Cut caps are drawn with a stencil pass. If the
WebGL context was created without one, the card degrades to hollow shells rather
than failing. Nothing in the config fixes that; it is a browser/driver
limitation.

**Cause C — zero-thickness walls.** This is the common one. Walls modelled as
single-sided planes have no interior to fill: slice them and you see through the
sheet. Model walls with real thickness (Sweet Home 3D does this by default;
hand-modelled Blender planes do not).

**Cause D — the roof floats.** Roof geometry should be named with the `roof`
pseudo-room (`site/roof/...`) so isolating a level handles it specially.

---

## Drag & drop does not work on touch

- Drag & drop placement is only available while the **dashboard is in edit
  mode**. Outside edit mode a drag orbits the camera, which is what you want.
- On touch you must **press and hold briefly** on the entity before dragging, so
  the gesture is not read as a scroll.
- Some Android WebViews swallow the drag if the page is still scrolling — let it
  settle first.
- If the drop lands nowhere, you dropped outside the model. The card only
  commits placements that raycast onto the building shell.
- Fallback that always works: the **Entities** tab in the visual editor. Add the
  entity and type the position; the editor accepts three decimals.

---

## Placed entities are gone after a reload

A card cannot save its own configuration — Lovelace takes that only from a
card's **editor**. So placements have to be made where the editor is listening:
**⋮ → Edit**, then drag in the live preview **with the visual editor open**, and
**Save**. Watch the `entities:` list in the YAML preview grow as you drop; if it
does not, nothing is being saved.

Two ways to end up with nothing saved:

- Placing on the dashboard itself, in edit mode. The card shows the position on
  screen and warns once that it is not saved.
- Placing in the edit dialog while it is switched to the **code editor**. The
  visual editor is not in the DOM then, so there is nothing to hand the drop to;
  the same warning appears.

---

## My config is lost after editing

**Cause A — a validation error.** The editor never emits a configuration that
fails validation. When something is invalid it shows a red banner listing the
problems and *stops saving* until they are fixed — so later edits appear to
vanish. Read the banner, fix the field, and saving resumes.

**Cause B — two editors open.** Editing the same card in two browser tabs means
the second save overwrites the first. Close one.

**Cause C — you edited YAML while the visual editor was open.** Switch fully
back to the visual editor (or fully to YAML) before continuing; mixing the two
in one dialog session can lose the last change.

Before a big edit, use **Copy config as YAML** in the Advanced tab and paste it
somewhere safe.

---

## Still stuck

Open an issue at <https://github.com/PetePete/floorplanhs/issues> and include:

- the card YAML (redact entity names if you like),
- the browser console output with the `[floorplan-3d]` lines,
- Home Assistant version, browser and device,
- for model problems, the output of `gltf-transform inspect your-model.glb`.
