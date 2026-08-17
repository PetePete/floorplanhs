/**
 * Crisp architectural edge lines over the model — the CAD look.
 *
 * Deliberately NOT `material.wireframe = true`: that draws every triangle,
 * including the diagonal splitting each quad, so a wall reads as a net rather
 * than as a drawing. `EdgesGeometry` keeps only edges whose adjacent faces
 * differ by more than a threshold angle, which for a building is exactly the
 * corners, reveals and openings a draughtsman would draw.
 *
 * Lines are merged per storey rather than per mesh: one draw call per level
 * instead of one per wall, while still following level visibility.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RenderPalette, RenderStyle } from '@/types/config';
import type { RoomFillSource } from '@/engine/lighting/room-fill';

/** Below this the edge is a smooth continuation and drawing it adds noise. */
const THRESHOLD_DEG = 24;

/** Meshes smaller than this in any dimension are detail, not structure. */
const MIN_FEATURE_M = 0.03;

export interface EdgeOverlayOptions {
  color?: string;
  opacity?: number;
  thresholdDeg?: number;
}

/** Room index carried by each edge vertex; 0 means "belongs to no room". */
const ROOM_ATTRIBUTE = 'fpRoom';

/**
 * How far a lit room's lines move from the ink towards the light colour at full
 * brightness. Not all the way: a line that abandons the ink entirely stops
 * reading as part of the same drawing.
 */
const LIT_MIX = 0.85;

export class EdgeOverlay {
  private readonly group = new THREE.Group();
  private readonly material: THREE.LineBasicMaterial;
  /** Base ink, as written into the vertex colours of every unlit line. */
  private readonly ink = new THREE.Color('#d6dbe2');
  private rooms: RoomFillSource | null = null;
  private readonly scratchColor = new THREE.Color();
  /** One merged LineSegments per level id; `''` collects unassigned meshes. */
  private readonly byLevel = new Map<string, THREE.LineSegments>();
  private style: RenderStyle = 'solid';
  private palette: RenderPalette = 'model';
  /** Materials switched to depth-only for the hidden-line pass. */
  private readonly depthOnly = new Set<THREE.Material>();
  private surfaces: THREE.Mesh[] = [];
  private built = false;
  /** Original look of every material the palette overrode, for restoring. */
  private readonly paletteBackup = new Map<
    THREE.Material,
    {
      color: THREE.Color;
      map: THREE.Texture | null;
      emissive: THREE.Color;
      roughness: number;
      metalness: number;
    }
  >();

  constructor(options: EdgeOverlayOptions = {}) {
    this.group.name = 'edge-overlay';
    // Not on the overlay root: these lines must be cut by the section planes
    // exactly like the walls they trace, so they belong under the model.
    this.group.userData.helper = true;
    this.group.userData.noPick = true;
    // Keeps the section controller's ghost-above pass from cloning us: the
    // clone's LineSegments are not meshes, so it would never be faded and
    // every edge would be drawn twice at full strength.
    this.group.userData.fp3dInternal = true;

    this.ink.set(options.color ?? '#1b1f24');
    this.material = new THREE.LineBasicMaterial({
      // White, and the real colour comes from the per-vertex attribute — that
      // is what lets a lit room's lines differ inside one merged draw call.
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: options.opacity ?? 0.55,
      depthTest: true,
      // Unlit: an edge line is annotation, not geometry that reacts to lamps.
      toneMapped: false,
    });
  }

  get object(): THREE.Object3D {
    return this.group;
  }

