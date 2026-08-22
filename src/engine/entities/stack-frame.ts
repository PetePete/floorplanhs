/**
 * The dashed rectangle drawn around a stack.
 *
 * Without it a stack is a guess: several chips near each other look much like
 * several chips near each other, and the one thing you need to know after
 * dragging two together is whether it took. The frame is the answer, and it is
 * dashed because a solid one would read as a selection.
 *
 * Sized in screen pixels and drawn as a billboard, like the chips it encloses,
 * so it stays a rectangle at any zoom and under any perspective.
 */

import * as THREE from 'three';

import { roundRect, withAlpha } from '@/engine/entities/marker-texture';

/** Air between the chips and the frame, in screen pixels. */
const PADDING_PX = 5;
const RADIUS_PX = 4;
const DASH_PX = 5;
const GAP_PX = 4;

/**
 * The bar along the top, in screen pixels.
 *
 * A pile needs somewhere to take hold of that is not one of its rows — a row
 * means "this one marker", and the anchor dot is a dot. This is the part you
 * grab to move the whole thing, so it is drawn as something you would grab.
 *
 * Which is exactly why it is not drawn outside edit mode: a handle on a card
 * nobody can rearrange is a control that does nothing, and on a floorplan on a
 * wall it is one more thing in front of the drawing.
 */
export const HEADER_PX = 16;

export interface StackFrameSize {
  /** Widest chip in the stack, in CSS pixels. */
  width: number;
  /** Bottom of the lowest chip to the top of the highest, in CSS pixels. */
  height: number;
}

export class StackFrame {
  readonly sprite: THREE.Sprite;

  private readonly canvas: HTMLCanvasElement;
  private readonly texture: THREE.CanvasTexture;
  private readonly material: THREE.SpriteMaterial;
  private drawn = { width: 0, height: 0, color: '', dpr: 1, highlight: false, bar: false };

  constructor(color: string) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 8;
    this.canvas.height = 8;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.SpriteMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      opacity: 0.85,
    });
    this.sprite = new THREE.Sprite(this.material);
    this.sprite.name = 'stack-frame';
    this.sprite.userData.fp3dInternal = true;
    this.sprite.userData.noPick = true;
    this.sprite.raycast = () => {};
    this.drawn.color = color;
  }

  /**
   * Redraw only when the box or the colour actually changed: this runs from the
   * frame loop, and a canvas upload per frame per stack is not free.
   */
  private paint(
    size: StackFrameSize,
    color: string,
    dpr: number,
    highlight: boolean,
    bar: boolean,
  ): void {
    const barHeight = bar ? HEADER_PX : 0;
    const width = Math.ceil(size.width + PADDING_PX * 2);
    const height = Math.ceil(size.height + PADDING_PX * 2) + barHeight;
    if (
      this.drawn.width === width &&
      this.drawn.height === height &&
      this.drawn.color === color &&
      this.drawn.dpr === dpr &&
      this.drawn.highlight === highlight &&
      this.drawn.bar === bar
    ) {
      return;
    }
    this.drawn = { width, height, color, dpr, highlight, bar };

    this.canvas.width = Math.max(8, Math.ceil(width * dpr));
    this.canvas.height = Math.max(8, Math.ceil(height * dpr));
    const c2d = this.canvas.getContext('2d');
    if (!c2d) return;

    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2d.clearRect(0, 0, width, height);

    // The grab bar, along the top and solid: the dashes say "these belong
    // together", and a solid bar says "take hold here".
    if (bar) {
      const barWidth = Math.max(28, Math.min(width, 64));
      const barX = (width - barWidth) / 2;
      c2d.save();
      c2d.fillStyle = withAlpha(color, 0.85);
      roundRect(c2d, barX, 0.5, barWidth, HEADER_PX - 2, 3);
      c2d.fill();
      // Three lines, the grip every window in the world uses.
      c2d.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      c2d.lineWidth = 1;
      for (let i = 0; i < 3; i += 1) {
        const gy = 3.5 + i * 3.5;
        c2d.beginPath();
        c2d.moveTo(width / 2 - 7, gy);
        c2d.lineTo(width / 2 + 7, gy);
        c2d.stroke();
      }
      c2d.restore();
    }

    // Lit up, the dashes close into a solid line and the inside is washed with
    // the same ink: "release here and it goes in this pile". A dashed outline
    // says the pile exists; a filled one says it is the target.
    if (highlight) {
      c2d.fillStyle = withAlpha(color, 0.16);
      roundRect(c2d, 1, barHeight + 1, width - 2, height - barHeight - 2, RADIUS_PX);
      c2d.fill();
    }

    c2d.strokeStyle = color;
    c2d.lineWidth = highlight ? 2 : 1;
    if (!highlight) c2d.setLineDash([DASH_PX, GAP_PX]);

    const inset = 0.5;
    const x = inset;
    const y = barHeight + inset;
    const w = width - inset * 2;
    const h = height - barHeight - inset * 2;
    const r = Math.min(RADIUS_PX, w / 2, h / 2);

    c2d.beginPath();
    c2d.moveTo(x + r, y);
    c2d.lineTo(x + w - r, y);
    c2d.quadraticCurveTo(x + w, y, x + w, y + r);
    c2d.lineTo(x + w, y + h - r);
    c2d.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c2d.lineTo(x + r, y + h);
    c2d.quadraticCurveTo(x, y + h, x, y + h - r);
    c2d.lineTo(x, y + r);
    c2d.quadraticCurveTo(x, y, x + r, y);
    c2d.closePath();
    c2d.stroke();

    this.texture.needsUpdate = true;
  }

  /**
   * Put the frame around a box of `size` whose centre is at `centre`, with
   * `unit` world units to the screen pixel.
   */
  update(
    centre: THREE.Vector3,
    size: StackFrameSize,
    unit: number,
    color: string,
    dpr: number,
    screenUp: THREE.Vector3,
    highlight = false,
    bar = true,
  ): void {
    this.paint(size, color, dpr, highlight, bar);
    const width = this.drawn.width;
    const height = this.drawn.height;
    // The header sits above the rows, so the whole thing rides that much higher
    // — up the screen, the way the rows themselves are spaced. Without a bar
    // there is nothing to ride above, and the box sits on its own contents.
    const lift = bar ? HEADER_PX / 2 : 0;
    this.sprite.position.copy(centre).addScaledVector(screenUp, lift * unit);
    this.sprite.scale.set(width * unit, height * unit, 1);
    this.sprite.visible = width > 0 && height > 0;
    this.material.opacity = highlight ? 1 : 0.85;
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.material.dispose();
    this.texture.dispose();
  }
}
