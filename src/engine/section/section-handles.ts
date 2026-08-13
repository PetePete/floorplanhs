/**
 * Drag handles for the cut planes.
 *
 * A slider in a toolbar can move a section plane, but it never tells you *where*
 * the plane is. These do: a thin outline of the cut rectangle plus a knob you
 * grab, drawn on top of the model (depth test off — a gizmo you cannot see
 * inside the house is not a gizmo).
 *
 * Pointer events only, so a finger works exactly like a mouse. The listeners sit
 * on the canvas' container in the capture phase and stop propagation once a
 * handle is grabbed, so OrbitControls and the pointer router never see the
 * gesture that belongs to us.
 */

import * as THREE from 'three';
import type { Axis } from '@/types/config';
import type { RenderContext } from '@/engine/contracts';
import { clamp } from '@/util/math';

/** One draggable plane. `dir` is which half the clip keeps, for the outline hint. */
export interface SectionHandleSpec {
  axis: Axis;
  position: number;
  dir: 1 | -1;
}

export interface SectionHandlesOptions {
  /** Live drag callback — the section controller applies it without a tween. */
  onDrag: (axis: Axis, position: number) => void;
  /** Grid the dragged position snaps to, in metres. */
  snap?: number;
}

const AXIS_INDEX: Record<Axis, number> = { x: 0, y: 1, z: 2 };

/**
 * Muted, tasteful axis colours: saturated red/green/blue reads as a debug
 * helper, not as part of a floorplan.
 */
const AXIS_COLOR: Record<Axis, number> = { x: 0xc4756b, y: 0x8faa72, z: 0x6f8fbf };
const AXIS_COLOR_ACTIVE: Record<Axis, number> = { x: 0xe0988e, y: 0xb2cd94, z: 0x94b3e0 };

/** The two axes the cut rectangle spans, in (u, v) order. */
const PLANE_AXES: Record<Axis, [Axis, Axis]> = {
  x: ['z', 'y'],
  y: ['x', 'z'],
  z: ['x', 'y'],
};

interface Handle {
  axis: Axis;
  position: number;
  group: THREE.Group;
  outline: THREE.LineLoop;
  outlinePositions: Float32Array;
  knob: THREE.Mesh;
  hit: THREE.Mesh;
  lineMaterial: THREE.LineBasicMaterial;
  knobMaterial: THREE.MeshBasicMaterial;
  /** World-space point the knob sits at; also the origin of the drag axis. */
  anchor: THREE.Vector3;
}

interface DragState {
  handle: Handle;
  pointerId: number;
  /** Axis coordinate under the pointer when the drag started. */
  grabCoord: number;
  /** Plane position when the drag started. */
  startPosition: number;
  release: () => void;
}

export class SectionHandles {
  private ctx: RenderContext | null = null;
  private host: HTMLElement | null = null;

  private readonly root = new THREE.Group();
  private readonly handles = new Map<Axis, Handle>();
  private readonly bounds = new THREE.Box3();
  private readonly onDrag: (axis: Axis, position: number) => void;
  private readonly snap: number;

  private readonly knobGeometry = new THREE.CylinderGeometry(1, 1, 0.55, 20);
  private readonly hitGeometry = new THREE.SphereGeometry(1, 10, 8);
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();

  private readonly dragStartCallbacks = new Set<() => void>();
  private readonly dragEndCallbacks = new Set<() => void>();

  private visible = false;
  private drag: DragState | null = null;
  private hovered: Handle | null = null;
  private handleScale = 0.12;

  constructor(options: SectionHandlesOptions) {
    this.onDrag = options.onDrag;
    this.snap = options.snap && options.snap > 0 ? options.snap : 0.1;
    this.root.name = 'sectionHandles';
    this.root.visible = false;
    this.root.userData.fp3dInternal = true;
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.overlayRoot.add(this.root);

    // Capture phase on the container: it runs before any listener the camera
    // controller or the pointer router put on the canvas itself, whatever order
    // the subsystems happened to be constructed in.
    this.host = ctx.canvas.parentElement ?? ctx.canvas;
    this.host.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.host.addEventListener('pointermove', this.onHoverMove, { capture: true });
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.root.visible = visible && this.handles.size > 0;
    if (!visible) {
      this.endDrag();
      this.setHovered(null);
    }
    this.ctx?.invalidate();
  }

  isVisible(): boolean {
    return this.visible;
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  /** Fired when a handle is grabbed — wire this to `camera.setEnabled(false)`. */
  onDragStart(cb: () => void): () => void {
    this.dragStartCallbacks.add(cb);
    return () => {
      this.dragStartCallbacks.delete(cb);
    };
  }

  onDragEnd(cb: () => void): () => void {
    this.dragEndCallbacks.add(cb);
    return () => {
      this.dragEndCallbacks.delete(cb);
    };
  }

  /** Rebuild the handle set. Cheap enough to call on every plane move. */
  sync(specs: readonly SectionHandleSpec[], bounds: THREE.Box3): void {
    this.bounds.copy(bounds);
    if (this.bounds.isEmpty()) this.bounds.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 3, 5));

