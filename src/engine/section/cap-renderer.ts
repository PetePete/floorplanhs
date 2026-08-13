/**
 * Solid caps on cut surfaces.
 *
 * A clipped mesh is hollow: you look through a wall into the *inside* of the
 * shell and the section reads as broken geometry rather than as a cut. The fix
 * is the standard stencil trick (three.js `webgl_clipping_stencil`):
 *
 *   1. For one clip plane, draw the model's **back** faces incrementing the
 *      stencil buffer and its **front** faces decrementing it, with colour and
 *      depth writes off. Every pixel where the eye ray enters solid material
 *      and never leaves it again — i.e. every pixel of the cut surface — ends
 *      up with a non-zero stencil value.
 *   2. Draw a quad lying in the clip plane, stencil-tested against non-zero.
 *      That quad *is* the cut face.
 *   3. Clear the stencil and repeat for the next plane.
 *
 * The technique assumes closed geometry. Single-sided walls (a plane with no
 * thickness) cannot produce a cap by any method — their inside is not a volume.
 *
 * Degrades to nothing when the WebGL context was created without a stencil
 * buffer; that is a one-line change in the render core, not something we can
 * fix from here, so we say so once and stay quiet.
 */

import * as THREE from 'three';
import type { RenderContext } from '@/engine/contracts';

/**
 * Above this many stencil draw calls (2 per source mesh per plane) the caps
 * cost more than they are worth on a wall tablet.
 */
const MAX_STENCIL_DRAWS = 480;

const DEFAULT_CAP_COLOR = '#8a8f98';

let warnedNoStencil = false;
let warnedTooHeavy = false;

interface CapEntry {
  plane: THREE.Plane;
  quad: THREE.Mesh;
  quadMaterial: THREE.MeshStandardMaterial;
  /** Planes other than our own; keeps a cap from poking out of another cut. */
  otherPlanes: THREE.Plane[];
  backMaterial: THREE.MeshBasicMaterial;
  frontMaterial: THREE.MeshBasicMaterial;
  stencilMeshes: THREE.Mesh[];
}

export class CapRenderer {
  private ctx: RenderContext | null = null;
  private readonly group = new THREE.Group();
  private readonly quadGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly color = new THREE.Color(DEFAULT_CAP_COLOR);
  private readonly bounds = new THREE.Box3();
  private readonly sphere = new THREE.Sphere();

  private entries: CapEntry[] = [];
  private planes: THREE.Plane[] = [];
  private sources: THREE.Mesh[] = [];
  private enabled = true;
  private supported = false;

  constructor() {
    this.group.name = 'sectionCaps';
    // The quads are helper geometry: they must never be re-materialised by the
    // section controller's model traversal.
    this.group.userData.fp3dInternal = true;
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.supported = detectStencil(ctx.renderer);
    if (!this.supported && !warnedNoStencil) {
      warnedNoStencil = true;
      console.warn(
        '[floorplan-3d] the WebGL context has no stencil buffer — section cut ' +
          'caps are disabled. Enable `stencil: true` on the renderer to get them.',
      );
    }
    ctx.overlayRoot.add(this.group);
  }

  /** False when caps cannot be drawn at all (no stencil buffer). */
  get available(): boolean {
    return this.supported;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.rebuild();
  }

  setColor(css: string | undefined): void {
    const next = new THREE.Color(DEFAULT_CAP_COLOR);
    if (css && css.trim() !== '') {
      try {
        next.set(css.trim());
      } catch {
        /* keep the default; THREE already logged the offending string */
      }
    }
    if (next.equals(this.color)) return;
    this.color.copy(next);
    for (const entry of this.entries) {
      entry.quadMaterial.color.copy(this.color);
      entry.quadMaterial.emissive.copy(this.color);
    }
    this.ctx?.invalidate();
  }

  setBounds(bounds: THREE.Box3): void {
    this.bounds.copy(bounds);
    if (!this.bounds.isEmpty()) this.bounds.getBoundingSphere(this.sphere);
    this.refresh();
  }

  /**
   * The meshes the stencil volume is built from. Handed in by the section
   * controller, which has already traversed the model for its material cache.
   */
  setSources(meshes: readonly THREE.Mesh[]): void {
    this.sources = [...meshes];
    this.rebuild();
  }

  /**
   * Declare the active clip planes. `THREE.Plane` instances are matched by
   * identity, so moving a plane costs nothing and only adding/removing one
   * rebuilds the stencil meshes.
   */
  sync(planes: readonly THREE.Plane[]): void {
    const unchanged =
      planes.length === this.planes.length && planes.every((p, i) => p === this.planes[i]);
    this.planes = [...planes];
    if (unchanged) {
      this.refresh();
      return;
    }
    this.rebuild();
  }

  /** Plane constants moved: slide the quads along without touching materials. */
  refresh(): void {
    if (this.entries.length === 0) return;
    const radius = this.sphere.radius > 0 ? this.sphere.radius : 10;
    const size = radius * 2.4;
    const center = this.sphere.center;

    for (const entry of this.entries) {
      const { plane, quad } = entry;
      // Centre the quad on the model rather than on the plane's origin, so a
      // plane far from the world origin still covers the whole cut.
      plane.projectPoint(center, quad.position);
      quad.lookAt(
        quad.position.x - plane.normal.x,
        quad.position.y - plane.normal.y,
        quad.position.z - plane.normal.z,
      );
      quad.scale.set(size, size, 1);
      quad.updateMatrix();
    }
    this.ctx?.invalidate();
  }

