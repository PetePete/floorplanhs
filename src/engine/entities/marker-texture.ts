/**
 * Marker artwork rasteriser.
 *
 * Markers are billboards, so every visual is ultimately a texture. The naive
 * implementation — one `CanvasTexture` per marker — costs one GPU texture, one
 * upload and one draw-call-breaking material per entity; at 40 entities that is
 * measurably worse than the model itself on a wall tablet.
 *
 * Instead everything lands in a single atlas canvas and each marker gets a
 * *clone* of the atlas texture with its own `offset`/`repeat`. `Texture.copy()`
 * shares `Texture.source`, and three.js keys its GPU texture cache on the
 * source, so all clones resolve to one `WebGLTexture` with one upload. The
 * clones only exist so the UV transform can differ per sprite.
 *
 * Cells are packed with a shelf allocator and evicted LRU when the atlas fills
 * up; an eviction bumps `generation` and fires `onChange`, at which point every
 * holder must re-request its cell.
 */

import * as THREE from 'three';
import { getIconPath } from '@/engine/entities/icons';
import { parseCssColor } from '@/util/color';
import { clamp } from '@/util/math';

/* ------------------------------------------------------------------ types */

export type MarkerVariant = 'pill' | 'dot' | 'anchor' | 'glow' | 'chip';
export type MarkerVisualState = 'idle' | 'hover' | 'selected';

/** Content-addressed description of one piece of marker artwork. */
export interface MarkerSpec {
  variant: MarkerVariant;
  /** Glyph key from `icons.ts`. Ignored by `dot`/`anchor`/`glow`. */
  icon?: string;
  title?: string;
  value?: string;
  /** Accent colour, any CSS form `parseCssColor` understands. */
  color?: string;
  state?: MarkerVisualState;
  /** Entity is unavailable: desaturated fill and a dashed outline. */
  muted?: boolean;
  /** Entity is on/open/playing: accent border and accent glyph. */
  active?: boolean;
}

/** Where a spec ended up in the atlas. Immutable; re-request after a repack. */
export interface AtlasCell {
  /** UV rect, ready for `Texture.offset` / `Texture.repeat`. */
  readonly u0: number;
  readonly v0: number;
  readonly du: number;
  readonly dv: number;
  /** Logical (CSS) pixel size of the cell, including shadow padding. */
  readonly width: number;
  readonly height: number;
  /** Atlas generation this cell belongs to. */
  readonly generation: number;
}

export interface MarkerAtlasOptions {
  /** Device pixel ratio the art is rasterised at. Defaults to the display's. */
  pixelRatio?: number;
  /** Hard cap on the backing canvas edge, in device px. */
  maxSizePx?: number;
  /** Cells kept before the LRU sweep runs. */
  maxCells?: number;
}

/* -------------------------------------------------------------- constants */

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Transparent margin around every cell: room for the drop shadow and the
 *  selection ring, and a guard band against linear-filter bleed. */
const PAD = 7;
/** Device-px gutter between packed cells. */
const GUTTER = 2;

/**
 * Transparent margin baked into every cell. Consumers subtract it when they
 * need the extent of the *visible* art (hit testing, for instance).
 */
export const CELL_PADDING = PAD;

const PILL_H = 30;
const ICON_SIZE = 17;
const PAD_L = 9;
const PAD_R = 11;
const GAP_ICON = 7;
const GAP_TEXT = 6;
const MAX_PILL_W = 230;

const CHIP_H = 22;
const CHIP_PAD = 9;

const DOT_SIZE = 16;
const ANCHOR_SIZE = 12;
const GLOW_SIZE = 80;

const DEFAULT_ACCENT = '#03a9f4';

const BG = 'rgba(21,24,30,0.88)';
const BG_HOVER = 'rgba(34,39,48,0.95)';
const BG_MUTED = 'rgba(21,24,30,0.62)';
const BORDER = 'rgba(255,255,255,0.16)';
const TEXT = '#eef1f6';
const TEXT_MUTED = '#858c98';
const TEXT_VALUE = '#aab2be';
const GLYPH_IDLE = '#c9cfd9';
const GLYPH_MUTED = '#7b828e';

