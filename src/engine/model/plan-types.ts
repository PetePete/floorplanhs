/**
 * The hand-writable floor plan format.
 *
 * A `PlanSpec` is what you get when you sit down with a set of 1:100 drawings
 * and a ruler: a footprint, a stack of storeys, a list of rooms as rectangles,
 * a few windows and doors along named walls, and a roof. It is plain JSON —
 * every field survives a YAML or `.json` round trip — and it is deliberately
 * poorer than a BIM model. Anything the format cannot express is a thing the
 * card would not have rendered legibly anyway.
 *
 * ## Coordinates
 *
 * Plan coordinates are metres in the XZ plane, exactly the world units the rest
 * of the engine uses:
 *
 * - **+X is east**, **+Z is south**, so **north is −Z** (`ARCHITECTURE.md`).
 * - Put the origin on the **north-west outer corner** of the footprint and every
 *   coordinate you read off the drawing stays positive. `buildFromPlan`
 *   recentres the finished building on the origin, so the choice is cosmetic.
 * - **Y is up and is not part of the plan**: heights come from
 *   `PlanLevel.elevation` (finished floor level, ground floor = 0) and from the
 *   roof's absolute `eaveHeight` / `ridgeHeight`.
 *
 * ## What the builder derives for you
 *
 * - Exterior walls from `outline`, on a centreline inset half a wall thickness.
 * - Interior partitions from the gaps between `rooms`, built once per wall no
 *   matter how many rooms touch it.
 * - A structural floor slab per storey, a ceiling per room, stair wells punched
 *   through both.
 *
 * So the normal way to draw a partition is *not* to list it: leave a
 * `interiorWall`-wide gap between two room rectangles and the wall appears.
 * `PlanLevel.walls` is only for partitions no pair of rooms implies.
 */

/** A point in the plan: `[x, z]` metres, +X east, +Z south. */
export type PlanPoint = [x: number, z: number];

/**
 * An axis-aligned rectangle `[x1, z1, x2, z2]` in plan metres. The corners may
 * be given in either order; the builder normalises them.
 */
export type PlanRect = [x1: number, z1: number, x2: number, z2: number];

/** Compass side. `n` is −Z, `s` is +Z, `e` is +X, `w` is −X. */
export type PlanSide = 'n' | 'e' | 's' | 'w';

/** Finished floor material. `concrete` also covers screed and basement floors. */
export type PlanFloorFinish = 'wood' | 'tile' | 'concrete';

/* ------------------------------------------------------------------- walls */

/**
 * Which wall an opening sits in.
 *
 * - A compass side — the exterior wall on that side of the footprint. This is
 *   what you want for almost every window.
 * - `{ from, to }` — an explicit line in plan coordinates. Any wall whose
 *   centreline is collinear with it is a candidate; use it for a partition you
 *   listed in `walls`, or to disambiguate when two rooms share two walls.
 * - `{ between: [roomA, roomB] }` — the partition separating two rooms,
 *   whichever wall that turns out to be. This is how you place interior doors
 *   without knowing any coordinates. When the two rooms touch along more than
 *   one wall the longest shared run wins.
 */
export type PlanWallRef =
  | PlanSide
  | { from: PlanPoint; to: PlanPoint }
  | { between: [string, string] };

/** Window, door, sliding door — the three things a floor plan actually draws. */
export type PlanOpeningKind = 'window' | 'door' | 'sliding';

/** An opening without its wall; used inline on `PlanWall.openings`. */
export interface PlanOpeningShape {
  kind: PlanOpeningKind;
  /**
   * Position of the opening's **centre** along the wall, in metres.
   *
   * - Compass wall: the plan coordinate on the drawing — `x` for a north or
   *   south wall, `z` for an east or west wall, measured from the footprint's
   *   north-west corner.
   * - `{ from, to }` wall: distance from `from`.
   * - `{ between }` wall: distance from the start of the shared run. Omit it and
   *   the opening is centred on that run, which is normally what you want.
   */
  at?: number;
  /** Clear width in metres. */
  width: number;
  /**
   * Height of the opening's bottom **above the finished floor of its storey**.
   * Defaults: `window` 0.9, `door` and `sliding` 0.
   */
  sill?: number;
  /**
   * Clear height in metres. Defaults: `window` 1.3, `door` 2.05, `sliding` the
   * storey's `clearHeight` less 0.3.
   */
  height?: number;
  /** Glaze a door. Windows and sliding doors are always glazed. */
  glazed?: boolean;
}

export interface PlanOpening extends PlanOpeningShape {
  wall: PlanWallRef;
}

/**
 * A partition the room rectangles do not imply — a free-standing wall, a wall
 * around a shaft, a wall that stops halfway across a room.
 */
export interface PlanWall {
  from: PlanPoint;
  to: PlanPoint;
  /** Defaults to `PlanSpec.interiorWall`. */
  thickness?: number;
  /** Height above the finished floor. Defaults to the storey's `clearHeight`. */
  height?: number;
  /** Openings measured from `from`. */
  openings?: PlanOpeningShape[];
}

/* ------------------------------------------------------------------- rooms */

export interface PlanRoom {
  /** snake_case; becomes the middle segment of every node name. */
  id: string;
  /** Display name. Defaults to the id. */
  name?: string;
  /**
   * The room's **clear interior**, inside its walls. One rectangle, or several
   * for an L-shaped room — rectangles of the same room never get a wall between
   * them, so an L is just two overlapping-or-touching rects.
   */
  rect: PlanRect | PlanRect[];
  /** Finished floor. Defaults to `wood`, or `tile` when `wet` is set. */
  floor?: PlanFloorFinish;
  /** Bathrooms, kitchens, basements: tiled floor unless `floor` says otherwise. */
  wet?: boolean;
  /**
   * Rooms this one is open to — no partition is built along the shared edge.
   * Symmetric: listing it on either room is enough. This is how an open-plan
   * kitchen/dining/living space is drawn as three named rooms.
   */
  openTo?: string[];
  /** Suppress this room's ceiling, e.g. a double-height space. */
  ceiling?: boolean;
}

