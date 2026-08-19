/**
 * The persisted card configuration. This *is* the YAML a user ends up with in
 * their Lovelace dashboard, so every field must be plain JSON, stable and
 * hand-editable. Anything derived at runtime belongs in the engine, not here.
 */

export const CARD_TYPE = 'floorplan-3d-card';
export const CARD_TAG = 'floorplan-3d-card';
export const EDITOR_TAG = 'floorplan-3d-card-editor';
export const CARD_VERSION = '0.2.4';

export type Vec3 = [number, number, number];

/* ------------------------------------------------------------------ model */

export interface LevelDefinition {
  /** Stable id used by presets and placed entities. */
  id: string;
  name: string;
  /** World-space Y of the finished floor. */
  elevation: number;
  /** Storey height, used for the "isolate level" clipping box. */
  height: number;
  /** glTF node names that belong to this level. Empty => derive from bounds. */
  nodes?: string[];
  icon?: string;
}

export interface ModelConfig {
  /**
   * A Sweet Home 3D save (`/local/haus.sh3d`) or a glTF/glb mesh
   * (`/local/house.glb`). The bytes decide which, so a `.sh3d` served under the
   * wrong extension still loads.
   *
   * Required: the card ships no house of its own. Without this it renders an
   * empty scene and says so.
   */
  url?: string;
  scale?: number;
  /** Degrees, applied XYZ. */
  rotation?: Vec3;
  offset?: Vec3;
  /** Explicit storeys. When omitted the engine derives them from geometry. */
  levels?: LevelDefinition[];
  /** Materials matching these node-name patterns become see-through glass. */
  glassNodes?: string[];
  /** Draco decoder path, only needed for draco-compressed glb. */
  dracoPath?: string;
}

/* ---------------------------------------------------------------- section */

export type SectionMode = 'none' | 'level' | 'plane';
export type Axis = 'x' | 'y' | 'z';

export interface ClipPlaneState {
  axis: Axis;
  /** World-space position of the plane along its axis. */
  position: number;
  enabled: boolean;
  /** Flip which half is kept. */
  invert: boolean;
}

export interface SectionState {
  mode: SectionMode;
  planes: ClipPlaneState[];
  /** For mode `level`: which storey is isolated. */
  levelId?: string | null;
  /** Render solid caps on cut surfaces instead of hollow shells. */
  caps?: boolean;
  capColor?: string;
  /**
   * Metres taken off the top of an isolated storey, so the cut lands below the
   * ceiling slab and you look *into* the rooms instead of onto their ceiling.
   * `0` keeps the storey whole. Only used by `mode: 'level'`.
   */
  ceilingCut?: number;
}

/* ----------------------------------------------------------------- camera */

export interface CameraPreset {
  id: string;
  name: string;
  icon?: string;
  position: Vec3;
  target: Vec3;
  fov?: number;
  /** How much of the model fits the frame; 1 is the whole of it. */
  orthoZoom?: number;
  /** Section state restored together with the viewpoint. */
  section?: SectionState;
  /** Level ids visible in this preset; `null`/absent means all. */
  visibleLevels?: string[] | null;
  /** Auto-selected on load. */
  default?: boolean;
  /** Included in the auto-rotate slideshow. */
  inTour?: boolean;
}

/**
 * `cad` follows Fusion/SolidWorks: the middle button navigates and the left
 * button is free for selecting and dragging entities. `orbit` is the plain
 * three.js mapping where left-drag rotates — fine for a view-only dashboard,
 * infuriating when you are trying to place things.
 */
export type NavigationMode = 'cad' | 'orbit';

export interface CameraConfig {
  navigation?: NavigationMode;
  fov?: number;
  near?: number;
  far?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Clamp so the user cannot orbit under the ground plane. */
  maxPolarAngle?: number;
  damping?: number;
  /** Seconds a preset transition takes. */
  transitionDuration?: number;
  autoRotate?: boolean;
  autoRotateSpeed?: number;
  /** Return to the default preset after N seconds of no interaction. 0 = off. */
  idleReturnAfter?: number;
}

/* ------------------------------------------------------------------- tour */

/**
 * Cycling through the saved views. Aimed at a wall tablet that nobody is
 * touching; every part of it is off or overridable so it never surprises
 * someone using the card interactively.
 */
