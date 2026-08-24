# Getting your house into the card

The card takes your house from any of three places:

| Source | `model` | Good for |
| --- | --- | --- |
| **Sweet Home 3D** | `url: /local/house.sh3d` | The easiest route by a wide margin. Draw the house, save, point the card at the save file. |
| **glTF 2.0** | `url: /local/house.glb` | Blender, SketchUp, IFC — anything that can export a mesh. Most control, most work. |

There is no house to fall back to: with no `model` the card starts, finds
nothing to draw and says so. The shortest route to something on screen is a
Sweet Home 3D save — twenty minutes of tracing over a scan beats an evening in
Blender.

Sections 2 onward are about the glTF route. If you use Sweet Home 3D you can
stop after section 1.

---

## 1. Draw the house

### Sweet Home 3D — recommended

The shortest path from "I have a floorplan PDF" to "I have a working card", and
the only one where you never leave a single program.

1. Install [Sweet Home 3D](https://www.sweethome3d.com/) (Windows/macOS/Linux,
   GPL).
2. Import your floorplan image as a background (*Plan → Import background
   image*) and set its scale from a known dimension.
3. Trace walls on top of it. Set wall heights per room; add doors and windows
   from the catalogue (they cut real openings).
4. Add a second level for each storey (*Plan → Add level*) and set its
   elevation and height to match reality.
5. Name your rooms (double-click a room → *Name*). The card uses those names,
   so `Kitchen` becomes the node `level0/kitchen/floor`.
6. **Save the file** and copy it to `config/www/`.

```yaml
model:
  url: /local/house.sh3d?v=2
```

**Save it — do not export it.** `.sh3d` is Sweet Home 3D's own save format and
the card reads it directly. This matters: Sweet Home 3D's built-in export is
**OBJ**, which is a bag of triangles with no storeys, no rooms and no names, so
everything this card is built on — the level selector, cross-sections, binding
an entity to a room — would be gone. The `.sh3d` keeps all of it.

Bump `?v=` after every re-save or the browser will serve you a stale file.

What comes across: storeys and their elevations, walls with their real thickness
and openings, sloping and curved walls, room polygons with their floors and
ceilings, and every piece of furniture as a correctly sized, positioned and
rotated box.

What does not, yet: textures, and the detailed catalogue models — a sofa is a
sofa-shaped box rather than a sofa. The models are inside the archive, so this
may improve later.

Files saved by Sweet Home 3D **5.0 or newer** work. Older ones store the home in
a Java-serialised blob the card cannot read; open such a file in a current Sweet
Home 3D and save it again, and the card will report exactly that if you forget.

Sweet Home 3D works in **centimetres**; the card converts for you. You only need
to think about units if you take the OBJ route below, where a model that arrives
100× too large is nearly always a cm/m mix-up.

### Blender (free, most control)

Best if you want clean geometry, sensible materials and small files.

1. Model or import your house. Keep the scene in metres
   (*Scene Properties → Units → Metric, Unit Scale 1.0*).
2. Name your objects using the convention in section 2.
3. *File → Export → glTF 2.0 (.glb)* with:
   - Format: **glTF Binary (.glb)**
   - Include: **Selected Objects** (or Visible Objects)
   - Transform: **+Y Up** ✔ — this is the important one
   - Geometry: **Apply Modifiers** ✔, **UVs / Normals** ✔, **Materials: Export**
   - Compression: **Draco** ✔ if you want a smaller file (see section 5)

### SketchUp Free

Works, with a detour: SketchUp Free exports Collada (`.dae`) or STL. Import the
`.dae` into Blender and export GLB. Expect to redo materials — SketchUp's
material model does not survive the trip well. Watch the units: SketchUp
defaults to inches in the US template.

### IFC / BIM → glTF

If your architect gave you an IFC file, you already have the best possible
source: real storeys, real rooms, real names.

