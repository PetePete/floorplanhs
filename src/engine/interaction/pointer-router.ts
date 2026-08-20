/**
 * Single owner of pointer input on the canvas.
 *
 * Everything is Pointer Events — there is no separate mouse and touch path,
 * because two paths always drift apart and the touch one is the one that rots.
 *
 * Listeners are attached to the canvas' *parent* in the capture phase. That is
 * deliberate: `OrbitControls` binds to the canvas itself, so capturing one node
 * up is the only place we can `stopPropagation()` and stop the camera from
 * reacting to a gesture a marker or a gizmo has claimed. Without it the marker
 * drags and the camera orbits at the same time.
 *
 * Priority chain (highest first): section handles -> placement/move -> entity
 * markers -> camera orbit (which is simply "nobody claimed it").
 */

import type {
  ICameraController,
  IEntityLayer,
  IPlacementController,
  RenderContext,
  Subsystem,
  ViewerEvents,
} from '@/engine/contracts';
import type { Emitter } from '@/util/events';

export type PointerKind = 'mouse' | 'touch' | 'pen';

/**
 * A normalised pointer event.
 *
 * The object is reused between dispatches — read what you need, do not retain
 * it. Handlers run synchronously, so this is safe and keeps a 120 Hz pointer
 * stream from allocating.
 */
export interface PointerSample {
  readonly pointerId: number;
  readonly pointerType: PointerKind;
  readonly clientX: number;
  readonly clientY: number;
  /** Normalised device coordinates for raycasting. */
  readonly ndc: { readonly x: number; readonly y: number };
  /** Movement since the previous event, CSS px. */
  readonly dx: number;
  readonly dy: number;
  /** Total travel since pointerdown, CSS px. */
  readonly distance: number;
  /** Milliseconds since pointerdown. */
  readonly elapsed: number;
  readonly buttons: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** Number of pointers currently down. >1 means a multi-touch gesture. */
  readonly pointerCount: number;
  readonly native: PointerEvent;
  /** True once this gesture has been claimed by some handler. */
  readonly claimed: boolean;
  /**
   * Take ownership of this gesture: lower-priority handlers and the camera
   * stop receiving it, and touch events start being `preventDefault`ed.
   */
  claim(): void;
}

export interface GestureHandler {
  readonly id: string;
  /** Higher runs first. See `GESTURE_PRIORITY`. */
  readonly priority: number;
  isEnabled?(): boolean;
  onHover?(ev: PointerSample): void;
  onDown?(ev: PointerSample): void;
  onDragStart?(ev: PointerSample): void;
  onDrag?(ev: PointerSample): void;
  onDragEnd?(ev: PointerSample): void;
  onTap?(ev: PointerSample): void;
  onDoubleTap?(ev: PointerSample): void;
  onHold?(ev: PointerSample): void;
  /** Gesture aborted (pointercancel, second finger, disposal). */
  onCancel?(): void;
}

export const GESTURE_PRIORITY = {
  section: 400,
  placement: 300,
  entity: 200,
  camera: 0,
} as const;

export interface PointerRouterOptions {
  /** Max travel for a press to still count as a tap. */
  tapMaxPx?: number;
  tapMaxMs?: number;
  /** Stationary press duration that becomes a hold. Works with a mouse too. */
  holdMs?: number;
  doubleTapMs?: number;
  doubleTapPx?: number;
  dragThresholdPx?: number;
}

/**
 * `IEntityLayer.pick` only declares the NDC argument, but our `EntityLayer`
 * accepts a pointer-type hint that widens the hit target for fingers. Narrow
 * to this structural type rather than losing the contract entirely.
 */
interface PointerAwarePick {
  pick(ndc: { x: number; y: number }, options?: { pointerType?: PointerKind }): string | null;
  /** Anchor or label; see `EntityLayer.pickPart`. Absent on a stub layer. */
  pickPart?(
    ndc: { x: number; y: number },
    options?: { pointerType?: PointerKind },
  ): { entityId: string; part: 'anchor' | 'label' } | null;
}

type GestureMethod =
  | 'onHover'
  | 'onDown'
  | 'onDragStart'
  | 'onDrag'
  | 'onDragEnd'
  | 'onTap'
  | 'onDoubleTap'
  | 'onHold';

interface PrimaryPointer {
  id: number;
  type: PointerKind;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  distance: number;
  dragging: boolean;
  holdFired: boolean;
  /** Marker under the initial press, resolved once. */
  entityId: string | null;
}

const DEFAULTS: Required<PointerRouterOptions> = {
  tapMaxPx: 8,
  tapMaxMs: 400,
  holdMs: 500,
  doubleTapMs: 300,
  doubleTapPx: 24,
  dragThresholdPx: 6,
};

