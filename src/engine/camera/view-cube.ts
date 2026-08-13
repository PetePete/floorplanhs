/**
 * A Fusion-style ViewCube: a small labelled cube in a corner of the viewport
 * that shows where you are looking from, snaps the camera to a face, edge or
 * corner when clicked, and orbits with the camera when dragged.
 *
 * **Integration.** The cube lives in its own tiny `THREE.Scene` with its own
 * orthographic camera and is drawn by `render()` *after* the main pass, into a
 * scissored corner rect with `autoClear = false`. That choice falls out of the
 * requirements rather than being a preference:
 *
 * - `PostFx` owns the final image, and its bloom path renders the main scene
 *   into render targets. Anything living in the main scene therefore goes
 *   *through* bloom and tone mapping. A separate scene drawn after the composer
 *   cannot be bloomed, cannot be clipped by the section planes (the section
 *   controller only ever walks `ctx.modelRoot`) and does not care about the
 *   section state at all.
 * - A second `WebGLRenderer` would cost a second GL context — browsers cap
 *   those, and a dashboard cycles through cards.
 *
 * We only ever clear *depth* inside the scissor rect, never colour: the
 * renderer runs with `alpha: true` and a transparent clear, so clearing colour
 * here would punch a hole in the card.
 *
 * **Zones.** All 26 pickable regions (6 faces, 12 edges, 8 corners) come from a
 * single raycast against one box. The hit point's local coordinates say which:
 * the dominant axis is the face, and any *other* axis whose coordinate is near
 * the face border promotes the pick to an edge or a corner. No extra geometry,
 * no 26-mesh scene graph.
 */

import * as THREE from 'three';
import type { RenderContext } from '@/engine/contracts';
import { clamp } from '@/util/math';

export type ViewCubeCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/** Face labels, in `+X -X +Y -Y +Z -Z` order — the order `BoxGeometry` uses. */
export interface ViewCubeLabels {
  right: string;
  left: string;
  top: string;
  bottom: string;
  /** The model faces -Z by default (see ARCHITECTURE), so -Z is the front. */
  front: string;
  back: string;
}

export const DEFAULT_VIEW_CUBE_LABELS: ViewCubeLabels = {
  right: 'Right',
  left: 'Left',
  top: 'Top',
  bottom: 'Bottom',
  front: 'Front',
  back: 'Back',
};

/** Everything the cube needs from the camera controller. */
export interface ViewCubeCameraBridge {
  /** Unit vector from the orbit target towards the camera, world space. */
  getViewDirection(out: THREE.Vector3): THREE.Vector3;
  getUp(out: THREE.Vector3): THREE.Vector3;
  /** Fly to `direction` (world space, from target to camera), same distance. */
  snapTo(direction: THREE.Vector3, animate: boolean): Promise<void>;
  /** 1:1 drag orbit, radians. Mirrors OrbitControls' own sign convention. */
  orbitBy(deltaTheta: number, deltaPhi: number): void;
  /** Continuous lease for the duration of a drag. */
  holdContinuous(): () => void;
  invalidate(): void;
}

export interface ViewCubeOptions {
  labels?: Partial<ViewCubeLabels>;
  corner?: ViewCubeCorner;
  /** Edge length in CSS px at normal size. */
  size?: number;
  /** Edge length in CSS px when the card is narrow. */
  compactSize?: number;
  /** Below this canvas width the compact size is used. */
  compactBelow?: number;
  /** Distance from the viewport edges, CSS px. `y` clears the toolbar. */
  margin?: { x: number; y: number };
  /** Snap flights are animated unless the user asked for reduced motion. */
  animate?: boolean;
}

const DEFAULTS = {
  corner: 'top-right' as ViewCubeCorner,
  size: 96,
  compactSize: 72,
  compactBelow: 420,
  // 44px of vertical clearance keeps the cube clear of the overlay toolbar.
  margin: { x: 12, y: 48 },
  animate: true,
};

/** Half-width of the border band that turns a face pick into an edge/corner. */
const EDGE_BAND = 0.17;
/** Cube half-extent in its own scene. */
const HALF = 0.5;
/** Full turn per this many cube widths dragged. */
const DRAG_TURNS_PER_WIDTH = Math.PI;

const FACE_COLOR = 0xdfe3ea;
const FACE_COLOR_DARK = 0xb9c0cc;
const HIGHLIGHT_COLOR = 0x6f9fe0;
const EDGE_LINE_COLOR = 0x8b93a1;

/** Local axis order of `BoxGeometry`'s material groups. */
const FACE_AXES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

type LabelKey = keyof ViewCubeLabels;
const FACE_LABEL_KEYS: readonly LabelKey[] = ['right', 'left', 'top', 'bottom', 'back', 'front'];

const ATLAS_COLS = 3;
const ATLAS_ROWS = 2;
const ATLAS_CELL = 128;