  /**
   * Extract edges from every mesh under `root`. Call once per model load; the
   * result is cached until `dispose()`.
   */
  build(root: THREE.Object3D, clippingPlanes: THREE.Plane[], thresholdDeg = THRESHOLD_DEG): void {
    // Assigned explicitly: the section controller only walks meshes when it
    // distributes the clip planes, and LineSegments is not a Mesh. Without
    // this the wireframe of the cut-away half floats beside the solid.
    this.material.clippingPlanes = clippingPlanes;
    this.material.clipShadows = true;
    this.clearGeometry();
    root.updateWorldMatrix(true, true);

    const perLevel = new Map<string, THREE.BufferGeometry[]>();
    const size = new THREE.Vector3();
    const box = new THREE.Box3();
    this.surfaces = [];

    root.traverse((node) => {
      if (!(node as THREE.Mesh).isMesh) return;
      const mesh = node as THREE.Mesh;
      if (mesh.userData.helper || mesh.userData.noEdges) return;
      if (mesh.userData.fp3dInternal === true) return;
      if (!mesh.geometry?.attributes?.position) return;

      this.surfaces.push(mesh);
      // Glass already reads as an outline; edging it doubles every window.
      if (mesh.userData.glass) return;

      box.setFromObject(mesh);
      box.getSize(size);
      if (Math.max(size.x, size.y, size.z) < MIN_FEATURE_M) return;

      let edges: THREE.EdgesGeometry;
      try {
        edges = new THREE.EdgesGeometry(mesh.geometry, thresholdDeg);
      } catch {
        return;
      }
      if (edges.attributes.position.count === 0) {
        edges.dispose();
        return;
      }

      // Bake the mesh transform in, since the merged result is parented to the
      // model root rather than to the mesh.
      edges.applyMatrix4(mesh.matrixWorld);

      // A room-owned mesh answers for all of its lines at once. Walls do not —
      // their two faces belong to two rooms — so those are resolved per vertex
      // against the room polygons, which a wall face lies exactly on.
      const count = edges.attributes.position.count;
      const slots = new Float32Array(count);
      const declared = this.rooms?.slotForMesh(mesh) ?? -1;
      if (declared >= 0) {
        slots.fill(declared + 1);
      } else if (this.rooms) {
        const position = edges.attributes.position;
        for (let i = 0; i < count; i += 1) {
          const found = this.rooms.slotAt(position.getX(i), position.getY(i), position.getZ(i));
          if (found >= 0) slots[i] = found + 1;
        }
      }
      edges.setAttribute(ROOM_ATTRIBUTE, new THREE.BufferAttribute(slots, 1));
      edges.setAttribute('color', new THREE.BufferAttribute(new Float32Array(count * 3), 3));

      const level = typeof mesh.userData.level === 'string' ? mesh.userData.level : '';
      const bucket = perLevel.get(level);
      if (bucket) bucket.push(edges);
      else perLevel.set(level, [edges]);
    });

    for (const [level, geometries] of perLevel) {
      const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
      if (geometries.length > 1) {
        for (const g of geometries) g.dispose();
      }
      if (!merged) continue;

      const lines = new THREE.LineSegments(merged, this.material);
      lines.name = `edges:${level || 'unassigned'}`;
      lines.userData.level = level || undefined;
      lines.userData.helper = true;
      lines.userData.noPick = true;
      lines.matrixAutoUpdate = false;
      lines.renderOrder = 2;
      lines.raycast = () => undefined;
      this.byLevel.set(level, lines);
      this.group.add(lines);
    }

    this.built = true;
    this.refreshRoomColors();
    // A reload brings new material objects, so the old backup is meaningless.
    this.paletteBackup.clear();
    if (this.palette !== 'model') this.applyPalette();
    this.applyStyle();
  }

  /**
   * Flatten every surface to one neutral tone, or restore the model's own
   * materials.
   *
   * The material *objects* are mutated in place rather than swapped out. The
   * section controller caches the material set it distributes clipping planes
   * to, so replacing materials here would silently stop the cross-sections
   * working — a much worse bug than the one this feature is worth.
   */
  setPalette(palette: RenderPalette): void {
    if (this.palette === palette) return;
    this.palette = palette;
    this.applyPalette();
  }