- **BlenderBIM / Bonsai** ([blenderbim.org](https://blenderbim.org/)) — import
  the IFC into Blender, then export GLB as above. IFC spatial structure
  (`IfcBuildingStorey` → `IfcSpace`) maps directly onto the card's levels and
  rooms, and BlenderBIM preserves the names.
- **IfcOpenShell** ([ifcopenshell.org](https://ifcopenshell.org/)) — the
  command-line route:

  ```bash
  IfcConvert house.ifc house.dae     # then convert to glb in Blender, or:
  IfcConvert house.ifc house.obj
  ```

IFC models are almost always far too detailed for a dashboard card. Delete the
MEP, furniture and fixture disciplines before exporting, and expect to spend
more time on section 5 (optimisation) than on anything else.

---

## 2. Node naming: `level/room/part`

The card reads the structure of your model from node names. The convention is
three slash-separated segments:

```
<level>/<room>/<part>
```

Examples:

```
ground/kitchen/wall_north
ground/kitchen/floor
upper/bedroom/wall_east
basement/utility/ceiling
site/exterior/terrain
site/roof/roof_main
```

Rules worth knowing:

- **`userData.level` wins.** If a node carries a `level` key in its glTF extras
  (`userData` in three.js), that is the source of truth. Name parsing is only
  the fallback. In Blender, add a custom property named `level` on the object to
  set it explicitly.
- **Two pseudo-levels** are recognised: `site` for anything that is not part of a
  storey (terrain, garden, driveway).
- **Two pseudo-rooms** are recognised: `exterior` for outside surfaces and `roof`
  for roof geometry — both are handled specially when a level is isolated so a
  cross-section does not leave a roof floating in mid-air.
- Segments may contain letters, digits, `_` and `-`. Spaces work but make YAML
  references uglier.
- You do not have to name every node. Unnamed geometry is still rendered; it
  just gets assigned to a level by geometry instead of by name.

### Level auto-detection

If `model.levels` is absent from your config, the card derives the storeys
itself:

1. It looks for explicit level markers — `userData.level`, then the first path
   segment of the node name.
2. It understands the common prefixes: `level_0`, `floor_1`, `storey_2`, `L0`,
   `L1`, and the German `UG` (basement), `EG` (ground), `OG` (upper).
3. Failing that, it clusters the heights of horizontal floor slabs. Slabs whose
   Y values fall within the same band become one storey; the storey height is
   the gap to the next band.

Auto-detection is good, not clairvoyant. If your level selector shows
"Level 1 / Level 2 / Level 3" instead of "Basement / Ground / Upper", define
`model.levels` explicitly — it takes two minutes and it is what presets and
placed entities reference by id anyway.

---

## 3. Units, axes, origin

| Thing | What the card expects |
| --- | --- |
| Units | **Metres.** 1 world unit = 1 m. |
| Up axis | **+Y up.** |
| Facing | The model faces **−Z** by default. |
| Origin | `(0, 0, 0)` at the finished floor of the ground level, ideally near the building's footprint centre. |
| Floor of level 0 | `y = 0`. |

**Fixing a Z-up export.** Blender is Z-up internally; its glTF exporter has a
*+Y Up* option that converts for you — leave it on. If you end up with a model
lying on its side anyway, do not re-export in a panic; fix it in the config:

```yaml
model:
  url: /local/house.glb
  rotation: [-90, 0, 0]
```

**Fixing scale.** If the house is 100× too big, your source was in centimetres:

```yaml
model:
  scale: 0.01
```

**Fixing the origin.** If the ground floor sits at y = 3.4 instead of 0:

```yaml
model:
  offset: [0, -3.4, 0]
```

All three can be dialled in live from the visual editor's **Model** tab; the
view updates as you type.

---

## 4. Materials and glass

- **Use PBR materials** (`Principled BSDF` in Blender). glTF exports metallic /
  roughness / base colour cleanly; anything else gets approximated.
- **Windows and glass.** Give window panes their own material and list the node
  patterns in `model.glassNodes`:

  ```yaml
  model:
    glassNodes: [window, glass, "*_pane"]
  ```

  Matching materials are switched to a transmissive setup so you can see indoor
  lights through the façade. Without this, glass exported as an opaque grey
  material will hide the entire interior.
- **Double-sided materials** cost fill rate and break cut caps. Model walls with
  real thickness rather than single-sided planes; a zero-thickness wall cannot be
  capped when you slice it, so it will look hollow whatever the card does.
- **Emissive materials** are drawn as they are. A lit room is shown by tinting
  the room, not by making its surfaces glow, so an emissive material in the
  model is simply a bright surface.

---

## 5. Optimisation

Budgets that keep a wall tablet happy:

| Metric | Target | Hard ceiling |
| --- | --- | --- |
| Triangles | < 150 k | ~500 k |
| Draw calls (≈ material/mesh splits) | < 150 | ~400 |
| Textures | 1–2 k px, few of them | 4 k px |
| File size | < 5 MB | ~20 MB |

**In Blender, before exporting:**

- Delete anything not visible from outside or in a cross-section: internal
  plumbing, screws, imported furniture with 200 k-triangle upholstery.
- *Merge by material.* Select objects sharing a material, `Ctrl+J`. Each
  material/mesh pair is a draw call; merging is the single biggest win.
- Apply a `Decimate` modifier to organic/imported meshes; leave architecture
  alone (decimating walls produces wobbly geometry).
- Resize textures to 1024 or 2048 px. A 4 k brick texture on a wall nobody zooms
  into is 16 MB of VRAM for nothing.

**Compression from the command line.**

[`gltf-transform`](https://gltf-transform.dev/) — the friendly option:

```bash
npm i -g @gltf-transform/cli

# Inspect first: it prints triangles, draw calls, textures and sizes.
gltf-transform inspect house.glb

# Deduplicate, join meshes by material, resize textures, then Draco-compress.
gltf-transform optimize house.glb house-opt.glb \
  --compress draco \
  --texture-compress jpeg \
  --texture-size 2048
```

[`gltfpack`](https://github.com/zeux/meshoptimizer) — meshopt, usually smaller
and faster to decode than Draco:

```bash
gltfpack -i house.glb -o house-opt.glb -cc -tc
#   -cc  aggressive meshopt compression
#   -tc  compress textures        <-- omit this, see the warning below
```

> **Do not use `-tc` / KTX2 / Basis textures.** The card rejects KTX2-compressed
> textures with an explicit, actionable error message rather than rendering an
> untextured model. Draco **and** meshopt geometry compression are both
> supported; only the KTX2 *texture* format is not. Run `gltfpack -i house.glb
> -o house-opt.glb -cc` and keep PNG/JPEG textures.

**Draco needs a decoder.** If your file is Draco-compressed, point the card at a
decoder directory:

```yaml
model:
  url: /local/house.glb
  dracoPath: https://www.gstatic.com/draco/v1/decoders/
```

The trailing slash is required. To stay fully local, copy the decoder files into
`config/www/draco/` and use `dracoPath: /local/draco/`. Meshopt-compressed files
need no extra configuration.

---

## 6. Where to put the file

Home Assistant serves everything in `config/www/` from `/local/`:

```
config/www/house.glb          →   /local/house.glb
config/www/models/house.glb   →   /local/models/house.glb
```

```yaml
type: custom:floorplan-3d-card
model:
  url: /local/house.glb
```

Create `config/www/` if it does not exist, then **restart Home Assistant once** —
the folder is only picked up at startup.

### Caching

`/local/` is served with aggressive cache headers. After you overwrite
`house.glb` with a new export, browsers will happily keep showing the old one for
days. Version the URL:

```yaml
model:
  url: /local/house.glb?v=2      # bump on every re-export
```

The query string is ignored by the file system and changes the cache key, which
is exactly what you want. Do the same for the card bundle itself when you update
it manually.

### Hosting it elsewhere

An absolute `https://` URL works too, but the server must send permissive CORS
headers (`Access-Control-Allow-Origin`) and be reachable from every device that
opens the dashboard — including phones on mobile data. Local is simpler and
faster; use `/local/`.
