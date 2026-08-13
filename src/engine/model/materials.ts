/**
 * The shared material palette. Every mesh in the procedural demo house — and
 * every override the model manager applies to an imported glTF — draws from
 * this small set, so the whole building costs ~10 materials instead of one per
 * mesh. That matters twice over: shader programs are the expensive part of a
 * three.js scene, and the section controller has to walk *every* material to
 * attach its clipping planes. `getAll()` is that walk's input.
 */

import * as THREE from 'three';

export interface MaterialLibraryOptions {
  /**
   * Texture anisotropy. Pass `renderer.capabilities.getMaxAnisotropy()`;
   * defaults to 1 so the library is usable before a renderer exists.
   */
  anisotropy?: number;
  /** Generate the procedural canvas textures. Off => flat colours only. */
  textures?: boolean;
}

export interface MaterialLibrary {
  /** Plaster — interior partitions, exterior render, sanitary ware. */
  readonly wall: THREE.MeshStandardMaterial;
  /** Finished floor, oak planks. */
  readonly floorWood: THREE.MeshStandardMaterial;
  /** Finished floor, ceramic tile — wet rooms, basement, terrace. */
  readonly floorTile: THREE.MeshStandardMaterial;
  readonly ceiling: THREE.MeshStandardMaterial;
  /** The only MeshPhysicalMaterial; window and door glazing. */
  readonly glass: THREE.MeshPhysicalMaterial;
  readonly roof: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshStandardMaterial;
  /** Furniture carcass wood, distinct from the floor. */
  readonly wood: THREE.MeshStandardMaterial;
  /** Upholstery, mattresses, rugs. */
  readonly fabric: THREE.MeshStandardMaterial;
  readonly terrain: THREE.MeshStandardMaterial;
  /**
   * Every material this library owns, for bulk operations such as attaching
   * clipping planes. The returned array is a copy; mutating it is harmless.
   */
  getAll(): THREE.Material[];
  dispose(): void;
}

const WOOD_TEXTURE_SIZE = 512;
const TILE_TEXTURE_SIZE = 512;

export function createMaterialLibrary(options: MaterialLibraryOptions = {}): MaterialLibrary {
  const anisotropy = Math.max(1, Math.floor(options.anisotropy ?? 1));
  const wantTextures = options.textures !== false;

  const textures: THREE.Texture[] = [];

  const register = (texture: THREE.Texture | null): THREE.Texture | null => {
    if (!texture) return null;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = anisotropy;
    texture.needsUpdate = true;
    textures.push(texture);
    return texture;
  };

  const woodMap = wantTextures ? register(createWoodTexture()) : null;
  const tileMap = wantTextures ? register(createTileTexture()) : null;

  const wall = new THREE.MeshStandardMaterial({
    name: 'fp3d:wall',
    color: 0xe9e5de,
    roughness: 0.94,
    metalness: 0,
  });

  const floorWood = new THREE.MeshStandardMaterial({
    name: 'fp3d:floor-wood',
    // The map already carries the colour; tinting it again muddies the grain.
    color: woodMap ? 0xffffff : 0xb98b5e,
    map: woodMap,
    roughness: 0.68,
    metalness: 0,
  });

  const floorTile = new THREE.MeshStandardMaterial({
    name: 'fp3d:floor-tile',
    color: tileMap ? 0xffffff : 0xc9cbc8,
    map: tileMap,
    roughness: 0.38,
    metalness: 0,
  });

  const ceiling = new THREE.MeshStandardMaterial({
    name: 'fp3d:ceiling',
    color: 0xf6f4f0,
    roughness: 1,
    metalness: 0,
  });

  /**
   * `transmission` is deliberately left at 0: any value above zero switches
   * three.js to the transmission render pass, which re-renders the scene into
   * an extra target every frame. On a wall tablet that alone costs more than
   * the rest of the house. Plain alpha blending reads the same at these
   * opacities.
   */
  const glass = new THREE.MeshPhysicalMaterial({
    name: 'fp3d:glass',
    color: 0xcfe1e8,
    transparent: true,
    opacity: 0.18,
    roughness: 0.05,
    metalness: 0,
    transmission: 0,
    ior: 1.45,
    reflectivity: 0.5,
    side: THREE.DoubleSide,
    // Panes are thin and stacked; writing depth makes them fight each other.
    depthWrite: false,
  });
  glass.userData.glass = true;

  const roof = new THREE.MeshStandardMaterial({
    name: 'fp3d:roof',
    color: 0x474c54,
    roughness: 0.82,
    metalness: 0.05,
  });

  const metal = new THREE.MeshStandardMaterial({
    name: 'fp3d:metal',
    color: 0xb6bac0,
    roughness: 0.34,
    metalness: 0.85,
  });

  const wood = new THREE.MeshStandardMaterial({
    name: 'fp3d:wood',
    color: 0x8a5f3c,
    roughness: 0.6,
    metalness: 0,
  });

  const fabric = new THREE.MeshStandardMaterial({
    name: 'fp3d:fabric',
    color: 0x6d7d92,
    roughness: 0.96,
    metalness: 0,
  });

  const terrain = new THREE.MeshStandardMaterial({
    name: 'fp3d:terrain',
    color: 0x6d8b5c,
    roughness: 1,
    metalness: 0,
  });

  const all: THREE.Material[] = [
    wall,
    floorWood,
    floorTile,
    ceiling,
    glass,
    roof,
    metal,
    wood,
    fabric,
    terrain,
  ];

  let disposed = false;

  return {
    wall,
    floorWood,
    floorTile,
    ceiling,
    glass,
    roof,
    metal,
    wood,
    fabric,
    terrain,
    getAll: () => all.slice(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const material of all) material.dispose();
      for (const texture of textures) texture.dispose();
      textures.length = 0;
    },
  };
}