  dispose(): void {
    this.clearEntries();
    this.group.removeFromParent();
    this.quadGeometry.dispose();
    this.sources = [];
    this.planes = [];
    this.ctx = null;
  }

  /* ------------------------------------------------------------ internals */

  private rebuild(): void {
    this.clearEntries();
    if (!this.ctx || !this.enabled || !this.supported) return;
    if (this.planes.length === 0 || this.sources.length === 0) return;

    if (this.sources.length * this.planes.length * 2 > MAX_STENCIL_DRAWS) {
      if (!warnedTooHeavy) {
        warnedTooHeavy = true;
        console.warn(
          `[floorplan-3d] section caps skipped: ${this.sources.length} meshes x ` +
            `${this.planes.length} planes exceeds the draw-call budget.`,
        );
      }
      return;
    }

    this.planes.forEach((plane, index) => {
      this.entries.push(this.createEntry(plane, index));
    });
    this.refresh();
  }

  private createEntry(plane: THREE.Plane, index: number): CapEntry {
    const otherPlanes = this.planes.filter((p) => p !== plane);

    // Stencil pass. Depth test off so back faces hidden behind other geometry
    // still count; colour write off so none of it is ever visible.
    const backMaterial = new THREE.MeshBasicMaterial({
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      side: THREE.BackSide,
    });
    backMaterial.stencilFail = THREE.IncrementWrapStencilOp;
    backMaterial.stencilZFail = THREE.IncrementWrapStencilOp;
    backMaterial.stencilZPass = THREE.IncrementWrapStencilOp;
    backMaterial.clippingPlanes = [plane];

    const frontMaterial = new THREE.MeshBasicMaterial({
      depthWrite: false,
      depthTest: false,
      colorWrite: false,
      stencilWrite: true,
      stencilFunc: THREE.AlwaysStencilFunc,
      side: THREE.FrontSide,
    });
    frontMaterial.stencilFail = THREE.DecrementWrapStencilOp;
    frontMaterial.stencilZFail = THREE.DecrementWrapStencilOp;
    frontMaterial.stencilZPass = THREE.DecrementWrapStencilOp;
    frontMaterial.clippingPlanes = [plane];

    const stencilMeshes: THREE.Mesh[] = [];
    const order = index * 2 + 1;

    for (const source of this.sources) {
      if (!source.geometry) continue;
      // Parented to the source mesh with an identity transform: the stencil
      // volume then follows any transform the model animates, for free.
      for (const material of [backMaterial, frontMaterial]) {
        const mesh = new THREE.Mesh(source.geometry, material);
        mesh.renderOrder = order;
        mesh.frustumCulled = source.frustumCulled;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.matrixAutoUpdate = false;
        mesh.userData.fp3dInternal = true;
        // Never a pick target for placement, hover or the section handles.
        mesh.raycast = () => {};
        source.add(mesh);
        stencilMeshes.push(mesh);
      }
    }

    const quadMaterial = new THREE.MeshStandardMaterial({
      color: this.color.clone(),
      metalness: 0,
      roughness: 0.85,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
    });
    // A cap in an unlit room would read as a black hole; a touch of self-lit
    // colour keeps the cut surface legible without making it glow.
    quadMaterial.emissive = this.color.clone();
    quadMaterial.emissiveIntensity = 0.12;
    quadMaterial.stencilFail = THREE.ReplaceStencilOp;
    quadMaterial.stencilZFail = THREE.ReplaceStencilOp;
    quadMaterial.stencilZPass = THREE.ReplaceStencilOp;
    quadMaterial.clippingPlanes = otherPlanes;
    quadMaterial.clipShadows = true;

    const quad = new THREE.Mesh(this.quadGeometry, quadMaterial);
    quad.name = `sectionCap:${index}`;
    quad.renderOrder = order + 0.5;
    quad.matrixAutoUpdate = false;
    quad.castShadow = false;
    quad.receiveShadow = false;
    quad.userData.fp3dInternal = true;
    quad.raycast = () => {};
    // Hand the next plane a clean slate; without this the second cap inherits
    // the first one's stencil values and bleeds.
    quad.onAfterRender = (renderer) => renderer.clearStencil();
    this.group.add(quad);

    return { plane, quad, quadMaterial, otherPlanes, backMaterial, frontMaterial, stencilMeshes };
  }

  private clearEntries(): void {
    for (const entry of this.entries) {
      for (const mesh of entry.stencilMeshes) mesh.removeFromParent();
      entry.stencilMeshes.length = 0;
      entry.quad.removeFromParent();
      entry.backMaterial.dispose();
      entry.frontMaterial.dispose();
      entry.quadMaterial.dispose();
    }
    this.entries = [];
  }
}

/** The renderer cannot tell us; the context attributes can. */
function detectStencil(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const attributes = gl.getContextAttributes();
    if (attributes) return attributes.stencil === true;
    return (gl.getParameter(gl.STENCIL_BITS) as number) > 0;
  } catch {
    return false;
  }
}
