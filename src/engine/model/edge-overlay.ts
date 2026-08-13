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

/** Below this the edge is a smooth continuation and drawing it adds noise. */
const THRESHOLD_DEG = 24;

/** Meshes smaller than this in any dimension are detail, not structure. */
const MIN_FEATURE_M = 0.03;

export interface EdgeOverlayOptions {
  color?: string;
  opacity?: number;
  thresholdDeg?: number;
}

export class EdgeOverlay {
  private readonly group = new THREE.Group();
  private readonly material: THREE.LineBasicMaterial;
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

    this.material = new THREE.LineBasicMaterial({
      color: new THREE.Color(options.color ?? '#1b1f24'),
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
    this.material.color.set(color);
    if (opacity !== undefined) this.material.opacity = opacity;
    this.material.needsUpdate = true;
  }

  private applyStyle(): void {
    if (!this.built) return;
    const showEdges = this.style !== 'solid';
    this.group.visible = showEdges;

    // `wireframe` is a hidden-line drawing, not an X-ray. The surfaces stay in
    // the scene and keep writing depth, but stop writing colour — so a wall
    // still occludes everything behind it while being invisible itself, and
    // the transparent card background is untouched because nothing was drawn
    // over it. Simply hiding the meshes would let every edge in the building
    // show through every other one, which is unreadable.
    //
    // Nothing is lit in this mode: there is no visible surface for a lamp to
    // fall on. The luminaires still glow, the rooms do not brighten.
    const wire = this.style === 'wireframe';
    for (const mesh of this.surfaces) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      // Glass must not occlude — you are supposed to see through a window.
      const isGlass = mesh.userData.glass === true;
      mesh.visible = !(wire && isGlass);

      for (const material of materials) {
        if (!material) continue;
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

    // Lines read heavier without shaded surfaces behind them, so ease off.
    this.material.opacity = wire ? 0.9 : 0.55;
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
