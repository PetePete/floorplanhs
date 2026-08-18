/**
 * Visual feedback while an entity is being dragged over the model.
 *
 * The point of every element here is *placement confidence* — after the drop
 * the user must not be surprised by where the marker ended up:
 *
 *   - a ring lying flat on the surface under the cursor, oriented to its
 *     normal, so floors and walls read differently at a glance;
 *   - a vertical drop line from the surface up to where the marker will sit,
 *     which is the only cue for the role-aware offsets;
 *   - a ghost of the actual marker at that spot;
 *   - a chip naming the storey it landed on, or why the drop is refused.
 *
 * Lives in `ctx.overlayRoot`, so the cross-section never clips it away.
 */

import * as THREE from 'three';
import type { RenderContext } from '@/engine/contracts';
import { worldUnitsPerPixel } from '@/engine/entities/marker';
import { MarkerAtlas, type AtlasCell } from '@/engine/entities/marker-texture';

export interface DropFeedback {
  /** Surface point under the cursor. */
  point: THREE.Vector3;
  /** Surface normal at that point, world space, unit length. */
  normal: THREE.Vector3;
  /** Where the marker will actually land, after role offset and grid snap. */
  anchor: THREE.Vector3;
  valid: boolean;
  /** Storey name shown next to the cursor. */
  levelName: string | null;
  /** Finished-floor Y of that storey; the drop line runs down to it. */
  levelElevation: number | null;
  /** Shown instead of the level name when the drop is refused. */
  reason?: string;
}

export interface DropGhost {
  icon?: string;
  label?: string;
  color?: string;
}

export interface DropIndicatorOptions {
  accent?: string;
  invalid?: string;
  /** Ring radius in metres. */
  radius?: number;
}

const RENDER_ORDER = 3500;
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const CHIP_GAP_PX = 24;

const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _color = new THREE.Color();

/** Rounds a world position onto a 0.1 m lattice — see `snapToGrid`. */
export const GRID_STEP = 0.1;

/**
 * Snapping keeps hand-placed markers tidy and, more importantly, makes the
 * YAML readable: `[2.4, 2.35, 1.1]` instead of `[2.397, 2.348, 1.103]`.
 *
 * In plan only. The height is left exactly as the drop computed it, because
 * that number is measured *against a surface*: a lamp dropped on a floor whose
 * top is at 2.62 m lands at 2.64, and rounding that to the nearest 10 cm put it
 * at 2.60 — two centimetres inside the slab. Buried, the marker is hard to see
 * and the room lookup reads the storey below it, so the wrong room lights up.
 */
export function snapToGrid(vector: THREE.Vector3, step = GRID_STEP): THREE.Vector3 {
  if (step <= 0) return vector;
  vector.x = Math.round(vector.x / step) * step;
  vector.z = Math.round(vector.z / step) * step;
  return vector;
}

export class DropIndicator {
  private readonly group = new THREE.Group();
  private readonly atlas: MarkerAtlas;

  private readonly ring: THREE.Mesh;
  private readonly ringMaterial: THREE.MeshBasicMaterial;
  private readonly ringGeometry: THREE.RingGeometry;

  private readonly disc: THREE.Mesh;
  private readonly discMaterial: THREE.MeshBasicMaterial;
  private readonly discGeometry: THREE.CircleGeometry;

  private readonly line: THREE.Line;
  private readonly lineMaterial: THREE.LineDashedMaterial;
  private readonly lineGeometry: THREE.BufferGeometry;
  private readonly linePositions: Float32Array;

  private readonly ghost: THREE.Sprite;
  private readonly ghostMaterial: THREE.SpriteMaterial;
  private readonly ghostTexture: THREE.Texture;

  private readonly chip: THREE.Sprite;
  private readonly chipMaterial: THREE.SpriteMaterial;
  private readonly chipTexture: THREE.Texture;

  private readonly accent: string;
  private readonly invalidColor: string;

  private ghostCell: AtlasCell | null = null;
  private chipCell: AtlasCell | null = null;
  private ghostSpec: DropGhost = {};
  private chipText = '';

  private ctx: RenderContext | null = null;
  private unsubscribeAtlas: (() => void) | null = null;
  private shown = false;
  private valid = true;
  private clock = 0;
  private disposed = false;