/* -------------------------------------------------------------- internals */

interface Entry {
  spec: MarkerSpec;
  cell: AtlasCell;
  /** Monotonic tick of the last `cell()` call; drives LRU eviction. */
  used: number;
}

interface Size {
  width: number;
  height: number;
}

type Ctx2D = CanvasRenderingContext2D;

/* ------------------------------------------------------------------ class */

export class MarkerAtlas {
  /** The master texture. Never assigned to a sprite directly — clone it. */
  readonly texture: THREE.Texture;

  private readonly canvas: HTMLCanvasElement;
  private readonly c2d: Ctx2D | null;
  private readonly maxCells: number;
  private readonly maxSizePx: number;

  private readonly entries = new Map<string, Entry>();
  private readonly clones = new Set<THREE.Texture>();
  private readonly listeners = new Set<() => void>();

  private dpr: number;
  private sizePx = 0;
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private tick = 0;
  private gen = 0;
  private disposed = false;

  /** Fallback returned when there is no 2D context (SSR / unit tests). */
  private readonly nullCell: AtlasCell = {
    u0: 0,
    v0: 0,
    du: 1,
    dv: 1,
    width: PILL_H,
    height: PILL_H,
    generation: -1,
  };

  constructor(options: MarkerAtlasOptions = {}) {
    this.maxCells = Math.max(16, options.maxCells ?? 96);
    this.maxSizePx = Math.max(256, options.maxSizePx ?? 2048);
    this.dpr = clampDpr(options.pixelRatio ?? globalDevicePixelRatio());

    this.canvas = document.createElement('canvas');
    this.resizeCanvas();
    this.c2d = this.canvas.getContext('2d');

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.name = 'marker-atlas';
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Sprites are drawn at (roughly) 1:1 texel size, so mipmaps buy nothing and
    // would blend neighbouring cells together at the lower levels.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.premultiplyAlpha = false;
  }

  get generation(): number {
    return this.gen;
  }

  get pixelRatio(): number {
    return this.dpr;
  }

  /** True when the atlas has a usable 2D context. */
  get available(): boolean {
    return this.c2d !== null;
  }

  /* --------------------------------------------------------- texture leases */

  /**
   * A texture handle for one sprite. Shares the atlas' GPU upload; the caller
   * owns only the UV transform. Must be handed back to `release()`.
   */
  acquire(): THREE.Texture {
    const clone = this.texture.clone();
    clone.colorSpace = this.texture.colorSpace;
    clone.generateMipmaps = false;
    clone.minFilter = THREE.LinearFilter;
    clone.magFilter = THREE.LinearFilter;
    clone.premultiplyAlpha = false;
    this.clones.add(clone);
    return clone;
  }

  release(texture: THREE.Texture | null | undefined): void {
    if (!texture) return;
    this.clones.delete(texture);
    // Decrements the shared source's refcount in WebGLTextures; the GPU texture
    // itself only goes away once the master is disposed too.
    texture.dispose();
  }

  /** Points a leased texture at a cell. */
  applyTo(texture: THREE.Texture | null | undefined, cell: AtlasCell): void {
    if (!texture) return;
    texture.offset.set(cell.u0, cell.v0);
    texture.repeat.set(cell.du, cell.dv);
  }

  /** Fires after a repack; every cell handed out before it is now stale. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /* ----------------------------------------------------------------- cells */

  /** Rasterises `spec` if needed and returns its UV rect. */
  cell(spec: MarkerSpec): AtlasCell {
    const c2d = this.c2d;
    if (!c2d || this.disposed) return this.nullCell;

    const key = specKey(spec);
    const existing = this.entries.get(key);
    if (existing) {
      existing.used = ++this.tick;
      return existing.cell;
    }

    if (this.entries.size >= this.maxCells) this.repack(c2d);

    const cell = this.rasterise(c2d, spec);
    if (!cell) {
      // Did not fit even on a fresh shelf — sweep and try exactly once more.
      this.repack(c2d);
      const retry = this.rasterise(c2d, spec);
      if (!retry) return this.nullCell;
      this.entries.set(key, { spec: { ...spec }, cell: retry, used: ++this.tick });
      return retry;
    }

    this.entries.set(key, { spec: { ...spec }, cell, used: ++this.tick });
    return cell;
  }

