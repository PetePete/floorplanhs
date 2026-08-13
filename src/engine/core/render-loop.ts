/**
 * On-demand render loop (ARCHITECTURE.md rule 4).
 *
 * Idle by default: nothing draws until something calls `invalidate()`, or a
 * continuous lease is held. A Lovelace dashboard keeps every card mounted
 * forever, so a card that is scrolled out of view or sitting in a background
 * tab must cost exactly zero — that is what the IntersectionObserver and the
 * `visibilitychange` handler are for.
 */

import type { RenderContext } from '@/engine/contracts';

export type FrameCallback = (dt: number, ctx: RenderContext) => void;

export interface RenderLoopOptions {
  /** 0 or negative means "as fast as the display". */
  fpsLimit?: number;
  /** When false the loop renders every frame regardless of invalidation. */
  onDemand?: boolean;
}

/**
 * A backgrounded tab can be gone for minutes; without this clamp the first
 * frame back would advance every tween straight to its end.
 */
const MAX_DELTA = 0.1;

/**
 * Frame-time slack for the fps limiter. A 60 Hz display delivers ~16.6 ms and
 * a 60 fps target wants 16.67 ms — without the tolerance every second frame
 * would be dropped and the card would run at 30 fps.
 */
const FRAME_TIME_SLACK = 0.002;

export class RenderLoop {
  private readonly ctx: RenderContext;
  private frameCallback: FrameCallback | null = null;

  private running = false;
  private disposed = false;
  private rafId: number | null = null;
  private frameRequested = false;
  private holdCount = 0;

  private onDemand: boolean;
  private minFrameTime = 0;
  private lastTime = 0;
  private smoothedFps = 0;

  private offscreen = false;
  private documentHidden = false;
  private intersectionObserver: IntersectionObserver | null = null;

  constructor(ctx: RenderContext, options: RenderLoopOptions = {}) {
    this.ctx = ctx;
    this.onDemand = options.onDemand !== false;
    this.setFpsLimit(options.fpsLimit ?? 0);

    if (typeof document !== 'undefined') {
      this.documentHidden = document.hidden === true;
      document.addEventListener('visibilitychange', this.handleVisibilityChange, false);
    }
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(this.handleIntersection, {
        threshold: 0,
      });
      this.intersectionObserver.observe(ctx.canvas);
    }
  }

  /* --------------------------------------------------------------- state */

  get isRunning(): boolean {
    return this.running;
  }

  /** True while the loop is deliberately doing nothing (hidden / offscreen). */
  get isPaused(): boolean {
    return this.offscreen || this.documentHidden;
  }

  /** Smoothed frames per second, for the optional FPS overlay. */
  get fps(): number {
    return this.smoothedFps;
  }

  get continuousHolds(): number {
    return this.holdCount;
  }

  setFrameCallback(cb: FrameCallback | null): void {
    this.frameCallback = cb;
  }

  setFpsLimit(fps: number): void {
    // >=200 is effectively "uncapped" and avoids fighting a 240 Hz display.
    this.minFrameTime = fps > 0 && fps < 200 ? Math.max(0, 1 / fps - FRAME_TIME_SLACK) : 0;
  }

  setOnDemand(enabled: boolean): void {
    if (this.onDemand === enabled) return;
    this.onDemand = enabled;
    if (!enabled) this.invalidate();
  }

  /* ------------------------------------------------------------ driving */

  start(): void {
    if (this.disposed || this.running) return;
    this.running = true;
    this.lastTime = now();
    this.frameRequested = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.cancel();
  }

  /** Request exactly one frame. Repeated calls in a tick coalesce. */
  invalidate(): void {
    if (this.disposed) return;
    this.frameRequested = true;
    this.schedule();
  }

  /**
   * Reference-counted lease on continuous rendering (camera damping, preset
   * flights, animated markers). The returned release is idempotent, so a
   * subsystem may safely call it from both a completion path and `dispose()`.
   */
  holdContinuous(): () => void {
    this.holdCount += 1;
    this.schedule();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holdCount = Math.max(0, this.holdCount - 1);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.holdCount = 0;
    this.frameCallback = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange, false);
    }
  }

  /* -------------------------------------------------------------- internals */

  private get wantsContinuous(): boolean {
    return this.holdCount > 0 || !this.onDemand;
  }

  private schedule(): void {
    if (this.disposed || !this.running || this.isPaused) return;
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(this.tick);
  }

  private cancel(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private readonly tick = (timestamp: number): void => {
    this.rafId = null;
    if (this.disposed || !this.running || this.isPaused) return;

    if (!this.wantsContinuous && !this.frameRequested) {
      // Nothing to draw: go fully idle and let invalidate() wake us.
      this.lastTime = timestamp;
      return;
    }

    const elapsed = (timestamp - this.lastTime) / 1000;
    if (this.minFrameTime > 0 && elapsed < this.minFrameTime) {
      // Skip this vsync without consuming the request. rAF paces us, so this
      // costs nothing — never spin waiting for the target frame time.
      this.schedule();
      return;
    }

    // A zero-size canvas (hidden tab, collapsed card) cannot produce a useful
    // frame; keep the request pending so RenderCore's resize wakes us.
    if (this.ctx.size.width <= 0 || this.ctx.size.height <= 0) {
      this.lastTime = timestamp;
      if (this.wantsContinuous) this.schedule();
      return;
    }

    this.lastTime = timestamp;
    this.frameRequested = false;

    const dt = Math.min(Math.max(elapsed, 0), MAX_DELTA);
    if (dt > 0) {
      const instant = 1 / dt;
      // Exponential smoothing; the raw value jitters far too much to display.
      this.smoothedFps = this.smoothedFps === 0 ? instant : this.smoothedFps + (instant - this.smoothedFps) * 0.1;
    }

    try {
      this.frameCallback?.(dt, this.ctx);
    } catch (err) {
      console.error('[floorplan-3d] frame callback threw', err);
    }

    if (this.wantsContinuous || this.frameRequested) this.schedule();
  };

  private readonly handleIntersection = (entries: IntersectionObserverEntry[]): void => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    this.setOffscreen(!entry.isIntersecting);
  };

  private readonly handleVisibilityChange = (): void => {
    const hidden = document.hidden === true;
    if (hidden === this.documentHidden) return;
    this.documentHidden = hidden;
    this.afterPauseChange();
  };

  private setOffscreen(offscreen: boolean): void {
    if (this.offscreen === offscreen) return;
    this.offscreen = offscreen;
    this.afterPauseChange();
  }

  private afterPauseChange(): void {
    if (this.isPaused) {
      this.cancel();
      return;
    }
    // Coming back: reset the time base so the clamped delta does not swallow
    // a real frame, and draw once so the card is never stale on reveal.
    this.lastTime = now();
    this.smoothedFps = 0;
    this.invalidate();
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