  constructor(options: DropIndicatorOptions = {}) {
    this.accent = options.accent ?? '#03a9f4';
    this.invalidColor = options.invalid ?? '#e5544b';
    const radius = options.radius ?? 0.22;

    this.group.name = 'drop-indicator';
    this.group.userData.noClip = true;
    this.group.visible = false;

    // Own atlas: small, short-lived and independent of the entity layer's, so
    // a placement drag can never evict marker art mid-frame.
    this.atlas = new MarkerAtlas({ maxSizePx: 512, maxCells: 24 });

    this.ringGeometry = new THREE.RingGeometry(radius * 0.74, radius, 48);
    this.ringMaterial = overlayMaterial(this.accent, 0.95);
    this.ring = new THREE.Mesh(this.ringGeometry, this.ringMaterial);
    this.ring.renderOrder = RENDER_ORDER + 1;

    this.discGeometry = new THREE.CircleGeometry(radius * 0.74, 32);
    this.discMaterial = overlayMaterial(this.accent, 0.16);
    this.disc = new THREE.Mesh(this.discGeometry, this.discMaterial);
    this.disc.renderOrder = RENDER_ORDER;

    this.linePositions = new Float32Array([0, 0, 0, 0, 0, 0]);
    this.lineGeometry = new THREE.BufferGeometry();
    this.lineGeometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    this.lineMaterial = new THREE.LineDashedMaterial({
      color: new THREE.Color(this.accent),
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      dashSize: 0.06,
      gapSize: 0.04,
    });
    this.line = new THREE.Line(this.lineGeometry, this.lineMaterial);
    this.line.renderOrder = RENDER_ORDER + 2;
    this.line.frustumCulled = false;

    this.ghostTexture = this.atlas.acquire();
    this.ghostMaterial = spriteMaterial(this.ghostTexture, 0.8);
    this.ghost = new THREE.Sprite(this.ghostMaterial);
    this.ghost.renderOrder = RENDER_ORDER + 4;

    this.chipTexture = this.atlas.acquire();
    this.chipMaterial = spriteMaterial(this.chipTexture, 1);
    this.chip = new THREE.Sprite(this.chipMaterial);
    this.chip.renderOrder = RENDER_ORDER + 5;

    this.group.add(this.disc, this.ring, this.line, this.ghost, this.chip);
  }

  /* ------------------------------------------------------------ lifecycle */

  /** Which ink the drop chip is drawn in; see `MarkerAtlas.setGroundDark`. */
  setGroundDark(dark: boolean): void {
    this.atlas.setGroundDark(dark);
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.overlayRoot.add(this.group);
    this.atlas.setPixelRatio(ctx.size.pixelRatio);
    this.unsubscribeAtlas = this.atlas.onChange(() => {
      this.refreshCells();
    });
  }

  get visible(): boolean {
    return this.shown;
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.clock = 0;
    this.group.visible = true;
    this.ctx?.invalidate();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.group.visible = false;
    this.ctx?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.unsubscribeAtlas?.();
    this.unsubscribeAtlas = null;

    this.group.removeFromParent();
    this.group.clear();

    this.atlas.release(this.ghostTexture);
    this.atlas.release(this.chipTexture);
    this.atlas.dispose();

    this.ringGeometry.dispose();
    this.ringMaterial.dispose();
    this.discGeometry.dispose();
    this.discMaterial.dispose();
    this.lineGeometry.dispose();
    this.lineMaterial.dispose();
    this.ghostMaterial.dispose();
    this.chipMaterial.dispose();

    this.ctx = null;
  }

  /* --------------------------------------------------------------- content */

  /** What the ghost pill shows. Call once per placement, not per move. */
  setGhost(ghost: DropGhost): void {
    if (
      this.ghostSpec.icon === ghost.icon &&
      this.ghostSpec.label === ghost.label &&
      this.ghostSpec.color === ghost.color
    ) {
      return;
    }
    this.ghostSpec = { ...ghost };
    this.ghostCell = this.atlas.cell({
      variant: 'pill',
      icon: ghost.icon,
      title: ghost.label,
      color: ghost.color ?? this.accent,
      state: 'idle',
    });
    this.atlas.applyTo(this.ghostTexture, this.ghostCell);
  }