export class ViewCube {
  private ctx: RenderContext | null = null;
  private host: HTMLElement | null = null;

  private readonly bridge: ViewCubeCameraBridge;
  private readonly options: Required<ViewCubeOptions> & { labels: ViewCubeLabels };

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-0.95, 0.95, 0.95, -0.95, 0.01, 20);
  private readonly cube: THREE.Mesh;
  private readonly geometry: THREE.BoxGeometry;
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private readonly outline: THREE.LineSegments;
  private readonly outlineGeometry: THREE.EdgesGeometry;
  private readonly outlineMaterial: THREE.LineBasicMaterial;
  private readonly highlight: THREE.Mesh;
  private readonly highlightGeometry: THREE.BoxGeometry;
  private readonly highlightMaterial: THREE.MeshBasicMaterial;
  private texture: THREE.CanvasTexture | null = null;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchUp = new THREE.Vector3();
  private readonly savedViewport = new THREE.Vector4();
  private readonly savedScissor = new THREE.Vector4();

  private hoverZone: THREE.Vector3 | null = null;
  private visible = true;
  private disposed = false;

  private drag: {
    pointerId: number;
    lastX: number;
    lastY: number;
    moved: number;
    zone: THREE.Vector3 | null;
    release: () => void;
  } | null = null;

  constructor(bridge: ViewCubeCameraBridge, options: ViewCubeOptions = {}) {
    this.bridge = bridge;
    this.options = {
      labels: { ...DEFAULT_VIEW_CUBE_LABELS, ...(options.labels ?? {}) },
      corner: options.corner ?? DEFAULTS.corner,
      size: options.size ?? DEFAULTS.size,
      compactSize: options.compactSize ?? DEFAULTS.compactSize,
      compactBelow: options.compactBelow ?? DEFAULTS.compactBelow,
      margin: options.margin ?? { ...DEFAULTS.margin },
      animate: options.animate ?? DEFAULTS.animate,
    };

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    remapAtlasUvs(this.geometry);

    this.texture = buildLabelAtlas(this.options.labels);
    for (let face = 0; face < 6; face += 1) {
      this.materials.push(
        new THREE.MeshBasicMaterial({
          map: this.texture,
          // Top/bottom a touch darker: a flat-shaded cube with six identical
          // faces reads as a square, not as a solid.
          color: face === 2 || face === 3 ? FACE_COLOR_DARK : FACE_COLOR,
          toneMapped: false,
          transparent: true,
          opacity: 0.96,
        }),
      );
    }
    this.cube = new THREE.Mesh(this.geometry, this.materials);
    this.cube.name = 'viewCube';

    this.outlineGeometry = new THREE.EdgesGeometry(this.geometry);
    this.outlineMaterial = new THREE.LineBasicMaterial({
      color: EDGE_LINE_COLOR,
      transparent: true,
      opacity: 0.8,
      toneMapped: false,
    });
    this.outline = new THREE.LineSegments(this.outlineGeometry, this.outlineMaterial);
    this.outline.raycast = () => {};

    // One reusable box covers all 26 zones: constrained axes become a thin
    // slice at the relevant side, free axes span the whole cube. A face is one
    // constrained axis, an edge two, a corner three.
    this.highlightGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.highlightMaterial = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      toneMapped: false,
    });
    this.highlight = new THREE.Mesh(this.highlightGeometry, this.highlightMaterial);
    this.highlight.visible = false;
    this.highlight.renderOrder = 2;
    this.highlight.raycast = () => {};

    this.scene.add(this.cube, this.outline, this.highlight);
    this.camera.position.set(0, 0, 3);
    this.camera.lookAt(0, 0, 0);
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // Capture phase on the canvas' parent, exactly like the pointer router and
    // the section handles: it is the only place we can take a gesture away from
    // OrbitControls, which binds to the canvas itself.
    this.host = ctx.canvas.parentElement ?? ctx.canvas;
    this.host.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.host.addEventListener('pointermove', this.onHoverMove, { capture: true });
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.endDrag();
      this.setHover(null);
    }
    this.ctx?.invalidate();
  }

  isVisible(): boolean {
    return this.visible;
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  /**
   * Draw the cube. Must be called once per frame *after* the main pass (and
   * after `PostFx.render`, which owns the final image).
   */
  render(): void {
    const ctx = this.ctx;
    if (!ctx || !this.visible || this.disposed) return;
    const rect = this.rect();
    if (!rect) return;

    // Mirror the main camera's orientation about the orbit target: the cube's
    // local axes are then world axes, which is what makes a zone direction
    // directly usable as a camera direction.
    this.bridge.getViewDirection(this.scratchDir);
    if (this.scratchDir.lengthSq() < 1e-8) this.scratchDir.set(0, 0, 1);
    this.camera.position.copy(this.scratchDir).multiplyScalar(3);
    this.camera.up.copy(this.bridge.getUp(this.scratchUp));
    // Straight down the up axis, `lookAt` has no defined roll and produces NaNs.
    if (Math.abs(this.camera.up.dot(this.scratchDir)) > 0.9995) this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    const renderer = ctx.renderer;
    const previousAutoClear = renderer.autoClear;
    const previousScissorTest = renderer.getScissorTest();
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);

    renderer.autoClear = false;
    renderer.setViewport(rect.x, rect.yFromBottom, rect.size, rect.size);
    renderer.setScissor(rect.x, rect.yFromBottom, rect.size, rect.size);
    renderer.setScissorTest(true);
    // Depth only — clearing colour would punch a transparent hole in the card.
    renderer.clearDepth();
    try {
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setScissorTest(previousScissorTest);
      renderer.setViewport(this.savedViewport);
      renderer.setScissor(this.savedScissor);
      renderer.autoClear = previousAutoClear;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.endDrag();
    if (this.host) {
      this.host.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
      this.host.removeEventListener('pointermove', this.onHoverMove, { capture: true });
      this.host = null;
    }
    window.removeEventListener('pointermove', this.onDragMove, { capture: true });
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerUp, { capture: true });

    this.scene.clear();
    this.geometry.dispose();
    this.outlineGeometry.dispose();
    this.outlineMaterial.dispose();
    this.highlightGeometry.dispose();
    this.highlightMaterial.dispose();
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.texture?.dispose();
    this.texture = null;
    this.ctx = null;
  }

  /* ---------------------------------------------------------------- layout */

  /** Corner rect in CSS px. `yFromBottom` is what `setViewport` wants. */
  private rect(): { x: number; y: number; yFromBottom: number; size: number } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const { width, height } = ctx.size;
    if (width <= 0 || height <= 0) return null;

    const size = width < this.options.compactBelow ? this.options.compactSize : this.options.size;
    if (size * 2 > Math.min(width, height)) return null;

    const { x: marginX, y: marginY } = this.options.margin;
    const corner = this.options.corner;
    const x = corner.endsWith('right') ? width - size - marginX : marginX;
    const y = corner.startsWith('top') ? marginY : height - size - marginY;
    return { x, y, yFromBottom: height - y - size, size };
  }

  /* --------------------------------------------------------------- picking */

  /**
   * Pointer -> zone. Returns null when the pointer is outside the corner rect
   * or misses the cube, which is also the signal to leave the gesture alone.
   */
  private pick(clientX: number, clientY: number): THREE.Vector3 | null {
    const ctx = this.ctx;
    if (!ctx || !this.visible) return null;
    const rect = this.rect();
    if (!rect) return null;

    const canvasRect = ctx.canvas.getBoundingClientRect();
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return null;
    // The canvas may be CSS-scaled relative to the logical size the viewport
    // rect is expressed in; normalise through the ratio rather than assuming.
    const scaleX = ctx.size.width / canvasRect.width;
    const scaleY = ctx.size.height / canvasRect.height;
    const localX = (clientX - canvasRect.left) * scaleX;
    const localY = (clientY - canvasRect.top) * scaleY;

    if (
      localX < rect.x ||
      localX > rect.x + rect.size ||
      localY < rect.y ||
      localY > rect.y + rect.size
    ) {
      return null;
    }

    this.pointer.set(
      ((localX - rect.x) / rect.size) * 2 - 1,
      -(((localY - rect.y) / rect.size) * 2 - 1),
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.cube, false);
    if (hits.length === 0) return null;

    return zoneFromLocalPoint(this.cube.worldToLocal(hits[0].point.clone()));
  }

  private setHover(zone: THREE.Vector3 | null): void {
    const same =
      (this.hoverZone === null && zone === null) ||
      (this.hoverZone !== null && zone !== null && this.hoverZone.equals(zone));
    if (same) return;

    this.hoverZone = zone;
    if (!zone) {
      this.highlight.visible = false;
    } else {
      this.highlight.visible = true;
      // Constrained axes get a thin slice sitting on the surface; free axes
      // span the cube. Half of the slice pokes out, which is what makes an
      // edge or corner pick legible.
      for (let axis = 0; axis < 3; axis += 1) {
        const component = zone.getComponent(axis);
        if (component === 0) {
          this.highlight.scale.setComponent(axis, 1.005);
          this.highlight.position.setComponent(axis, 0);
        } else {
          this.highlight.scale.setComponent(axis, EDGE_BAND);
          this.highlight.position.setComponent(axis, component * HALF);
        }
      }
      this.highlight.updateMatrix();
    }

    const canvas = this.ctx?.canvas;
    if (canvas) canvas.style.cursor = zone ? 'pointer' : '';
    this.ctx?.invalidate();
  }

  /* --------------------------------------------------------------- pointer */

  private readonly onHoverMove = (event: PointerEvent): void => {
    if (this.drag || !this.visible || event.buttons !== 0) return;
    if (event.pointerType === 'touch') return;
    this.setHover(this.pick(event.clientX, event.clientY));
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.visible || this.drag || this.disposed) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    const zone = this.pick(event.clientX, event.clientY);
    if (!zone) return;

    // Ours: neither the pointer router nor OrbitControls may see this gesture.
    event.stopPropagation();
    event.stopImmediatePropagation();
    event.preventDefault();

    this.drag = {
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: 0,
      zone,
      release: this.bridge.holdContinuous(),
    };
    this.setHover(zone);

    window.addEventListener('pointermove', this.onDragMove, { capture: true });
    window.addEventListener('pointerup', this.onPointerUp, { capture: true });
    window.addEventListener('pointercancel', this.onPointerUp, { capture: true });
  };

  private readonly onDragMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    event.preventDefault();

    const rect = this.rect();
    const size = rect ? rect.size : this.options.size;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.moved += Math.hypot(dx, dy);

    // Below the tap threshold this is still a click, not an orbit.
    if (drag.moved <= 4) return;
    drag.zone = null;
    this.setHover(null);
    this.bridge.orbitBy(
      (dx / size) * DRAG_TURNS_PER_WIDTH,
      (dy / size) * DRAG_TURNS_PER_WIDTH,
    );
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    const zone = drag.moved <= 4 ? drag.zone : null;
    this.endDrag();
    if (zone) void this.bridge.snapTo(zone.clone().normalize(), this.options.animate);
  };

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.release();
    window.removeEventListener('pointermove', this.onDragMove, { capture: true });
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerUp, { capture: true });
    this.setHover(null);
  }
}