export interface TourConfig {
  /** Start cycling on load. */
  autoplay?: boolean;
  /** Seconds a view is held before flying to the next one. */
  interval?: number;
  /**
   * Which views take part. `tagged` uses the presets marked `inTour`, falling
   * back to all of them when none is marked; `all` ignores the flag.
   */
  include?: 'tagged' | 'all';
  /** Show the play/pause button and the per-view tour toggle. */
  showControls?: boolean;
  /** Stop when the user touches the camera. */
  pauseOnInteraction?: boolean;
  /** Seconds of inactivity before it starts again. 0 = stay paused. */
  resumeAfter?: number;
}

export const DEFAULT_TOUR_CONFIG: Required<TourConfig> = {
  autoplay: false,
  interval: 12,
  include: 'tagged',
  showControls: true,
  pauseOnInteraction: true,
  resumeAfter: 60,
};

/* --------------------------------------------------------------- entities */

export type MarkerShape = 'auto' | 'pill' | 'dot' | 'icon' | 'label' | 'none';

export interface MarkerConfig {
  shape?: MarkerShape;
  /**
   * Force the leader line back to `room` on or off. Left unset it appears
   * whenever the marker is placed clear of the room it names, which is the
   * only time it says anything.
   */
  leader?: boolean;
  /** Show the state value next to the name. */
  showState?: boolean;
  showName?: boolean;
  icon?: string;
  /** Marker scales with distance when false (default true = constant size). */
  fixedSize?: boolean;
  scale?: number;
  /** Hide when the camera is further away than this (world units). */
  maxDistance?: number;
  color?: string;
  /** Lift the marker above the anchor point. */
  offset?: Vec3;
}

export type LightKind = 'point' | 'spot' | 'rect' | 'emissive';

export interface LightVisualConfig {
  kind?: LightKind;
  /** Multiplier on the intensity derived from the entity brightness. */
  intensity?: number;
  /** Falloff radius in world units. 0 = infinite. */
  distance?: number;
  decay?: number;
  /** Spot only, degrees. */
  angle?: number;
  penumbra?: number;
  /** Spot only: where the cone points, relative to the light position. */
  targetOffset?: Vec3;
  /** Static override; ignored when the entity reports a colour. */
  color?: string;
  useEntityColor?: boolean;
  /** Visible luminaire geometry at the light position. */
  fixture?: { show?: boolean; radius?: number; emissive?: number };
  /** Rect area light dimensions. */
  size?: [number, number];
}

export interface ActionConfig {
  action:
    | 'more-info'
    | 'toggle'
    | 'call-service'
    | 'perform-action'
    | 'navigate'
    | 'url'
    | 'preset'
    | 'none';
  entity?: string;
  service?: string;
  perform_action?: string;
  data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  navigation_path?: string;
  url_path?: string;
  /** For `preset`: id of the camera preset to fly to. */
  preset_id?: string;
  confirmation?: { text?: string };
}

export interface PlacedEntity {
  entity: string;
  position: Vec3;
  rotation?: Vec3;
  /** Storey this entity belongs to; hidden when the level is hidden. */
  level?: string | null;
  name?: string;
  /** Overrides the auto-derived visual role (light/sensor/cover/...). */
  role?: EntityRole;
  light?: LightVisualConfig;
  /**
   * The room this entity belongs to.
   *
   * Two jobs, because they are the same statement. For a light in
   * `lightMode: room` it says which room to fill, overriding the one its
   * position falls in — useful when a lamp sits in a doorway or a wall recess.
   * For anything placed *outside* that room it also draws a leader line back
   * to it, so a row of temperature readings can sit clear of the plan and
   * still say which room each one is measuring.
   */
  room?: string;
  marker?: MarkerConfig;
  tap_action?: ActionConfig;
  hold_action?: ActionConfig;
  double_tap_action?: ActionConfig;
  /** Name of a glTF node that should be tinted/animated by this entity. */
  bindNode?: string;
}

export type EntityRole =
  | 'light'
  | 'switch'
  | 'sensor'
  | 'binary_sensor'
  | 'cover'
  | 'climate'
  | 'media_player'
  | 'camera'
  | 'person'
  | 'marker';

/* ----------------------------------------------------------------- render */

/**
 * `wireframe` is a hidden-line drawing and the default: the surfaces still
 * occlude what is behind them, but only the edges are painted. `solid` is the
 * opposite — shaded surfaces with no edge lines at all.
 *
 * A lit room reads in both: the room fill is washed onto the floor area, not
 * only shaded onto the walls a hidden-line drawing does not paint.
 */
