/**
 * What a procedural house builder hands back.
 *
 * Sweet Home 3D import is the only builder today, but this stays a separate
 * contract rather than living inside it: the model manager, the level detector
 * and the room index all consume this shape and none of them should have to
 * know which importer produced it.
 */

import * as THREE from 'three';
import type { LevelDefinition } from '@/types/config';
import type { MaterialLibrary } from '@/engine/model/materials';

export interface BuiltHouse {
  root: THREE.Group;
  levels: LevelDefinition[];
  bounds: THREE.Box3;
  /**
   * Every mesh by its `<level>/<room>/<part>` name, so `bindNode` and the
   * editor can address one without walking the tree.
   */
  nodes: Map<string, THREE.Object3D>;
  /** Owned by the caller from here on; `dispose()` it with the model. */
  materials: MaterialLibrary;
}

export interface BuiltHouseOptions {
  /** Forwarded to the material library; pass the renderer's max anisotropy. */
  anisotropy?: number;
  /** Disable the procedural canvas textures (flat colours only). */
  textures?: boolean;
}