/* ------------------------------------------------------------------ stairs */

export interface PlanStairs {
  id: string;
  /** Centre of the bottom riser, in plan coordinates. */
  from: PlanPoint;
  /** Centre of the top riser. The flight runs in a straight line between them. */
  to: PlanPoint;
  /** Clear width of the flight. */
  width: number;
  /** Number of risers. `rise = (toY - fromY) / steps`. */
  steps: number;
  /** Y at `from`. Defaults to this storey's finished floor level. */
  fromY?: number;
  /** Y at `to`. Defaults to the next storey up. */
  toY?: number;
  /** Room the flight is drawn in, for node naming. Defaults to `structure`. */
  room?: string;
  /**
   * The hole punched through the slab above — this storey's ceiling and the
   * next storey's floor. Defaults to the flight's own footprint, which is right
   * whenever the flight lands flush with the upper floor.
   */
  well?: PlanRect;
}

/* ------------------------------------------------------------------ levels */

export interface PlanLevel {
  /** Stable id — `ug`, `eg`, `og`. Becomes the first node-name segment. */
  id: string;
  name: string;
  /** mdi icon for the level selector. */
  icon?: string;
  /** Finished floor level in metres. Ground floor is 0 by convention. */
  elevation: number;
  /** Floor-to-floor height: this storey's FFL to the next one's. */
  height: number;
  /**
   * Finished floor to underside of ceiling. Defaults to `height - slab`. Only
   * used to place ceilings and to size openings.
   */
  clearHeight?: number;
  /**
   * Closed polygon of the **exterior face** of the shell, in plan metres. Do
   * not repeat the first point. Usually four corners; any simple polygon works,
   * though roofs are always built over its bounding box.
   */
  outline: PlanPoint[];
  rooms: PlanRoom[];
  /** Partitions the rooms do not imply. */
  walls?: PlanWall[];
  openings?: PlanOpening[];
  stairs?: PlanStairs[];
  /** Set false to leave the storey open to the roof above. Default true. */
  ceiling?: boolean;
}

/* -------------------------------------------------------------------- roof */

export interface PlanRoof {
  /** `mono` = Pultdach, `gable` = Satteldach, `flat` = Flachdach. */
  kind: 'mono' | 'gable' | 'flat';
  /**
   * Pitch in degrees. Ignored when `ridgeHeight` is given — the two heights
   * already define the slope, and the drawings usually quote both.
   */
  slopeDeg?: number;
  /** `mono` only: which side the roof is high on. Default `n`. */
  highSide?: PlanSide;
  /** `gable` only: which way the ridge runs. Defaults to the longer side. */
  ridgeAxis?: 'x' | 'z';
  /** Absolute Y of the top of the low roof edge — the eave or the flat roof. */
  eaveHeight: number;
  /** Absolute Y of the top of the high edge or the ridge. */
  ridgeHeight?: number;
  /** Roof projection past the facade, all round. Default 0.3. */
  overhang?: number;
  /** Upstand around the roof edge (`Dachkranz`/Attika). Default 0. */
  parapet?: number;
  /** Structural depth of the roof slab. Default 0.24. */
  thickness?: number;
}

/* -------------------------------------------------------------------- site */

/**
 * Anything outside the heated volume. Site geometry is stamped
 * `userData.alwaysVisible`, so isolating a storey never hides it and it is
 * excluded from the bounds the camera and the section planes work from.
 */
export interface PlanSite {
  id: string;
  /**
   * - `terrace` — a paved deck; `level` is the top of the paving.
   * - `carport` — a paved floor plus corner posts up to `height`. Give it a
   *   `terrace` at the same height if the roof is a usable deck.
   * - `step` — a flight of entrance steps descending from `level` along the
   *   rectangle's longer axis.
   * - `volume` — a plain closed box: a store, a bin shed, a plant enclosure.
   */
  kind: 'terrace' | 'carport' | 'step' | 'volume';
  rect: PlanRect;
  /** Absolute Y: top surface for `terrace`/`step`, floor for the other two. */
  level: number;
  /** `carport` and `volume`: height above `level`. Default 2.5. */
  height?: number;
  /** `step` only: number of risers. Default 3. */
  steps?: number;
  /**
   * `step` only: which way the flight falls. Defaults to `e` or `s` — i.e. the
   * top step is at the rectangle's low-coordinate end. Set it to `w` or `n` to
   * put the top step against a building that lies east or south of the flight.
   */
  descend?: PlanSide;
  material?: PlanFloorFinish | 'metal';
}

/* -------------------------------------------------------------------- spec */

export interface PlanSpec {
  /** Shown nowhere; it names the root node and documents the file. */
  name?: string;
  /** Metres only. Present so a plan can never be silently read as feet. */
  units?: 'm';
  /** Exterior wall thickness. Default 0.33. */
  exteriorWall?: number;
  /** Interior partition thickness, and the default gap between rooms. Default 0.15. */
  interiorWall?: number;
  /** Structural floor thickness, below the finished floor level. Default 0.3. */
  slab?: number;
  /** Ceiling finish thickness. Default 0.02. */
  ceilingThickness?: number;
  /**
   * Move the finished building so the footprint is centred on the origin in XZ.
   * Default true — it is what lets you write the plan from a corner.
   */
  recentre?: boolean;
  levels: PlanLevel[];
  roof?: PlanRoof;
  site?: PlanSite[];
}