/* --------------------------------------------------- procedural textures */

/**
 * Textures are generated once per library and never re-generated, so the cost
 * is two 512² canvases at load time. Everything is drawn from a seeded LCG so
 * two cards on the same dashboard look identical.
 */
function createContext(size: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas.getContext('2d');
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function createWoodTexture(): THREE.CanvasTexture | null {
  const size = WOOD_TEXTURE_SIZE;
  const ctx = createContext(size);
  if (!ctx) return null;
  const rand = seeded(0x51fd3b);

  const plankHeight = size / 8;
  ctx.fillStyle = '#a97c50';
  ctx.fillRect(0, 0, size, size);

  for (let row = 0; row < 8; row++) {
    const y = row * plankHeight;
    const shade = 0.88 + rand() * 0.24;
    ctx.fillStyle = `rgb(${clamp255(169 * shade)},${clamp255(124 * shade)},${clamp255(80 * shade)})`;
    ctx.fillRect(0, y, size, plankHeight);

    // Grain: long, low-contrast streaks running with the plank.
    for (let i = 0; i < 26; i++) {
      const gy = y + rand() * plankHeight;
      const alpha = 0.03 + rand() * 0.07;
      ctx.strokeStyle = rand() > 0.5 ? `rgba(90,58,30,${alpha})` : `rgba(224,186,140,${alpha})`;
      ctx.lineWidth = 0.6 + rand() * 1.8;
      ctx.beginPath();
      ctx.moveTo(0, gy);
      const steps = 6;
      for (let s = 1; s <= steps; s++) {
        ctx.lineTo((size / steps) * s, gy + (rand() - 0.5) * 3.5);
      }
      ctx.stroke();
    }

    // Butt joint, offset per row so the planks do not line up in a grid.
    const joint = Math.floor(rand() * size);
    ctx.fillStyle = 'rgba(58,36,18,0.45)';
    ctx.fillRect(joint, y, 2, plankHeight);

    // Plank seam.
    ctx.fillStyle = 'rgba(48,30,14,0.55)';
    ctx.fillRect(0, y, size, 2);
  }

  return new THREE.CanvasTexture(ctx.canvas);
}

function createTileTexture(): THREE.CanvasTexture | null {
  const size = TILE_TEXTURE_SIZE;
  const ctx = createContext(size);
  if (!ctx) return null;
  const rand = seeded(0x2c81a7);

  const tiles = 4;
  const step = size / tiles;
  const grout = 5;

  ctx.fillStyle = '#8d908c';
  ctx.fillRect(0, 0, size, size);

  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const shade = 0.94 + rand() * 0.12;
      ctx.fillStyle = `rgb(${clamp255(203 * shade)},${clamp255(206 * shade)},${clamp255(201 * shade)})`;
      ctx.fillRect(tx * step + grout, ty * step + grout, step - grout * 2, step - grout * 2);

      // A faint highlight along the top edge sells the glazed surface.
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(tx * step + grout, ty * step + grout, step - grout * 2, 3);
    }
  }

  return new THREE.CanvasTexture(ctx.canvas);
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
