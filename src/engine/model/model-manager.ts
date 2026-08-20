/**
 * Owns the house: loads it (a Sweet Home 3D .sh3d or a glTF mesh), normalises
 * its placement, works out its storeys and answers every "what is where"
 * question the rest of the engine asks.
 *
 * There is no house of our own to fall back to, so a failure is reported rather
 * than papered over: an actionable message beats a building the user never
 * asked for.
 *
 * Loading deliberately does the download itself instead of handing the URL to
 * GLTFLoader. Two reasons: we get real `loaded`/`total` byte counts for the
 * progress UI, and we get to look at the glTF's `extensionsUsed` *before*
 * constructing any decoder — so a plain uncompressed .glb never instantiates a
 * Draco worker or a meshopt WASM module.
 */

import * as THREE from 'three';
import type { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { Floorplan3dCardConfig, LevelDefinition, Vec3 } from '@/types/config';
import type {
  IModelManager,
  LoadedModel,
  ModelLoadProgress,
  RenderContext,
} from '@/engine/contracts';
import { disposeObject3D } from '@/engine/core/dispose';
import type { BuiltHouse } from '@/engine/model/built-house';
import { looksLikeZip } from '@/engine/model/sh3d/sh3d-archive';
import { buildFromSh3d } from '@/engine/model/sh3d/sh3d-build';
import {
  assignNodesToLevels,
  computeModelBounds,
  detectLevels,
  levelAtY,
} from '@/engine/model/level-detect';
import type { MaterialLibrary } from '@/engine/model/materials';
import { degToRad } from '@/util/math';

type ModelConfig = Floorplan3dCardConfig['model'];

/**
 * The canonical Google-hosted decoder. Users on an isolated network set
 * `model.dracoPath` to a self-hosted copy; nothing else has to change.
 */
const DEFAULT_DRACO_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

/** Don't fire a progress callback for every 8 KB TCP chunk. */
const PROGRESS_BYTES = 65536;
/** Anisotropy above this buys nothing on the floors and costs fill rate. */
const MAX_ANISOTROPY = 8;

export class ModelManager implements IModelManager {
  private ctx: RenderContext | null = null;
  private root: THREE.Group | null = null;
  private loaded: LoadedModel | null = null;
  /** Material library of whichever procedural house we built; we own it. */
  private proceduralMaterials: MaterialLibrary | null = null;
  private levelNodes = new Map<string, THREE.Object3D[]>();
  /** Unexploded local Y of every node the exploded view moves. */
  private readonly restingY = new WeakMap<THREE.Object3D, number>();
  private levelOffsets: ReadonlyMap<string, number> | null = null;
  private ceilingsVisible = true;
  private visibleLevels: string[] | null = null;
  private pickTargets: THREE.Object3D[] = [];
  private pickDirty = true;
  private disposed = false;

  get model(): LoadedModel | null {
    return this.loaded;
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    // load() may legitimately have run before the render core existed.
    if (this.root && this.root.parent !== ctx.modelRoot) ctx.modelRoot.add(this.root);
  }

  async load(
    config: ModelConfig,
    onProgress?: (p: ModelLoadProgress) => void,
  ): Promise<LoadedModel> {
    const report = (progress: ModelLoadProgress): void => {
      if (!onProgress) return;
      try {
        onProgress(progress);
      } catch (err) {
        console.error('[floorplan-3d] load progress handler threw', err);
      }
    };

    this.disposeModel();

    let content: THREE.Object3D | null = null;
    /** A .sh3d home, which is authored around its own y = 0. */
    let procedural: BuiltHouse | null = null;

    const url = config?.url;

    if (url) {
      try {
        report({ phase: 'download', loaded: 0, total: 0, message: 'Downloading model' });
        const buffer = await fetchWithProgress(url, (loaded, total) => {
          report({ phase: 'download', loaded, total });
        });

        // Sweet Home 3D saves are ZIP archives. Trust the bytes over the name:
        // a `.sh3d` served with the wrong extension is far more likely than a
        // glTF that happens to start with `PK`.
        if (looksLikeZip(buffer) || /\.sh3d(?:[?#]|$)/i.test(url)) {
          report({ phase: 'parse', message: 'Reading Sweet Home 3D home' });
          const home = buildFromSh3d(buffer, { anisotropy: this.maxAnisotropy() });
          if (home.report.unmatchedOpenings > 0) {
            console.warn(
              `[floorplan-3d] ${home.report.unmatchedOpenings} door(s)/window(s) in ${url} sit in no wall and were skipped`,
            );
          }
          procedural = home;
          content = home.root;
          this.proceduralMaterials = home.materials;
        } else {
          report({ phase: 'parse', message: 'Parsing model' });
          content = await parseGltf(buffer, url, config?.dracoPath);
        }
      } catch (err) {
        // Rule 7: never let a bad model take the card down with it. The card
        // still runs — toolbar, presets, the lot — it just has nothing to draw,
        // and the message says why.
        procedural = null;
        content = null;
        this.proceduralMaterials?.dispose();
        this.proceduralMaterials = null;
        report({ phase: 'error', message: describe(err) });
      }
    }

    if (!content) {
      content = new THREE.Group();
      content.name = 'no-model';
      report({
        phase: 'error',
        message: url
          ? `Nothing could be loaded from ${url}.`
          : 'No model configured — set `model.url` to a Sweet Home 3D .sh3d file or a glTF/glb.',
      });
    }

    report({ phase: 'prepare', message: 'Preparing scene' });

    const scale = config?.scale && config.scale > 0 ? config.scale : 1;
    const offset: Vec3 = config?.offset ?? [0, 0, 0];

    const root = new THREE.Group();
    root.name = 'floorplan-model';
    content.scale.multiplyScalar(scale);
    if (config?.rotation) {
      content.rotation.set(
        degToRad(config.rotation[0] ?? 0),
        degToRad(config.rotation[1] ?? 0),
        degToRad(config.rotation[2] ?? 0),
      );
    }
    root.add(content);
    root.updateMatrixWorld(true);

    // Recentre imported models only: XZ centre on the origin, lowest point on
    // y = 0, which is what makes orbiting an arbitrary export feel right.
    // Procedurally built houses — Sweet Home 3D homes — are
    // authored around their own origin with a basement below zero, and
    // ARCHITECTURE.md pins level 0's floor to y = 0. Moving them would break
    // every coordinate the user has already placed against them.
    if (!procedural) {
      const raw = computeModelBounds(content);
      if (!raw.isEmpty()) {
        const centre = raw.getCenter(new THREE.Vector3());
        root.position.set(-centre.x, -raw.min.y, -centre.z);
      }
    }
    // Offset is applied after recentring so it stays a deliberate nudge rather
    // than something the recentre silently cancels out.
    root.position.x += offset[0] ?? 0;
    root.position.y += offset[1] ?? 0;
    root.position.z += offset[2] ?? 0;
    root.updateMatrixWorld(true);

    const bounds = computeModelBounds(root);

    let levels: LevelDefinition[];
    if (config?.levels && config.levels.length > 0) {
      levels = detectLevels(root, config.levels);
    } else if (procedural) {
      levels = procedural.levels.map((level) => ({
        ...level,
        elevation: level.elevation * scale + (offset[1] ?? 0),
        height: level.height * scale,
      }));
    } else {
      levels = detectLevels(root);
    }

    const nodes = new Map<string, THREE.Object3D>();
    if (procedural) {
      for (const [name, object] of procedural.nodes) nodes.set(name, object);
    }
    root.traverse((object) => {
      if (object.name && !nodes.has(object.name)) nodes.set(object.name, object);
    });

    this.levelNodes = assignNodesToLevels(root, levels);
    const receivers = this.applyShadowsAndGlass(root, config?.glassNodes);

    this.root = root;
    this.loaded = { root, bounds, levels, nodes, receivers, rooms: collectRooms(root) };
    this.visibleLevels = null;
    this.pickDirty = true;
    if (!this.ceilingsVisible) {
      root.traverse((object) => {
        if (object.userData.part === 'ceiling') object.visible = false;
      });
    }

    if (this.ctx) this.ctx.modelRoot.add(root);

    report({ phase: 'done', message: 'Model ready' });
    this.ctx?.invalidate();
    return this.loaded;
  }

  /**
   * Lift each storey for the exploded view. Node positions are remembered on
   * first use rather than accumulated, so repeated calls — a slider being
   * dragged — cannot drift.
   */
  setLevelOffsets(offsets: ReadonlyMap<string, number> | null): void {
    this.levelOffsets = offsets;
    for (const [id, objects] of this.levelNodes) {
      const offset = offsets?.get(id) ?? 0;
      for (const object of objects) {
        let resting = this.restingY.get(object);
        if (resting === undefined) {
          resting = object.position.y;
          this.restingY.set(object, resting);
        }
        object.position.y = resting + offset;
      }
    }
    this.ctx?.invalidate();
  }

  /** How far a storey is currently lifted; 0 when not exploded. */
  levelOffset(levelId: string | null | undefined): number {
    return typeof levelId === 'string' ? (this.levelOffsets?.get(levelId) ?? 0) : 0;
  }

  /**
   * Show or hide every ceiling slab. Pick targets go with them: a hidden ceiling
   * must not catch a drop, or entities land on a surface nobody can see.
   */
  setCeilingsVisible(visible: boolean): void {
    if (this.ceilingsVisible === visible) return;
    this.ceilingsVisible = visible;
    this.root?.traverse((object) => {
      if (object.userData.part === 'ceiling') object.visible = visible;
    });
    this.pickDirty = true;
    this.ctx?.invalidate();
  }

  setVisibleLevels(levelIds: string[] | null): void {
    let wanted = levelIds && levelIds.length > 0 ? new Set(levelIds) : null;

    // A view that names storeys this model does not have hides the building
    // instead of isolating part of it — an empty card and nothing to explain it.
    // A stale saved view is the usual way there, or a config written against a
    // different house. Keep whatever matches; if nothing does, show everything.
    if (wanted) {
      const known = new Set(this.levelNodes.keys());
      const matched = [...wanted].filter((id) => known.has(id));
      if (matched.length === 0) {
        if (known.size > 0) {
          console.warn(
            `[floorplan-3d] no storey matches ${[...wanted].join(', ')}; showing all of them.`,
          );
        }
        wanted = null;
      } else if (matched.length !== wanted.size) {
        wanted = new Set(matched);
      }
    }

    this.visibleLevels = wanted ? [...wanted] : null;

    // Precomputed at load time — this must stay a handful of writes, because
    // scrubbing the level selector calls it on every pointer move.
    for (const [id, objects] of this.levelNodes) {
      const visible = !wanted || wanted.has(id);
      for (const object of objects) object.visible = visible;
    }
    this.pickDirty = true;
    this.ctx?.invalidate();
  }

  getVisibleLevels(): string[] | null {
    return this.visibleLevels ? [...this.visibleLevels] : null;
  }

  getPickTargets(): THREE.Object3D[] {
    if (!this.pickDirty) return this.pickTargets;
    const targets: THREE.Object3D[] = [];
    if (this.root) collectPickTargets(this.root, targets);
    this.pickTargets = targets;
    this.pickDirty = false;
    return targets;
  }

  levelAt(position: Vec3 | THREE.Vector3): LevelDefinition | null {
    const levels = this.loaded?.levels;
    if (!levels || levels.length === 0) return null;
    const y = Array.isArray(position) ? position[1] : position.y;
    return typeof y === 'number' && Number.isFinite(y) ? levelAtY(levels, y) : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeModel();
    this.ctx = null;
  }

  /* ------------------------------------------------------------ internals */

  private disposeModel(): void {
    if (this.root) {
      this.root.removeFromParent();
      disposeObject3D(this.root);
      this.root = null;
    }
    // The procedural library owns canvas textures shared by several materials;
    // dispose() there is idempotent and cheap, so call it regardless.
    this.proceduralMaterials?.dispose();
    this.proceduralMaterials = null;
    this.loaded = null;
    this.levelNodes = new Map();
    this.visibleLevels = null;
    this.pickTargets = [];
    this.pickDirty = true;
  }

  private maxAnisotropy(): number {
    const capabilities = this.ctx?.renderer.capabilities;
    if (!capabilities) return 1;
    return Math.min(MAX_ANISOTROPY, capabilities.getMaxAnisotropy());
  }

  /**
   * Shadow flags and glass tagging in one traversal.
   *
   * Floors, ceilings and terrain receive but do not cast — a floor casting onto
   * itself only produces acne. Walls, roofs, stairs and furniture do both.
   * Glass does neither: a translucent pane casting an opaque shadow is the
   * single most obvious "this is a 3D toy" tell.
   */
  private applyShadowsAndGlass(
    root: THREE.Object3D,
    glassNodes: string[] | undefined,
  ): THREE.Mesh[] {
    const receivers: THREE.Mesh[] = [];
    const glassPatterns = (glassNodes ?? []).map(compileGlassMatcher);

    root.traverse((object) => {
      const mesh = asMesh(object);
      if (!mesh || !mesh.geometry) return;

      const isGlass =
        mesh.userData.glass === true ||
        glassPatterns.some((test) => test(mesh.name)) ||
        materialsLookLikeGlass(mesh.material);

      if (isGlass) {
        mesh.userData.glass = true;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        return;
      }

      if (mesh.userData.shadowsConfigured !== true) {
        const flat = isFlatHorizontal(mesh);
        mesh.castShadow = !flat;
        mesh.receiveShadow = true;
      }
      if (mesh.receiveShadow) receivers.push(mesh);
    });

    return receivers;
  }
}

/* ------------------------------------------------------------- traversal */

function asMesh(object: THREE.Object3D): THREE.Mesh | null {
  return (object as Partial<THREE.Mesh>).isMesh === true ? (object as THREE.Mesh) : null;
}

/**
 * Drop targets for placement and picking: visible, solid, real geometry.
 * Recursion stops at invisible nodes, which is both faster than filtering
 * afterwards and the only way to respect a hidden *ancestor*.
 */
/**
 * Every room the model names, by storey, in the order the file lists them.
 *
 * Read off the floor meshes, which are the same thing the room fill and the
 * leader anchors are built from — one source for "which rooms are there".
 */
function collectRooms(root: THREE.Object3D): Array<{ id: string; level: string | null }> {
  const seen = new Set<string>();
  const rooms: Array<{ id: string; level: string | null }> = [];
  root.traverse((object) => {
    if (object.userData.part !== 'floor') return;
    const id = object.userData.room;
    if (typeof id !== 'string' || !id || id === 'structure') return;
    const level = typeof object.userData.level === 'string' ? object.userData.level : null;
    const key = `${level ?? ''}|${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    rooms.push({ id, level });
  });
  return rooms;
}

function collectPickTargets(object: THREE.Object3D, out: THREE.Object3D[]): void {
  if (!object.visible) return;
  const mesh = asMesh(object);
  if (mesh && mesh.geometry) {
    const data = mesh.userData;
    const isHelper = data.helper === true || data.noPick === true || mesh.name.startsWith('__');
    if (!isHelper && data.glass !== true) out.push(mesh);
  }
  for (const child of object.children) collectPickTargets(child, out);
}

/** A slab, a ceiling or a ground plane: wide in XZ, thin in Y. */
function isFlatHorizontal(mesh: THREE.Mesh): boolean {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) return false;
  const dx = (box.max.x - box.min.x) * Math.abs(mesh.scale.x);
  const dy = (box.max.y - box.min.y) * Math.abs(mesh.scale.y);
  const dz = (box.max.z - box.min.z) * Math.abs(mesh.scale.z);
  return dy < 0.35 && dx > 1.2 && dz > 1.2;
}

function materialsLookLikeGlass(material: THREE.Material | THREE.Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.some((m) => {
    if (!m) return false;
    if (m.userData?.glass === true) return true;
    if (/glass|glazing|window|fenster|verre|vitre/i.test(m.name)) return true;
    const physical = m as Partial<THREE.MeshPhysicalMaterial>;
    if ((physical.transmission ?? 0) > 0.2) return true;
    return m.transparent === true && (m.opacity ?? 1) < 0.6;
  });
}

function compileGlassMatcher(pattern: string): (name: string) => boolean {
  const source = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const re = new RegExp(`^${source}$`, 'i');
  return (name) => re.test(name);
}

/* ---------------------------------------------------------------- loading */

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`Could not load ${url} — HTTP ${response.status} ${response.statusText}`);
  }

  const header = response.headers.get('content-length');
  const total = header ? Number(header) : 0;
  const body = response.body;

  // No streaming body (older WebViews, or a same-origin proxy that strips it):
  // still correct, just without intermediate progress.
  if (!body || !Number.isFinite(total) || total <= 0) {
    const buffer = await response.arrayBuffer();
    onProgress(buffer.byteLength, buffer.byteLength);
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let reported = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    if (loaded - reported >= PROGRESS_BYTES) {
      reported = loaded;
      onProgress(loaded, total);
    }
  }
  onProgress(loaded, total || loaded);

  const merged = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

interface GltfNeeds {
  draco: boolean;
  meshopt: boolean;
  ktx2: boolean;
}

/**
 * Reads `extensionsUsed` out of the glTF without fully parsing it: for .glb the
 * JSON chunk is at a fixed offset, for .gltf the head of the file is enough
 * (the extension lists are emitted near the top by every exporter). A regex
 * beats `JSON.parse` on a multi-megabyte JSON chunk we are about to hand to
 * GLTFLoader anyway.
 */
function detectGltfNeeds(buffer: ArrayBuffer): GltfNeeds {
  let text = '';
  const view = new DataView(buffer);
  const GLB_MAGIC = 0x46546c67; // 'glTF'
  const JSON_CHUNK = 0x4e4f534a; // 'JSON'

  if (buffer.byteLength >= 20 && view.getUint32(0, true) === GLB_MAGIC) {
    const chunkLength = view.getUint32(12, true);
    const chunkType = view.getUint32(16, true);
    if (chunkType === JSON_CHUNK && chunkLength > 0) {
      const end = Math.min(buffer.byteLength, 20 + chunkLength);
      text = new TextDecoder().decode(new Uint8Array(buffer, 20, end - 20));
    }
  } else {
    const head = Math.min(buffer.byteLength, 512 * 1024);
    text = new TextDecoder().decode(new Uint8Array(buffer, 0, head));
  }

  return {
    draco: text.includes('KHR_draco_mesh_compression'),
    meshopt: text.includes('EXT_meshopt_compression'),
    ktx2: text.includes('KHR_texture_basisu'),
  };
}

async function parseGltf(
  buffer: ArrayBuffer,
  url: string,
  dracoPath: string | undefined,
): Promise<THREE.Group> {
  const needs = detectGltfNeeds(buffer);

  // KTX2 would drag a Basis transcoder (and a second CDN path to configure)
  // into a bundle that has to stay one file. Fail with an actionable message
  // instead of half-loading a model with black textures.
  if (needs.ktx2) {
    throw new Error(
      'This model uses KTX2/Basis compressed textures (KHR_texture_basisu), which this card cannot decode. Re-export the glb with regular PNG/JPEG textures.',
    );
  }

  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  let draco: DRACOLoader | null = null;

  if (needs.draco) {
    const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
    draco = new DRACOLoader();
    draco.setDecoderPath(dracoPath || DEFAULT_DRACO_PATH);
    loader.setDRACOLoader(draco);
  }
  if (needs.meshopt) {
    const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
    loader.setMeshoptDecoder(MeshoptDecoder);
  }

  // Resource path for a .gltf with external .bin / textures.
  const base = url.slice(0, url.lastIndexOf('/') + 1);

  try {
    const gltf = await loader.parseAsync(buffer, base);
    return gltf.scene;
  } finally {
    // Frees the decoder worker pool; the geometry is already decoded.
    draco?.dispose();
  }
}