  /** Position and validity for the current pointer location. */
  set(feedback: DropFeedback): void {
    if (this.disposed) return;
    this.valid = feedback.valid;

    const tint = feedback.valid ? this.accent : this.invalidColor;
    _color.set(tint);
    this.ringMaterial.color.copy(_color);
    this.discMaterial.color.copy(_color);
    this.lineMaterial.color.copy(_color);

    this.ringMaterial.opacity = feedback.valid ? 0.95 : 0.7;
    this.discMaterial.opacity = feedback.valid ? 0.16 : 0.1;
    // A refused drop shows no ghost at all: nothing is going to be placed.
    this.ghost.visible = feedback.valid;

    // Nudged off the surface so the decal never z-fights with the wall it is
    // lying on, and oriented so it lies flush rather than floating.
    this.ring.position.copy(feedback.point).addScaledVector(feedback.normal, 0.006);
    this.disc.position.copy(this.ring.position);
    this.ring.quaternion.setFromUnitVectors(Z_AXIS, feedback.normal);
    this.disc.quaternion.copy(this.ring.quaternion);

    const baseY =
      feedback.levelElevation !== null
        ? Math.min(feedback.levelElevation, feedback.point.y)
        : Math.min(feedback.point.y, feedback.anchor.y);
    this.linePositions[0] = feedback.anchor.x;
    this.linePositions[1] = baseY;
    this.linePositions[2] = feedback.anchor.z;
    this.linePositions[3] = feedback.anchor.x;
    this.linePositions[4] = feedback.anchor.y;
    this.linePositions[5] = feedback.anchor.z;
    this.lineGeometry.attributes.position.needsUpdate = true;
    this.lineGeometry.computeBoundingSphere();
    this.line.computeLineDistances();
    this.line.visible = Math.abs(feedback.anchor.y - baseY) > 0.02;

    this.ghost.position.copy(feedback.anchor);
    this.chip.position.copy(feedback.anchor);

    const text = feedback.valid ? feedback.levelName ?? '' : feedback.reason ?? 'Cannot drop here';
    if (text !== this.chipText) {
      this.chipText = text;
      this.chipCell = text
        ? this.atlas.cell({ variant: 'chip', title: text, color: tint, muted: !feedback.valid })
        : null;
      if (this.chipCell) this.atlas.applyTo(this.chipTexture, this.chipCell);
    }
    this.chip.visible = this.chipCell !== null;

    this.ctx?.invalidate();
  }

  /* ----------------------------------------------------------------- frame */

  update(dt: number, ctx: RenderContext): void {
    if (!this.shown || this.disposed) return;
    this.clock += dt;

    // A slow breathing ring reads as "live target" rather than "stuck decal".
    const pulse = 1 + 0.05 * Math.sin(this.clock * 6);
    this.ring.scale.setScalar(pulse);

    const height = ctx.size.height;
    const camera = ctx.activeCamera;
    camera.updateMatrixWorld();
    _up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();

    if (this.ghostCell && this.ghost.visible) {
      const unit = worldUnitsPerPixel(camera, this.ghost.position, height);
      this.ghost.scale.set(this.ghostCell.width * unit, this.ghostCell.height * unit, 1);
    }

    if (this.chipCell && this.chip.visible) {
      const unit = worldUnitsPerPixel(camera, this.chip.position, height);
      this.chip.scale.set(this.chipCell.width * unit, this.chipCell.height * unit, 1);
      // Stack the chip under the ghost, in screen space so it stays put while
      // the camera moves.
      _tmp.copy(this.ghost.position).addScaledVector(_up, -CHIP_GAP_PX * unit);
      this.chip.position.copy(_tmp);
    }

    this.ghostMaterial.opacity = this.valid ? 0.82 : 0;
  }

  /* ------------------------------------------------------------- internals */

  private refreshCells(): void {
    if (this.ghostSpec.icon || this.ghostSpec.label) {
      this.ghostCell = this.atlas.cell({
        variant: 'pill',
        icon: this.ghostSpec.icon,
        title: this.ghostSpec.label,
        color: this.ghostSpec.color ?? this.accent,
        state: 'idle',
      });
      this.atlas.applyTo(this.ghostTexture, this.ghostCell);
    }
    if (this.chipText) {
      this.chipCell = this.atlas.cell({
        variant: 'chip',
        title: this.chipText,
        color: this.valid ? this.accent : this.invalidColor,
        muted: !this.valid,
      });
      this.atlas.applyTo(this.chipTexture, this.chipCell);
    }
    this.ctx?.invalidate();
  }
}

/* -------------------------------------------------------------- utilities */

function overlayMaterial(color: string, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    // The indicator must stay visible when the cursor is over a far wall with
    // near geometry in between — it is a cursor, not scene content.
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
}

function spriteMaterial(map: THREE.Texture, opacity: number): THREE.SpriteMaterial {
  return new THREE.SpriteMaterial({
    map,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}