  /** Re-rasterises everything at a new device pixel ratio. */
  setPixelRatio(pixelRatio: number): void {
    const next = clampDpr(pixelRatio);
    if (next === this.dpr || this.disposed) return;
    this.dpr = next;
    this.resizeCanvas();
    const c2d = this.c2d;
    if (!c2d) return;
    this.repack(c2d, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.entries.clear();
    this.listeners.clear();
    for (const clone of this.clones) clone.dispose();
    this.clones.clear();
    this.texture.dispose();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  /* ------------------------------------------------------------- rastering */

  private resizeCanvas(): void {
    const wanted = Math.ceil(768 * this.dpr);
    this.sizePx = Math.min(this.maxSizePx, Math.max(512, nextPowerOfTwo(wanted)));
    this.canvas.width = this.sizePx;
    this.canvas.height = this.sizePx;
    this.resetShelves();
  }

  private resetShelves(): void {
    this.shelfX = GUTTER;
    this.shelfY = GUTTER;
    this.shelfH = 0;
  }

  /**
   * Drops the least recently used quarter of the cache and re-lays-out what is
   * left. `keepNone` clears everything (used on a DPR change, where every cell
   * has to be redrawn anyway).
   */
  private repack(c2d: Ctx2D, keepNone = false): void {
    const survivors = keepNone
      ? []
      : [...this.entries.values()]
          .sort((a, b) => b.used - a.used)
          .slice(0, Math.floor(this.maxCells * 0.75));

    this.entries.clear();
    this.resetShelves();
    this.gen += 1;
    c2d.setTransform(1, 0, 0, 1, 0, 0);
    c2d.clearRect(0, 0, this.sizePx, this.sizePx);

    for (const entry of survivors) {
      const cell = this.rasterise(c2d, entry.spec);
      if (!cell) break;
      this.entries.set(specKey(entry.spec), { spec: entry.spec, cell, used: entry.used });
    }

    this.markDirty();
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        console.error('[floorplan-3d] marker atlas listener threw', err);
      }
    }
  }

  /** Allocates a shelf slot, draws into it and returns the UV rect. */
  private rasterise(c2d: Ctx2D, spec: MarkerSpec): AtlasCell | null {
    const content = this.measure(c2d, spec);
    const width = content.width + PAD * 2;
    const height = content.height + PAD * 2;

    const wPx = Math.ceil(width * this.dpr);
    const hPx = Math.ceil(height * this.dpr);
    if (wPx + GUTTER * 2 > this.sizePx || hPx + GUTTER * 2 > this.sizePx) return null;

    if (this.shelfX + wPx + GUTTER > this.sizePx) {
      this.shelfX = GUTTER;
      this.shelfY += this.shelfH + GUTTER;
      this.shelfH = 0;
    }
    if (this.shelfY + hPx + GUTTER > this.sizePx) return null;

    const xPx = this.shelfX;
    const yPx = this.shelfY;
    this.shelfX += wPx + GUTTER;
    this.shelfH = Math.max(this.shelfH, hPx);

    c2d.save();
    // Draw in logical px; the DPR scale is what keeps text crisp on retina.
    c2d.setTransform(this.dpr, 0, 0, this.dpr, xPx, yPx);
    c2d.clearRect(0, 0, width, height);
    this.draw(c2d, spec, PAD, PAD, content.width, content.height);
    c2d.restore();

    this.markDirty();

    // flipY is on for canvas textures, so v runs bottom-up over the image.
    return {
      u0: xPx / this.sizePx,
      v0: 1 - (yPx + hPx) / this.sizePx,
      du: wPx / this.sizePx,
      dv: hPx / this.sizePx,
      width,
      height,
      generation: this.gen,
    };
  }

  /** Re-uploads the atlas. Cheap enough: only new/evicted art triggers it. */
  private markDirty(): void {
    this.texture.needsUpdate = true;
    // Clones carry their own `version`, and three.js skips the upload path for
    // a texture whose version did not move — even though the source did.
    for (const clone of this.clones) clone.needsUpdate = true;
  }