export type RenderStyle = 'solid' | 'wireframe';

/**
 * `model` keeps the materials the model ships with. The two `mono` values
 * flatten every surface to one neutral tone — a blueprint look, where the only
 * colour left in the scene is the light your lamps cast.
 */
export type RenderPalette = 'model' | 'mono-light' | 'mono-dark';

/**
 * `room` (the default) lights the whole room a lamp stands in, evenly and up to
 * its walls — the floorplan reading, where "the kitchen is on" is the fact you
 * want at a glance. `realistic` puts a physically based light at the lamp
 * instead: correct inverse-square falloff, a bright hotspot underneath, and
 * dark corners.
 */
export type LightMode = 'room' | 'realistic';

/**
 * How the renderer maps its internal colours to the screen.
 *
 * `aces` is the filmic curve and the default. It costs some contrast and
 * saturation, which is a real price for a drawing whose palette was chosen
 * rather than photographed — but it is the look the card was tuned against,
 * and `lightMode: realistic` needs it, because candela values run well above
 * 1.0 and something has to bring them back.
 *
 * `linear` applies `exposure` and nothing else, so a surface comes out the
 * colour you gave it. `none` ignores `exposure` as well.
 */
export type ToneMapping = 'linear' | 'aces' | 'none';

export interface RenderConfig {
  style?: RenderStyle;
  palette?: RenderPalette;
  lightMode?: LightMode;
  toneMapping?: ToneMapping;
  /** How strongly a lit room is tinted, 0..2. Only used by `lightMode: room`. */
  roomFillStrength?: number;
  /** Colour of the edge lines; defaults to a theme-derived ink. */
  edgeColor?: string;
  /** Tier for pixel ratio and antialiasing; 'auto' picks by device. */
  quality?: 'low' | 'medium' | 'high' | 'auto';
  exposure?: number;
  /** Base ambient level so an all-lights-off house is not pitch black. */
  ambientIntensity?: number;
    /**
   * `transparent` (default) lets the dashboard card show through. `light` and
   * `dark` pin a neutral backdrop regardless of the theme — needed with the
   * mono palettes, which are otherwise invisible against a same-polarity
   * dashboard. `system` follows the theme but stays opaque. Anything else is
   * taken as a CSS colour.
   */
  background?: 'transparent' | 'light' | 'dark' | 'system' | (string & {});
  /** Cap the device pixel ratio; keeps tablets fluid. */
  maxPixelRatio?: number;
  /** Stop rendering when nothing changed. Big battery win on wall tablets. */
  onDemand?: boolean;
  fpsLimit?: number;
}

/* --------------------------------------------------------------------- ui */

export interface UiConfig {
  /**
   * Draw the ceilings. Off is often the more useful floorplan: a ceiling is the
   * one surface you are never looking at, and in an exploded or a plan view it
   * is all you can see of the storey underneath it.
   */
  showCeilings?: boolean;
  /**
   * Pull the storeys apart along Y by this many metres per step, so you can see
   * into all of them at once — an assembly drawing rather than a house. 0 is
   * off. Everything moves together: geometry, room tints, markers and their
   * leader lines, and the cross-section.
   *
   * A view setting only. Positions in this config are always the real ones.
   */
  explode?: number;
  /**
   * Seconds the storeys take to travel when the exploded view is switched on or
   * off. 0 puts them straight there. The motion is the point: a building that
   * comes apart in front of you reads as one building taken apart, where an
   * instant jump reads as a different drawing.
   */
  explodeDuration?: number;
  showToolbar?: boolean;
  showLevelSelector?: boolean;
  showSectionControls?: boolean;
  showLegend?: boolean;
  showFps?: boolean;
  /** Vertical zoom control under the orientation cube. */
  showZoomSlider?: boolean;
  /**
   * Drop an entity where it was dropped (default), or move it to the height the
   * fixture would really sit at — a light to the ceiling, a switch to 1.10 m.
   * The smart version saves work once you know it is coming and is baffling
   * before that, so it is opt-in.
   */
  snapPlacement?: boolean;
  /**
   * Draw entity markers on top of everything instead of letting walls and
   * ceilings hide them. Ignored in `style: wireframe`, where nothing is drawn
   * for them to hide behind. Useful when you never cut the building open; with a
   * storey isolated it makes markers from other floors float over the plan.
   */
  markersThroughWalls?: boolean;
  /**
   * Offer one plan view per detected storey in the view bar, generated from
   * the model rather than saved by hand. They cannot be renamed or deleted —
   * they follow the model. Saved views always come first.
   */
  levelPresets?: boolean;
  /** Fusion-style orientation cube in the top-right corner. */
  showViewCube?: boolean;
  /**
   * Master switch for every authoring affordance — level selector, section
   * controls, entity palette and inspector, save-view and the edit toggle.
   * 'auto' shows them only in edit mode; 'never' hides them always; 'always'
   * keeps them on a normal dashboard. The individual `show*` flags still apply
   * on top of this.
   */
  authorTools?: 'auto' | 'never' | 'always';
  /** Compact layout for small cards. */
  compact?: boolean;
  theme?: 'auto' | 'light' | 'dark';
  /** Card height, any CSS length; ignored in panel mode. */
  height?: string;
  aspectRatio?: string;
}