export class PointerRouter implements Subsystem {
  /** Which part of the marker this gesture went down on; see `pickUp`. */
  private grabbedPart: 'anchor' | 'label' | null = null;
  private readonly handlers: GestureHandler[] = [];
  private readonly options: Required<PointerRouterOptions>;

  private ctx: RenderContext | null = null;
  private eventTarget: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private rect: DOMRect | null = null;

  private readonly activePointers = new Set<number>();
  private primary: PrimaryPointer | null = null;
  private claimant: GestureHandler | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTap: { x: number; y: number; time: number } | null = null;
  private pendingTapTimer: ReturnType<typeof setTimeout> | null = null;

  private multiTouch = false;
  private enabled = true;
  private editMode = false;
  private doubleTapEnabled = false;
  private cameraSuspended = false;
  private hoveredEntity: string | null = null;
  private disposed = false;

  /** Reused dispatch payload; see `PointerSample`. */
  private readonly sample = {
    pointerId: -1,
    pointerType: 'mouse' as PointerKind,
    clientX: 0,
    clientY: 0,
    ndc: { x: 0, y: 0 },
    dx: 0,
    dy: 0,
    distance: 0,
    elapsed: 0,
    buttons: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    pointerCount: 0,
    native: null as unknown as PointerEvent,
    claimed: false,
    claim: (): void => {
      this.sample.claimed = true;
    },
  };

  constructor(
    private readonly entities: IEntityLayer,
    private readonly placement: IPlacementController,
    private readonly camera: ICameraController,
    private readonly emitter: Emitter<ViewerEvents>,
    options: PointerRouterOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.handlers.push(this.placementHandler, this.entityHandler);
    this.sortHandlers();
  }

  /* ------------------------------------------------------------ lifecycle */

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.canvas = ctx.canvas;
    // One node up so we run before OrbitControls, which binds to the canvas.
    this.eventTarget = ctx.canvas.parentElement ?? ctx.canvas;
    this.refreshRect();