  /* --------------------------------------------------------- measure + draw */

  private measure(c2d: Ctx2D, spec: MarkerSpec): Size {
    switch (spec.variant) {
      case 'dot':
        return { width: DOT_SIZE, height: DOT_SIZE };
      case 'anchor':
        return { width: ANCHOR_SIZE, height: ANCHOR_SIZE };
      case 'glow':
        return { width: GLOW_SIZE, height: GLOW_SIZE };
      case 'chip': {
        c2d.font = `600 12px ${FONT_STACK}`;
        const w = c2d.measureText(spec.title ?? '').width;
        return { width: Math.ceil(w) + CHIP_PAD * 2, height: CHIP_H };
      }
      case 'pill':
      default:
        return this.measurePill(c2d, spec);
    }
  }

  private measurePill(c2d: Ctx2D, spec: MarkerSpec): Size {
    const hasIcon = !!spec.icon;
    const title = spec.title ?? '';
    const value = spec.value ?? '';
    if (!title && !value) {
      // Icon-only markers are round, not stubby pills.
      return { width: PILL_H, height: PILL_H };
    }

    c2d.font = `600 13px ${FONT_STACK}`;
    const titleW = title ? c2d.measureText(title).width : 0;
    c2d.font = `500 12px ${FONT_STACK}`;
    const valueW = value ? c2d.measureText(value).width : 0;

    let width = PAD_L + PAD_R;
    if (hasIcon) width += ICON_SIZE;
    if (title) width += (hasIcon ? GAP_ICON : 0) + titleW;
    if (value) width += (title ? GAP_TEXT : hasIcon ? GAP_ICON : 0) + valueW;

    return { width: Math.ceil(Math.min(width, MAX_PILL_W)), height: PILL_H };
  }

  private draw(c2d: Ctx2D, spec: MarkerSpec, x: number, y: number, w: number, h: number): void {
    switch (spec.variant) {
      case 'dot':
        drawDot(c2d, spec, x, y, w, h);
        return;
      case 'anchor':
        drawAnchor(c2d, spec, x, y, w, h);
        return;
      case 'glow':
        drawGlow(c2d, x, y, w, h);
        return;
      case 'chip':
        drawChip(c2d, spec, x, y, w, h);
        return;
      case 'pill':
      default:
        drawPill(c2d, spec, x, y, w, h);
    }
  }
}

/* ------------------------------------------------------------- drawing ops */