/* ------------------------------------------------------------------ zones */

/**
 * Classify a point on the cube surface. The dominant axis is the face; the
 * other two promote the pick to an edge or a corner when they sit inside the
 * border band.
 */
function zoneFromLocalPoint(point: THREE.Vector3): THREE.Vector3 {
  const abs = [Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)];
  let dominant = 0;
  if (abs[1] > abs[dominant]) dominant = 1;
  if (abs[2] > abs[dominant]) dominant = 2;

  const zone = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis += 1) {
    const value = point.getComponent(axis);
    if (axis === dominant) {
      zone.setComponent(axis, value >= 0 ? 1 : -1);
    } else if (Math.abs(value) > HALF - EDGE_BAND) {
      zone.setComponent(axis, value >= 0 ? 1 : -1);
    }
  }
  return zone;
}

/* ----------------------------------------------------------------- labels */

/**
 * One canvas texture for all six faces: a 3x2 atlas the box UVs are remapped
 * into. Six separate textures would mean six uploads and six disposals for
 * what is a single 384x256 bitmap.
 */
function buildLabelAtlas(labels: ViewCubeLabels): THREE.CanvasTexture | null {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_COLS * ATLAS_CELL;
  canvas.height = ATLAS_ROWS * ATLAS_CELL;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  FACE_LABEL_KEYS.forEach((key, face) => {
    const col = face % ATLAS_COLS;
    const row = Math.floor(face / ATLAS_COLS);
    // Texture v runs bottom-up, canvas y runs top-down.
    const x = col * ATLAS_CELL;
    const y = (ATLAS_ROWS - 1 - row) * ATLAS_CELL;

    context.fillStyle = '#ffffff';
    context.fillRect(x, y, ATLAS_CELL, ATLAS_CELL);
    context.strokeStyle = 'rgba(70, 80, 96, 0.35)';
    context.lineWidth = 4;
    context.strokeRect(x + 2, y + 2, ATLAS_CELL - 4, ATLAS_CELL - 4);

    context.fillStyle = '#2b3038';
    context.font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(labels[key], x + ATLAS_CELL / 2, y + ATLAS_CELL / 2, ATLAS_CELL - 16);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 2;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Point each `BoxGeometry` face at its own atlas cell. Face `f` owns vertices
 * `[f*4, f*4+4)` and its UVs already span the unit square.
 */
function remapAtlasUvs(geometry: THREE.BoxGeometry): void {
  const uv = geometry.getAttribute('uv');
  for (let face = 0; face < FACE_AXES.length; face += 1) {
    const col = face % ATLAS_COLS;
    const row = Math.floor(face / ATLAS_COLS);
    for (let vertex = 0; vertex < 4; vertex += 1) {
      const index = face * 4 + vertex;
      const u = clamp(uv.getX(index), 0, 1);
      const v = clamp(uv.getY(index), 0, 1);
      uv.setXY(index, (col + u) / ATLAS_COLS, (row + v) / ATLAS_ROWS);
    }
  }
  uv.needsUpdate = true;
}
