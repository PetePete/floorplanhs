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

/** Air between the chips and the frame, in screen pixels. */
const PADDING_PX = 5;
const RADIUS_PX = 4;
const DASH_PX = 5;
const GAP_PX = 4;

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
  private drawn = { width: 0, height: 0, color: '', dpr: 1 };

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
  private paint(size: StackFrameSize, color: string, dpr: number): void {
    const width = Math.ceil(size.width + PADDING_PX * 2);
    const height = Math.ceil(size.height + PADDING_PX * 2);
    if (
      this.drawn.width === width &&
      this.drawn.height === height &&
      this.drawn.color === color &&
      this.drawn.dpr === dpr
    ) {
      return;
    }
    this.drawn = { width, height, color, dpr };

    this.canvas.width = Math.max(8, Math.ceil(width * dpr));
    this.canvas.height = Math.max(8, Math.ceil(height * dpr));
    const c2d = this.canvas.getContext('2d');
    if (!c2d) return;

    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2d.clearRect(0, 0, width, height);
    c2d.strokeStyle = color;
    c2d.lineWidth = 1;
    c2d.setLineDash([DASH_PX, GAP_PX]);

    const inset = 0.5;
    const x = inset;
    const y = inset;
    const w = width - inset * 2;
    const h = height - inset * 2;
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
  update(centre: THREE.Vector3, size: StackFrameSize, unit: number, color: string, dpr: number): void {
    this.paint(size, color, dpr);
    const width = this.drawn.width;
    const height = this.drawn.height;
    this.sprite.position.copy(centre);
    this.sprite.scale.set(width * unit, height * unit, 1);
    this.sprite.visible = width > 0 && height > 0;
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.material.dispose();
    this.texture.dispose();
  }
}