function drawPill(c2d: Ctx2D, spec: MarkerSpec, x: number, y: number, w: number, h: number): void {
  const accent = spec.color || DEFAULT_ACCENT;
  const muted = spec.muted === true;
  const selected = spec.state === 'selected';
  const hovered = spec.state === 'hover';
  const radius = h / 2;

  c2d.save();
  c2d.shadowColor = 'rgba(0,0,0,0.45)';
  c2d.shadowBlur = 5;
  c2d.shadowOffsetY = 2;
  roundRect(c2d, x, y, w, h, radius);
  c2d.fillStyle = muted ? BG_MUTED : hovered ? BG_HOVER : BG;
  c2d.fill();
  c2d.restore();

  c2d.save();
  roundRect(c2d, x + 0.5, y + 0.5, w - 1, h - 1, radius - 0.5);
  c2d.lineWidth = 1;
  if (muted) {
    // A dashed outline is legible even at a glance and does not rely on colour.
    c2d.setLineDash([4, 3]);
    c2d.strokeStyle = 'rgba(255,255,255,0.3)';
  } else if (spec.active) {
    c2d.strokeStyle = withAlpha(accent, 0.85);
  } else {
    c2d.strokeStyle = BORDER;
  }
  c2d.stroke();
  c2d.restore();

  if (selected) {
    c2d.save();
    roundRect(c2d, x - 3, y - 3, w + 6, h + 6, radius + 3);
    c2d.lineWidth = 2;
    c2d.strokeStyle = accent;
    c2d.stroke();
    c2d.restore();
  }

  const title = spec.title ?? '';
  const value = spec.value ?? '';
  const glyph = muted ? GLYPH_MUTED : spec.active ? accent : GLYPH_IDLE;

  if (!title && !value) {
    if (spec.icon) drawIcon(c2d, spec.icon, x + (w - ICON_SIZE) / 2, y + (h - ICON_SIZE) / 2, ICON_SIZE, glyph);
    return;
  }

  let cursor = x + PAD_L;
  if (spec.icon) {
    drawIcon(c2d, spec.icon, cursor, y + (h - ICON_SIZE) / 2, ICON_SIZE, glyph);
    cursor += ICON_SIZE + GAP_ICON;
  }

  const available = x + w - PAD_R - cursor;
  c2d.textBaseline = 'middle';
  const midY = y + h / 2 + 0.5;

  if (title && value) {
    c2d.font = `600 13px ${FONT_STACK}`;
    // The name is the anchor for recognition; the value gets whatever is left,
    // down to a floor so it never disappears entirely.
    const valueBudget = Math.min(available * 0.45, measureWith(c2d, `500 12px ${FONT_STACK}`, value));
    const titleText = ellipsise(c2d, title, Math.max(available - valueBudget - GAP_TEXT, 24));
    c2d.fillStyle = muted ? TEXT_MUTED : TEXT;
    c2d.fillText(titleText, cursor, midY);
    const used = c2d.measureText(titleText).width;

    c2d.font = `500 12px ${FONT_STACK}`;
    const valueText = ellipsise(c2d, value, Math.max(available - used - GAP_TEXT, 12));
    c2d.fillStyle = muted ? TEXT_MUTED : TEXT_VALUE;
    c2d.fillText(valueText, cursor + used + GAP_TEXT, midY);
    return;
  }

  if (title) {
    c2d.font = `600 13px ${FONT_STACK}`;
    c2d.fillStyle = muted ? TEXT_MUTED : TEXT;
    c2d.fillText(ellipsise(c2d, title, available), cursor, midY);
    return;
  }

  c2d.font = `500 12px ${FONT_STACK}`;
  c2d.fillStyle = muted ? TEXT_MUTED : TEXT_VALUE;
  c2d.fillText(ellipsise(c2d, value, available), cursor, midY);
}

function drawChip(c2d: Ctx2D, spec: MarkerSpec, x: number, y: number, w: number, h: number): void {
  c2d.save();
  c2d.shadowColor = 'rgba(0,0,0,0.5)';
  c2d.shadowBlur = 4;
  c2d.shadowOffsetY = 1;
  roundRect(c2d, x, y, w, h, 5);
  c2d.fillStyle = 'rgba(16,18,23,0.92)';
  c2d.fill();
  c2d.restore();

  c2d.save();
  roundRect(c2d, x + 0.5, y + 0.5, w - 1, h - 1, 4.5);
  c2d.lineWidth = 1;
  c2d.strokeStyle = withAlpha(spec.color || DEFAULT_ACCENT, 0.6);
  c2d.stroke();
  c2d.restore();

  c2d.font = `600 12px ${FONT_STACK}`;
  c2d.textBaseline = 'middle';
  c2d.fillStyle = spec.muted ? TEXT_MUTED : TEXT;
  c2d.fillText(ellipsise(c2d, spec.title ?? '', w - CHIP_PAD * 2), x + CHIP_PAD, y + h / 2 + 0.5);
}

function drawDot(c2d: Ctx2D, spec: MarkerSpec, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const accent = spec.color || DEFAULT_ACCENT;

  c2d.save();
  c2d.shadowColor = 'rgba(0,0,0,0.5)';
  c2d.shadowBlur = 4;
  c2d.shadowOffsetY = 1;
  c2d.beginPath();
  c2d.arc(cx, cy, w / 2 - 1.5, 0, Math.PI * 2);
  c2d.fillStyle = spec.muted ? BG_MUTED : spec.active ? accent : BG;
  c2d.fill();
  c2d.restore();

  c2d.beginPath();
  c2d.arc(cx, cy, w / 2 - 1.5, 0, Math.PI * 2);
  c2d.lineWidth = spec.state === 'selected' ? 2 : 1.4;
  if (spec.muted) c2d.setLineDash([3, 2.5]);
  c2d.strokeStyle = spec.muted ? 'rgba(255,255,255,0.32)' : accent;
  c2d.stroke();
  c2d.setLineDash([]);
}

