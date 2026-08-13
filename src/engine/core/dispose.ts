/**
 * Teardown helpers. Rule 5 in ARCHITECTURE.md: a Lovelace dashboard mounts and
 * unmounts cards constantly, and a leaked render target or texture never comes
 * back — on a wall tablet that is a browser restart within a day.
 */

import * as THREE from 'three';

/**
 * Resources that must survive this teardown because something still alive
 * references them (shared materials, an atlas texture owned by another
 * subsystem, ...). Pass them in and they are skipped.
 */
export type ProtectedResources = ReadonlySet<unknown>;

function isTexture(value: unknown): value is THREE.Texture {
  return typeof value === 'object' && value !== null && (value as THREE.Texture).isTexture === true;
}

export function disposeTexture(
  texture: THREE.Texture | null | undefined,
  protectedResources?: ProtectedResources,
): void {
  if (!texture || protectedResources?.has(texture)) return;
  texture.dispose();
}

/**
 * Disposes a material and every texture hanging off it.
 *
 * We sweep the material's own enumerable properties rather than checking a
 * hardcoded list (`map`, `normalMap`, `roughnessMap`, `metalnessMap`,
 * `emissiveMap`, `aoMap`, `lightMap`, `envMap`, `alphaMap`, `bumpMap`,
 * `displacementMap`, `clearcoatMap`, `sheenColorMap`, `iridescenceMap`, ...):
 * three.js adds new map slots every few releases and a stale list leaks
 * silently. ShaderMaterial uniforms are walked separately because textures
 * there live one level down in `{ value }`.
 */
export function disposeMaterial(
  material: THREE.Material,
  protectedResources?: ProtectedResources,
): void {
  if (protectedResources?.has(material)) return;

  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (isTexture(value)) disposeTexture(value, protectedResources);
  }

  const uniforms = record['uniforms'];
  if (uniforms && typeof uniforms === 'object') {
    for (const entry of Object.values(uniforms as Record<string, { value?: unknown } | undefined>)) {
      const value = entry?.value;
      if (isTexture(value)) {
        disposeTexture(value, protectedResources);
      } else if (Array.isArray(value)) {
        for (const item of value) if (isTexture(item)) disposeTexture(item, protectedResources);
      }
    }
  }

  material.dispose();
}

/**
 * Recursively disposes geometries, materials and textures under `root`.
 * The scene graph itself is left intact — the caller decides whether to detach
 * the node, because disposing a subtree that is about to be re-added is valid.
 */
export function disposeObject3D(root: THREE.Object3D, protectedResources?: ProtectedResources): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((object) => {
    const drawable = object as Partial<THREE.Mesh>;
    if (drawable.geometry) geometries.add(drawable.geometry);
    const material = drawable.material;
    if (Array.isArray(material)) {
      for (const m of material) if (m) materials.add(m);
    } else if (material) {
      materials.add(material);
    }

    const skinned = object as Partial<THREE.SkinnedMesh>;
    if (skinned.skeleton) skinned.skeleton.dispose();

    const instanced = object as Partial<THREE.InstancedMesh>;
    if (instanced.isInstancedMesh === true) instanced.dispose?.();

    const light = object as Partial<THREE.Light>;
    if (light.isLight === true) {
      // The shadow render target is the expensive part and `Light.dispose()`
      // does not touch it.
      light.shadow?.map?.dispose();
      light.dispose?.();
    }

    const scene = object as Partial<THREE.Scene>;
    if (scene.isScene === true) {
      if (isTexture(scene.background)) disposeTexture(scene.background, protectedResources);
      if (isTexture(scene.environment)) disposeTexture(scene.environment, protectedResources);
    }
  });

  for (const geometry of geometries) {
    if (!protectedResources?.has(geometry)) geometry.dispose();
  }
  for (const material of materials) {
    disposeMaterial(material, protectedResources);
  }
}