  private applyPalette(): void {
    if (this.palette === 'model') {
      for (const [material, saved] of this.paletteBackup) {
        const std = material as THREE.MeshStandardMaterial;
        std.color.copy(saved.color);
        std.map = saved.map;
        std.emissive?.copy(saved.emissive);
        std.roughness = saved.roughness;
        std.metalness = saved.metalness;
        std.needsUpdate = true;
      }
      this.paletteBackup.clear();
      return;
    }

    const light = this.palette === 'mono-light';
    const base = new THREE.Color(light ? 0xd8dade : 0x3a3f45);

    for (const mesh of this.surfaces) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const std = material as THREE.MeshStandardMaterial;
        if (!std?.color) continue;
        if (!this.paletteBackup.has(std)) {
          this.paletteBackup.set(std, {
            color: std.color.clone(),
            map: std.map ?? null,
            emissive: std.emissive?.clone() ?? new THREE.Color(0, 0, 0),
            roughness: std.roughness ?? 1,
            metalness: std.metalness ?? 0,
          });
        }
        std.color.copy(base);
        // Textures carry the colour we are trying to remove.
        std.map = null;
        std.roughness = 0.92;
        std.metalness = 0;
        std.needsUpdate = true;
      }
    }
  }

  setStyle(style: RenderStyle): void {
    if (this.style === style) return;
    this.style = style;
    this.applyStyle();
  }

  getStyle(): RenderStyle {
    return this.style;
  }

  /** Mirrors `IModelManager.setVisibleLevels` so edges hide with their storey. */
  setVisibleLevels(levelIds: string[] | null): void {
    for (const [level, lines] of this.byLevel) {
      // Unassigned geometry has no storey to hide with, so it always shows.
      lines.visible = !levelIds || level === '' || levelIds.includes(level);
    }
  }

  setColor(color: string, opacity?: number): void {
    this.ink.set(color);
    // The material stays white: the ink lives in the vertex colours, which is
    // what lets a lit room's lines differ from the rest of the same draw call.
    this.material.color.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
    if (opacity !== undefined) this.material.opacity = opacity;
    this.material.needsUpdate = true;
    this.refreshRoomColors();
  }

  /** Where lit-room colours come from. Null restores plain ink everywhere. */
  setRoomSource(source: RoomFillSource | null): void {
    this.rooms = source;
    this.refreshRoomColors();
  }

  /**
   * Repaint the vertex colours from the current room fill: a lit room's lines
   * take its light colour, everything else the ink.
   *
   * Called on a real change in the fill rather than per frame — it walks every
   * line vertex in the building.
   */
  refreshRoomColors(): void {
    if (!this.built) return;
    const lit = this.scratchColor;

    for (const lines of this.byLevel.values()) {
      const color = lines.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
      const room = lines.geometry.getAttribute(ROOM_ATTRIBUTE) as THREE.BufferAttribute | undefined;
      if (!color || !room) continue;

      for (let i = 0; i < color.count; i += 1) {
        const slot = room.getX(i) - 1;
        const level = slot >= 0 && this.rooms ? this.rooms.levelInto(slot, lit) : 0;
        if (level > 0) {
          // On a light ground the lamp's near-white hue would pull the line
          // *towards* the paper; deepened, it pulls away from it instead.
          lit.multiplyScalar(this.rooms?.litScale ?? 1);
          color.setXYZ(
            i,
            this.ink.r + (lit.r - this.ink.r) * LIT_MIX * level,
            this.ink.g + (lit.g - this.ink.g) * LIT_MIX * level,
            this.ink.b + (lit.b - this.ink.b) * LIT_MIX * level,
          );
        } else {
          color.setXYZ(i, this.ink.r, this.ink.g, this.ink.b);
        }
      }
      color.needsUpdate = true;
    }
  }

  private applyStyle(): void {
    if (!this.built) return;

    // `wireframe` is a hidden-line drawing, not an X-ray. The surfaces stay in
    // the scene and keep writing depth, but stop writing colour — so a wall
    // still occludes everything behind it while being invisible itself, and
    // the transparent card background is untouched because nothing was drawn
    // over it. Simply hiding the meshes would let every edge in the building
    // show through every other one, which is unreadable.
    //
    // No surface is painted, so no surface can be shaded: a lit room shows
    // through the floor wash instead (see room-fill.ts), and the luminaires
    // still glow.
    const wire = this.style === 'wireframe';
    const showEdges = wire;
    this.group.visible = showEdges;
    for (const mesh of this.surfaces) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // Glass must not occlude — you are supposed to see through a window.
      const isGlass = mesh.userData.glass === true;
      mesh.visible = !(wire && isGlass);

      for (const material of materials) {
        if (!material) continue;

        // Nudge surfaces away from the camera in depth while edges are drawn.
        // A wall's bottom edge is exactly coplanar with the floor it stands on,
        // so without this the line and the slab fight for the same depth and
        // the wall/floor junction loses its outline from some angles.
        material.polygonOffset = showEdges;
        material.polygonOffsetFactor = showEdges ? 1 : 0;
        material.polygonOffsetUnits = showEdges ? 1 : 0;

        if (wire && !isGlass) {
          if (!this.depthOnly.has(material)) {
            this.depthOnly.add(material);
            material.userData.fp3dColorWrite = material.colorWrite;
          }
          material.colorWrite = false;
          material.depthWrite = true;
        } else if (this.depthOnly.has(material)) {
          material.colorWrite = material.userData.fp3dColorWrite ?? true;
          delete material.userData.fp3dColorWrite;
          this.depthOnly.delete(material);
        }
      }
    }

    this.material.opacity = 0.9;
  }

  private clearGeometry(): void {
    for (const lines of this.byLevel.values()) {
      lines.geometry.dispose();
      this.group.remove(lines);
    }
    this.byLevel.clear();
    // Hand back the materials we switched to depth-only, or a style change
    // after a reload would leave the model permanently invisible.
    for (const material of this.depthOnly) {
      material.colorWrite = material.userData.fp3dColorWrite ?? true;
      delete material.userData.fp3dColorWrite;
    }
    this.depthOnly.clear();
    // Restore anything `wireframe` mode hid, so a reload starts clean.
    for (const mesh of this.surfaces) {
      if (mesh.userData.edgeHidden === true) {
        mesh.visible = true;
        delete mesh.userData.edgeHidden;
      }
    }
    this.surfaces = [];
    this.built = false;
  }

  dispose(): void {
    this.clearGeometry();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