function drawAnchor(c2d: Ctx2D, spec: MarkerSpec, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const accent = spec.color || DEFAULT_ACCENT;

  c2d.beginPath();
  c2d.arc(cx, cy, w / 2 - 2, 0, Math.PI * 2);
  c2d.lineWidth = 1.4;
  c2d.strokeStyle = withAlpha(accent, 0.85);
  c2d.stroke();

  c2d.beginPath();
  c2d.arc(cx, cy, 1.6, 0, Math.PI * 2);
  c2d.fillStyle = accent;
  c2d.fill();
}

function drawGlow(c2d: Ctx2D, x: number, y: number, w: number, h: number): void {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = Math.min(w, h) / 2;
  const gradient = c2d.createRadialGradient(cx, cy, 0, cx, cy, r);
  // Tinted at draw time via SpriteMaterial.color, so the art stays white.
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.34)');
  gradient.addColorStop(0.7, 'rgba(255,255,255,0.08)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  c2d.fillStyle = gradient;
  c2d.beginPath();
  c2d.arc(cx, cy, r, 0, Math.PI * 2);
  c2d.fill();
}

/** Cached `Path2D` per glyph — reparsing SVG path data per draw is not free. */
const pathCache = new Map<string, Path2D>();

function drawIcon(c2d: Ctx2D, name: string, x: number, y: number, size: number, color: string): void {
  let path = pathCache.get(name);
  if (!path) {
    try {
      path = new Path2D(getIconPath(name));
    } catch {
      return;
    }
    pathCache.set(name, path);
  }
  const scale = size / 24;
  c2d.save();
  c2d.translate(x, y);
  c2d.scale(scale, scale);
  c2d.fillStyle = color;
  // MDI authors holes with reversed winding, which is exactly what nonzero
  // expects; evenodd would fill them in.
  c2d.fill(path, 'nonzero');
  c2d.restore();
}

/* -------------------------------------------------------------- utilities */

function roundRect(c2d: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  // Hand-rolled rather than `c2d.roundRect`, which the Android WebView shipped
  // with older HA companion builds does not have.
  c2d.beginPath();
  c2d.moveTo(x + radius, y);
  c2d.lineTo(x + w - radius, y);
  c2d.arcTo(x + w, y, x + w, y + radius, radius);
  c2d.lineTo(x + w, y + h - radius);
  c2d.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  c2d.lineTo(x + radius, y + h);
  c2d.arcTo(x, y + h, x, y + h - radius, radius);
  c2d.lineTo(x, y + radius);
  c2d.arcTo(x, y, x + radius, y, radius);
  c2d.closePath();
}

function measureWith(c2d: Ctx2D, font: string, text: string): number {
  const previous = c2d.font;
  c2d.font = font;
  const width = c2d.measureText(text).width;
  c2d.font = previous;
  return width;
}

function ellipsise(c2d: Ctx2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (c2d.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (c2d.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? text.slice(0, low) + ellipsis : '';
}

function withAlpha(css: string, alpha: number): string {
  const rgb = parseCssColor(css);
  if (!rgb) return `rgba(255,255,255,${alpha})`;
  return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${alpha})`;
}

function specKey(spec: MarkerSpec): string {
  return [
    spec.variant,
    spec.icon ?? '',
    spec.title ?? '',
    spec.value ?? '',
    spec.color ?? '',
    spec.state ?? 'idle',
    spec.muted ? 'm' : '',
    spec.active ? 'a' : '',
  ].join('');
}

function clampDpr(value: number): number {
  return clamp(Number.isFinite(value) && value > 0 ? value : 1, 1, 3);
}

function globalDevicePixelRatio(): number {
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

function nextPowerOfTwo(value: number): number {
  return Math.pow(2, Math.ceil(Math.log2(Math.max(1, value))));
}