    const size = this.bounds.getSize(new THREE.Vector3());
    this.handleScale = clamp(size.length() * 0.016, 0.05, 0.32);

    const wanted = new Set<Axis>();
    for (const spec of specs) {
      wanted.add(spec.axis);
      const handle = this.handles.get(spec.axis) ?? this.createHandle(spec.axis);
      handle.position = spec.position;
      handle.group.visible = true;
      this.layout(handle);
    }

    for (const [axis, handle] of this.handles) {
      if (!wanted.has(axis)) handle.group.visible = false;
    }

    if (this.drag && !wanted.has(this.drag.handle.axis)) this.endDrag();
    this.root.visible = this.visible && wanted.size > 0;
    this.ctx?.invalidate();
  }

  dispose(): void {
    this.endDrag();
    if (this.host) {
      this.host.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
      this.host.removeEventListener('pointermove', this.onHoverMove, { capture: true });
      this.host = null;
    }
    window.removeEventListener('pointermove', this.onDragMove, { capture: true });
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerUp, { capture: true });

    for (const handle of this.handles.values()) {
      handle.outline.geometry.dispose();
      handle.lineMaterial.dispose();
      handle.knobMaterial.dispose();
      (handle.hit.material as THREE.Material).dispose();
      handle.group.removeFromParent();
    }
    this.handles.clear();
    this.knobGeometry.dispose();
    this.hitGeometry.dispose();
    this.root.removeFromParent();
    this.dragStartCallbacks.clear();
    this.dragEndCallbacks.clear();
    this.ctx = null;
  }

  /* -------------------------------------------------------------- geometry */

  private createHandle(axis: Axis): Handle {
    const color = AXIS_COLOR[axis];

    const outlinePositions = new Float32Array(12);
    const outlineGeometry = new THREE.BufferGeometry();
    outlineGeometry.setAttribute('position', new THREE.BufferAttribute(outlinePositions, 3));
    const lineMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false,
    });
    const outline = new THREE.LineLoop(outlineGeometry, lineMaterial);
    outline.renderOrder = 900;
    outline.raycast = () => {};

    const knobMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
      depthWrite: false,
    });
    const knob = new THREE.Mesh(this.knobGeometry, knobMaterial);
    knob.renderOrder = 901;
    knob.raycast = () => {};
    // The cylinder is Y-aligned; stand it on the axis it slides along.
    if (axis === 'x') knob.rotation.z = Math.PI / 2;
    else if (axis === 'z') knob.rotation.x = Math.PI / 2;

    // A generous invisible sphere: 40 px of finger needs more than a 5 cm knob.
    const hit = new THREE.Mesh(
      this.hitGeometry,
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.userData.axis = axis;

    const group = new THREE.Group();
    group.name = `sectionHandle:${axis}`;
    group.userData.fp3dInternal = true;
    group.add(outline, knob, hit);
    this.root.add(group);

    const handle: Handle = {
      axis,
      position: 0,
      group,
      outline,
      outlinePositions,
      knob,
      hit,
      lineMaterial,
      knobMaterial,
      anchor: new THREE.Vector3(),
    };
    this.handles.set(axis, handle);
    return handle;
  }

  /** Place the outline rectangle and the knob for the handle's current position. */
  private layout(handle: Handle): void {
    const [uAxis, vAxis] = PLANE_AXES[handle.axis];
    const ui = AXIS_INDEX[uAxis];
    const vi = AXIS_INDEX[vAxis];
    const ai = AXIS_INDEX[handle.axis];

    const pad = Math.max(this.bounds.getSize(new THREE.Vector3()).length() * 0.02, 0.05);
    const uMin = this.bounds.min.getComponent(ui) - pad;
    const uMax = this.bounds.max.getComponent(ui) + pad;
    const vMin = this.bounds.min.getComponent(vi) - pad;
    const vMax = this.bounds.max.getComponent(vi) + pad;

    const corners: Array<[number, number]> = [
      [uMin, vMin],
      [uMax, vMin],
      [uMax, vMax],
      [uMin, vMax],
    ];
    corners.forEach(([u, v], index) => {
      const offset = index * 3;
      handle.outlinePositions[offset + ai] = handle.position;
      handle.outlinePositions[offset + ui] = u;
      handle.outlinePositions[offset + vi] = v;
    });
    handle.outline.geometry.attributes.position.needsUpdate = true;
    handle.outline.geometry.computeBoundingSphere();

    // Knob on the outside edge of the rectangle so it is reachable without
    // orbiting into the house.
    handle.anchor.setComponent(ai, handle.position);
    handle.anchor.setComponent(ui, uMax);
    handle.anchor.setComponent(vi, (vMin + vMax) / 2);

    handle.knob.position.copy(handle.anchor);
    handle.knob.scale.setScalar(this.handleScale);
    handle.hit.position.copy(handle.anchor);
    handle.hit.scale.setScalar(this.handleScale * 2.6);
  }

  private setHovered(handle: Handle | null): void {
    if (this.hovered === handle) return;
    if (this.hovered) {
      this.hovered.knobMaterial.color.setHex(AXIS_COLOR[this.hovered.axis]);
      this.hovered.lineMaterial.opacity = 0.55;
    }
    this.hovered = handle;
    if (handle) {
      handle.knobMaterial.color.setHex(AXIS_COLOR_ACTIVE[handle.axis]);
      handle.lineMaterial.opacity = 0.9;
    }
    this.ctx?.invalidate();
  }

  /* --------------------------------------------------------------- pointer */

  private pick(event: PointerEvent): Handle | null {
    const ctx = this.ctx;
    if (!ctx || !this.visible) return null;
    const rect = ctx.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, ctx.activeCamera);

    const targets: THREE.Object3D[] = [];
    for (const handle of this.handles.values()) {
      if (handle.group.visible) targets.push(handle.hit);
    }
    if (targets.length === 0) return null;

    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) return null;
    const axis = hits[0].object.userData.axis as Axis | undefined;
    return axis ? this.handles.get(axis) ?? null : null;
  }

  private readonly onHoverMove = (event: PointerEvent): void => {
    if (this.drag || !this.visible) return;
    this.setHovered(this.pick(event));
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.visible || this.drag) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;

    const handle = this.pick(event);
    if (!handle) return;

    const coord = this.axisCoordinate(handle, event);
    if (coord === null) return;

    // Ours now: nobody else gets to start orbiting or placing on this gesture.
    event.stopPropagation();
    event.stopImmediatePropagation();
    event.preventDefault();

    this.drag = {
      handle,
      pointerId: event.pointerId,
      grabCoord: coord,
      startPosition: handle.position,
      release: this.ctx ? this.ctx.holdContinuous() : () => {},
    };
    this.setHovered(handle);

    window.addEventListener('pointermove', this.onDragMove, { capture: true });
    window.addEventListener('pointerup', this.onPointerUp, { capture: true });
    window.addEventListener('pointercancel', this.onPointerUp, { capture: true });

    for (const cb of [...this.dragStartCallbacks]) cb();
  };

  private readonly onDragMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.stopPropagation();
    event.preventDefault();

    const coord = this.axisCoordinate(drag.handle, event);
    if (coord === null) return;

    const ai = AXIS_INDEX[drag.handle.axis];
    const min = this.bounds.min.getComponent(ai) - 0.5;
    const max = this.bounds.max.getComponent(ai) + 0.5;
    const raw = drag.startPosition + (coord - drag.grabCoord);
    const snapped = Math.round(raw / this.snap) * this.snap;
    const next = clamp(Number(snapped.toFixed(4)), min, max);

    if (next === drag.handle.position) return;
    drag.handle.position = next;
    this.layout(drag.handle);
    this.onDrag(drag.handle.axis, next);
    this.ctx?.invalidate();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    event.stopPropagation();
    this.endDrag();
  };

  private endDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    drag.release();
    window.removeEventListener('pointermove', this.onDragMove, { capture: true });
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerUp, { capture: true });
    this.setHovered(null);
    for (const cb of [...this.dragEndCallbacks]) cb();
    this.ctx?.invalidate();
  }

  /**
   * Where the pointer ray comes closest to the handle's drag axis, expressed as
   * a world coordinate on that axis. Returns null when the ray is (near)
   * parallel to the axis and the answer would be meaningless.
   */
  private axisCoordinate(handle: Handle, event: PointerEvent): number | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const rect = ctx.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, ctx.activeCamera);

    const ray = this.raycaster.ray;
    const axisDir = new THREE.Vector3();
    axisDir.setComponent(AXIS_INDEX[handle.axis], 1);

    const w0 = new THREE.Vector3().subVectors(ray.origin, handle.anchor);
    const b = ray.direction.dot(axisDir);
    const denominator = 1 - b * b;
    if (Math.abs(denominator) < 1e-5) return null;

    const d = ray.direction.dot(w0);
    const e = axisDir.dot(w0);
    const t = (e - b * d) / denominator;

    const coordinate = handle.anchor.getComponent(AXIS_INDEX[handle.axis]) + t;
    return Number.isFinite(coordinate) ? coordinate : null;
  }
}