/* ----------------------------------------------------------------- config */

export interface Floorplan3dCardConfig {
  type: string;
  title?: string;
  model?: ModelConfig;
  camera?: CameraConfig;
  presets?: CameraPreset[];
  tour?: TourConfig;
  entities?: PlacedEntity[];
  section?: SectionState;
  render?: RenderConfig;
  ui?: UiConfig;
  /** Bumped by migrations. */
  config_version?: number;
}

export const DEFAULT_SECTION_STATE: SectionState = {
  mode: 'none',
  planes: [
    { axis: 'x', position: 0, enabled: false, invert: false },
    { axis: 'y', position: 0, enabled: false, invert: false },
    { axis: 'z', position: 0, enabled: false, invert: false },
  ],
  levelId: null,
  caps: true,
  capColor: '#8a8f98',
  // Roughly a floor slab plus a little: enough to clear the ceiling of a
  // normal storey without eating into the walls that give the room its shape.
  ceilingCut: 0.45,
};

export const DEFAULT_CAMERA_CONFIG: Required<
  Pick<
    CameraConfig,
    | 'navigation'
    | 'fov'
    | 'near'
    | 'far'
    | 'minDistance'
    | 'maxDistance'
    | 'maxPolarAngle'
    | 'damping'
    | 'transitionDuration'
    | 'autoRotate'
    | 'autoRotateSpeed'
    | 'idleReturnAfter'
  >
> = {
  navigation: 'cad',
  fov: 45,
  near: 0.1,
  far: 500,
  minDistance: 1.5,
  maxDistance: 80,
  maxPolarAngle: Math.PI / 2 - 0.02,
  damping: 0.08,
  transitionDuration: 1.1,
  autoRotate: false,
  autoRotateSpeed: 0.4,
  idleReturnAfter: 0,
};

export const DEFAULT_RENDER_CONFIG: Required<RenderConfig> = {
  // A floorplan is a drawing. Hidden-line is what a drawing looks like, and the
  // room fill still reads because it is washed onto the floor rather than
  // washed onto the room floor.
  style: 'wireframe',
  palette: 'model',
  // A dashboard card answers "which rooms are lit", not "where exactly does the
  // photon land". Physically correct falloff makes a lamp a bright dot in a
  // dark room, which is the wrong reading at floorplan scale.
  lightMode: 'room',
  roomFillStrength: 1,
  toneMapping: 'aces',
  edgeColor: '',
  quality: 'auto',
  exposure: 1.0,
  ambientIntensity: 0.34,
  background: '',
  maxPixelRatio: 2,
  onDemand: true,
  fpsLimit: 60,
};

export const DEFAULT_UI_CONFIG: Required<UiConfig> = {
  showCeilings: true,
  explode: 0,
  explodeDuration: 0.7,
  snapPlacement: false,
  showToolbar: true,
  // Off by default. Isolating a storey and dragging cut planes is how you
  // *author* a view; day to day you just want to jump between the views you
  // saved. Both reappear automatically in edit mode, so nothing is lost.
  showLevelSelector: true,
  showSectionControls: false,
  showLegend: false,
  showFps: false,
  showZoomSlider: true,
  markersThroughWalls: false,
  levelPresets: true,
  showViewCube: true,
  authorTools: 'auto',
  compact: false,
  theme: 'auto',
  height: '520px',
  aspectRatio: '',
};