    const target = this.eventTarget;
    target.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    target.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: false });
    target.addEventListener('pointerup', this.onPointerUp, { capture: true });
    target.addEventListener('pointercancel', this.onPointerCancel, { capture: true });
    target.addEventListener('lostpointercapture', this.onLostCapture, { capture: true });
    // Long-press on Android raises the context menu right in the middle of a
    // hold gesture; on desktop right-click is a camera pan.
    ctx.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  resize(_width: number, _height: number): void {
    this.refreshRect();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.abortGesture();
    this.clearHoldTimer();
    if (this.pendingTapTimer) clearTimeout(this.pendingTapTimer);
    this.pendingTapTimer = null;

    const target = this.eventTarget;
    if (target) {
      target.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
      target.removeEventListener('pointermove', this.onPointerMove, { capture: true });
      target.removeEventListener('pointerup', this.onPointerUp, { capture: true });
      target.removeEventListener('pointercancel', this.onPointerCancel, { capture: true });
      target.removeEventListener('lostpointercapture', this.onLostCapture, { capture: true });
    }
    this.canvas?.removeEventListener('contextmenu', this.onContextMenu);

    this.handlers.length = 0;
    this.activePointers.clear();
    this.eventTarget = null;
    this.canvas = null;
    this.ctx = null;
  }

  /* ----------------------------------------------------------- public API */

  /** Register an external gesture handler (section handles, gizmos). */
  subscribe(handler: GestureHandler): () => void {
    this.handlers.push(handler);
    this.sortHandlers();
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
      if (this.claimant === handler) this.claimant = null;
    };
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.abortGesture();
  }

  setEditMode(enabled: boolean): void {
    this.editMode = enabled;
  }

  /**
   * Delay taps by `doubleTapMs` so a second tap can be recognised. Off by
   * default — the latency is only worth paying when some entity actually has a
   * `double_tap_action`, which only the card knows.
   */
  setDoubleTapEnabled(enabled: boolean): void {
    this.doubleTapEnabled = enabled;
  }

  isGestureActive(): boolean {
    return this.primary !== null;
  }

  isClaimed(): boolean {
    return this.claimant !== null;
  }

  getPointerCount(): number {
    return this.activePointers.size;
  }

  /* -------------------------------------------------------- DOM listeners */

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.disposed) return;
    this.activePointers.add(event.pointerId);

    if (this.activePointers.size > 1) {
      // Second finger. If we own a gesture we simply ignore it; otherwise the
      // whole pinch/rotate belongs to OrbitControls and must pass through
      // completely untouched, so no preventDefault and no stopPropagation.
      if (!this.claimant) {
        this.multiTouch = true;
        this.abortGesture(false);
      }
      return;
    }

    this.refreshRect();
    const type = normalisePointerType(event.pointerType);
    this.primary = {
      id: event.pointerId,
      type,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startTime: event.timeStamp,
      distance: 0,
      dragging: false,
      holdFired: false,
      entityId: null,
    };

    this.fill(event, 0, 0);
    // Which *part* was grabbed decides what a drag means, so it is settled here,
    // on the way down, and not re-picked mid-drag when the pointer has already
    // left the marker.
    const part = this.pickEntityPart(this.sample.ndc, type);
    this.primary.entityId = part?.entityId ?? null;
    this.grabbedPart = part?.part ?? null;
    this.dispatch('onDown');

    if (this.sample.claimed) this.capture(event);
    this.startHoldTimer();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled || this.disposed) return;

    const primary = this.primary;
    if (!primary || primary.id !== event.pointerId) {
      // No press in flight: hover feedback, mouse and pen only.
      if (!primary && !this.multiTouch && event.pointerType !== 'touch') this.handleHover(event);
      return;
    }

    const dx = event.clientX - primary.lastX;
    const dy = event.clientY - primary.lastY;
    primary.lastX = event.clientX;
    primary.lastY = event.clientY;
    primary.distance = Math.hypot(
      event.clientX - primary.startX,
      event.clientY - primary.startY,
    );

    this.fill(event, dx, dy);

    if (!primary.dragging && primary.distance > this.options.dragThresholdPx) {
      primary.dragging = true;
      this.clearHoldTimer();
      this.dispatch('onDragStart');
    } else if (primary.dragging) {
      this.dispatch('onDrag');
    } else {
      return;
    }

    if (this.claimant) this.consume(event);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    const primary = this.primary;

    if (!primary || primary.id !== event.pointerId) {
      if (this.activePointers.size === 0) this.multiTouch = false;
      return;
    }

    this.clearHoldTimer();
    const dx = event.clientX - primary.lastX;
    const dy = event.clientY - primary.lastY;
    primary.lastX = event.clientX;
    primary.lastY = event.clientY;
    primary.distance = Math.hypot(
      event.clientX - primary.startX,
      event.clientY - primary.startY,
    );
    this.fill(event, dx, dy);

    if (primary.dragging) {
      this.dispatch('onDragEnd');
    } else if (
      !primary.holdFired &&
      primary.distance <= this.options.tapMaxPx &&
      this.sample.elapsed <= this.options.tapMaxMs
    ) {
      this.resolveTap(event);
    }

    if (this.claimant) this.consume(event);
    this.releaseCapture(event.pointerId);
    this.endGesture();
    if (this.activePointers.size === 0) this.multiTouch = false;
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.primary?.id === event.pointerId) {
      this.releaseCapture(event.pointerId);
      this.abortGesture();
    }
    if (this.activePointers.size === 0) this.multiTouch = false;
  };

  private readonly onLostCapture = (event: PointerEvent): void => {
    // Losing capture mid-drag (browser gesture takeover, element removal) has
    // to unwind the gesture or the claimant is stuck holding the pointer.
    if (this.primary?.id === event.pointerId && this.primary.dragging) {
      this.activePointers.delete(event.pointerId);
      this.abortGesture();
    }
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  /* ---------------------------------------------------------- built-ins */

  /** Placement and marker-move. Runs above plain marker interaction. */
  private readonly placementHandler: GestureHandler = {
    id: 'placement',
    priority: GESTURE_PRIORITY.placement,
    onHold: (ev) => {
      // Long-press a marker in edit mode to pick it up. This is the only
      // drag-to-move affordance a finger has.
      if (!this.editMode || this.placement.isActive()) return;
      const entityId = this.primary?.entityId;
      if (!entityId) return;
      this.pickUp(entityId);
      this.placement.updatePlacement(ev.clientX, ev.clientY);
      ev.claim();
    },
    onDragStart: (ev) => {
      if (this.placement.isActive()) {
        this.placement.updatePlacement(ev.clientX, ev.clientY);
        ev.claim();
        return;
      }
      if (!this.editMode) return;
      const entityId = this.primary?.entityId;
      if (!entityId) return;
      this.pickUp(entityId);
      this.placement.updatePlacement(ev.clientX, ev.clientY);
      ev.claim();
    },
    onDrag: (ev) => {
      if (!this.placement.isActive()) return;
      this.placement.updatePlacement(ev.clientX, ev.clientY);
      ev.claim();
    },
    onDragEnd: (ev) => {
      if (!this.placement.isActive()) return;
      this.placement.commitPlacement(ev.clientX, ev.clientY);
      ev.claim();
    },
    onCancel: () => {
      if (this.placement.isActive()) this.placement.cancelPlacement();
    },
  };

  /** Selection, hover and the tap/hold/double-tap activations. */
  private readonly entityHandler: GestureHandler = {
    id: 'entity',
    priority: GESTURE_PRIORITY.entity,
    onHover: (ev) => {
      this.setHover(this.pickEntity(ev.ndc, ev.pointerType));
    },
    onTap: (ev) => {
      const entityId = this.primary?.entityId ?? null;
      this.entities.setSelected(entityId);
      if (!entityId) return;
      this.emitter.emit('entity-activate', { entityId, action: 'tap' });
      ev.claim();
    },
    onDoubleTap: (ev) => {
      const entityId = this.primary?.entityId ?? null;
      if (!entityId) return;
      this.emitter.emit('entity-activate', { entityId, action: 'double-tap' });
      ev.claim();
    },
    onHold: (ev) => {
      const entityId = this.primary?.entityId ?? null;
      if (!entityId) return;
      this.entities.setSelected(entityId);
      this.emitter.emit('entity-activate', { entityId, action: 'hold' });
      ev.claim();
    },
  };

  /* ------------------------------------------------------------ internals */

  private pickEntity(ndc: { readonly x: number; readonly y: number }, type: PointerKind): string | null {
    const layer = this.entities as unknown as PointerAwarePick;
    return layer.pick({ x: ndc.x, y: ndc.y }, { pointerType: type });
  }

  private sortHandlers(): void {
    this.handlers.sort((a, b) => b.priority - a.priority);
  }

  private dispatch(method: GestureMethod): void {
    this.sample.claimed = this.claimant !== null;

    if (this.claimant) {
      this.invoke(this.claimant, method);
      return;
    }

    for (const handler of this.handlers) {
      if (handler.isEnabled && !handler.isEnabled()) continue;
      this.invoke(handler, method);
      if (this.sample.claimed) {
        this.claimant = handler;
        this.suspendCamera();
        break;
      }
    }
  }

  private invoke(handler: GestureHandler, method: GestureMethod): void {
    const fn = handler[method];
    if (typeof fn !== 'function') return;
    try {
      fn.call(handler, this.sample as PointerSample);
    } catch (err) {
      console.error(`[floorplan-3d] pointer handler "${handler.id}" threw on ${method}`, err);
    }
  }

  private fill(event: PointerEvent, dx: number, dy: number): void {
    const rect = this.rect;
    const s = this.sample;
    s.pointerId = event.pointerId;
    s.pointerType = normalisePointerType(event.pointerType);
    s.clientX = event.clientX;
    s.clientY = event.clientY;
    if (rect && rect.width > 0 && rect.height > 0) {
      s.ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      s.ndc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
    } else {
      s.ndc.x = 0;
      s.ndc.y = 0;
    }
    s.dx = dx;
    s.dy = dy;
    s.distance = this.primary?.distance ?? 0;
    s.elapsed = this.primary ? event.timeStamp - this.primary.startTime : 0;
    s.buttons = event.buttons;
    s.shiftKey = event.shiftKey;
    s.ctrlKey = event.ctrlKey;
    s.altKey = event.altKey;
    s.metaKey = event.metaKey;
    s.pointerCount = this.activePointers.size;
    s.native = event;
    s.claimed = this.claimant !== null;
  }

  private handleHover(event: PointerEvent): void {
    if (event.buttons !== 0) return;
    this.refreshRectIfStale();
    this.fill(event, 0, 0);
    for (const handler of this.handlers) {
      if (handler.isEnabled && !handler.isEnabled()) continue;
      this.invoke(handler, 'onHover');
      if (this.sample.claimed) break;
    }
  }

  /**
   * Grab the anchor, move the entity; grab the label, move the label.
   *
   * Two things live at one marker — where the lamp is, and where its caption is
   * — and one drag gesture has to serve both. What the pointer went down on is
   * the only honest way to tell them apart.
   */
  private pickUp(entityId: string): void {
    if (this.grabbedPart === 'label') this.placement.beginLabelMove(entityId);
    else this.placement.beginMove(entityId);
  }

  private pickEntityPart(
    ndc: { x: number; y: number },
    type: PointerKind,
  ): { entityId: string; part: 'anchor' | 'label' } | null {
    const layer = this.entities as IEntityLayer & PointerAwarePick;
    if (typeof layer.pickPart === 'function') {
      return layer.pickPart({ x: ndc.x, y: ndc.y }, { pointerType: type });
    }
    const entityId = this.pickEntity(ndc, type);
    return entityId ? { entityId, part: 'anchor' } : null;
  }

  private setHover(entityId: string | null): void {
    if (this.hoveredEntity === entityId) return;
    this.hoveredEntity = entityId;
    this.entities.setHovered(entityId);
    this.emitter.emit('entity-hover', { entityId });
    const canvas = this.canvas;
    if (canvas) canvas.style.cursor = entityId ? 'pointer' : '';
  }

  private resolveTap(event: PointerEvent): void {
    const previous = this.lastTap;
    const now = event.timeStamp;
    const isDouble =
      this.doubleTapEnabled &&
      previous !== null &&
      now - previous.time <= this.options.doubleTapMs &&
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <=
        this.options.doubleTapPx;

    if (isDouble) {
      this.lastTap = null;
      if (this.pendingTapTimer) {
        clearTimeout(this.pendingTapTimer);
        this.pendingTapTimer = null;
      }
      this.dispatch('onDoubleTap');
      return;
    }

    this.lastTap = { x: event.clientX, y: event.clientY, time: now };

    if (!this.doubleTapEnabled) {
      this.dispatch('onTap');
      return;
    }

    // Hold the tap back just long enough for a second one to arrive. The
    // entity id is captured now because `primary` is gone by the time it runs.
    const entityId = this.primary?.entityId ?? null;
    if (this.pendingTapTimer) clearTimeout(this.pendingTapTimer);
    this.pendingTapTimer = setTimeout(() => {
      this.pendingTapTimer = null;
      this.entities.setSelected(entityId);
      if (entityId) this.emitter.emit('entity-activate', { entityId, action: 'tap' });
      this.ctx?.invalidate();
    }, this.options.doubleTapMs);
  }

  private startHoldTimer(): void {
    this.clearHoldTimer();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      const primary = this.primary;
      if (!primary || primary.dragging) return;
      if (primary.distance > this.options.tapMaxPx) return;
      primary.holdFired = true;
      this.dispatch('onHold');
      this.ctx?.invalidate();
    }, this.options.holdMs);
  }

  private clearHoldTimer(): void {
    if (this.holdTimer === null) return;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private capture(event: PointerEvent): void {
    this.consume(event);
    try {
      this.eventTarget?.setPointerCapture(event.pointerId);
    } catch {
      // Capture can legitimately fail if the pointer already went up.
    }
  }

  private releaseCapture(pointerId: number): void {
    try {
      if (this.eventTarget?.hasPointerCapture(pointerId)) {
        this.eventTarget.releasePointerCapture(pointerId);
      }
    } catch {
      /* already released */
    }
  }

  /**
   * Swallow the event so neither OrbitControls nor the page reacts. Touch only
   * gets `preventDefault` once the gesture is claimed, so a user scrolling the
   * dashboard past the card is never blocked.
   */
  private consume(event: PointerEvent): void {
    event.stopPropagation();
    if (event.pointerType === 'touch' && event.cancelable) event.preventDefault();
  }

  private suspendCamera(): void {
    if (this.cameraSuspended) return;
    this.cameraSuspended = true;
    try {
      this.camera.setEnabled(false);
    } catch {
      /* camera controller failed to init; nothing to suspend */
    }
  }

  private resumeCamera(): void {
    if (!this.cameraSuspended) return;
    this.cameraSuspended = false;
    // Placement owns the camera for the whole drop, including the DOM
    // drag-and-drop path; do not fight it.
    if (this.placement.isActive()) return;
    try {
      this.camera.setEnabled(true);
    } catch {
      /* see suspendCamera */
    }
  }

  private endGesture(): void {
    this.primary = null;
    this.claimant = null;
    this.resumeCamera();
  }

  /** Unwind whatever is in flight; `notify` fires `onCancel` on handlers. */
  private abortGesture(notify = true): void {
    this.clearHoldTimer();
    if (notify) {
      for (const handler of this.handlers) {
        try {
          handler.onCancel?.();
        } catch (err) {
          console.error(`[floorplan-3d] pointer handler "${handler.id}" threw on cancel`, err);
        }
      }
    }
    if (this.primary) this.releaseCapture(this.primary.id);
    this.endGesture();
  }

  private refreshRect(): void {
    this.rect = this.canvas?.getBoundingClientRect() ?? null;
  }

  /** Hover path: re-reading layout on every move is a guaranteed reflow. */
  private refreshRectIfStale(): void {
    if (!this.rect) this.refreshRect();
  }
}

function normalisePointerType(type: string): PointerKind {
  return type === 'touch' || type === 'pen' ? type : 'mouse';
}
