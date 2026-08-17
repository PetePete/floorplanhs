/**
 * The persisted card configuration. This *is* the YAML a user ends up with in
 * their Lovelace dashboard, so every field must be plain JSON, stable and
 * hand-editable. Anything derived at runtime belongs in the engine, not here.
 */

export const CARD_TYPE = 'floorplan-3d-card';
export const CARD_TAG = 'floorplan-3d-card';
export const EDITOR_TAG = 'floorplan-3d-card-editor';
export const CARD_VERSION = '0.1.0';

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

export type SectionMode = 'none' | 'level' | 'plane' | 'box';
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
  /** For mode `box`: world-space AABB that is kept. */
  box?: { min: Vec3; max: Vec3 };
  /** Render solid caps on cut surfaces instead of hollow shells. */
  caps?: boolean;
  capColor?: string;
  /** Levels above the active one fade out instead of disappearing. */
  ghostAbove?: boolean;
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
  /** Orthographic top-down "floorplan" look. */
  orthographic?: boolean;
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

/**
 * `isometric` is an orthographic projection — parallel lines stay parallel and
 * a room at the back is drawn the same size as one at the front. It is the
 * default because a floorplan is a drawing, not a photograph.
 *
 * A preset's own `orthographic` field still wins; this only decides what a
 * preset that says nothing about projection means.
 */
export type ProjectionMode = 'isometric' | 'perspective';

export interface CameraConfig {
  navigation?: NavigationMode;
  projection?: ProjectionMode;
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
  castShadow?: boolean;
  /** Visible luminaire geometry at the light position. */
  fixture?: { show?: boolean; radius?: number; emissive?: number };
  /** Per-light bloom weight. */
  bloom?: number;
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
   * Room this entity lights, for `lightMode: room`. Normally derived from the
   * position; set it when a lamp sits in a doorway or a wall recess and lands
   * in the wrong room.
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
 * `shaded` is solid surfaces plus crisp architectural edge lines — the CAD
 * look, and the default. `wireframe` drops the surfaces and leaves only the
 * lines; note that nothing is lit in that mode, because there is no surface
 * for a lamp to fall on. `solid` is surfaces with no edges at all.
 */
export type RenderStyle = 'solid' | 'shaded' | 'wireframe';

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

export interface RenderConfig {
  style?: RenderStyle;
  palette?: RenderPalette;
  lightMode?: LightMode;
  /** How strongly a lit room is tinted, 0..2. Only used by `lightMode: room`. */
  roomFillStrength?: number;
  /** Colour of the edge lines; defaults to a theme-derived ink. */
  edgeColor?: string;
  /** 'high' = shadows + bloom + SSAO-ish, 'auto' picks by device. */
  quality?: 'low' | 'medium' | 'high' | 'auto';
  shadows?: boolean;
  bloom?: boolean;
  bloomStrength?: number;
  bloomRadius?: number;
  bloomThreshold?: number;
  exposure?: number;
  /** Base ambient level so an all-lights-off house is not pitch black. */
  ambientIntensity?: number;
  /** Sun/sky, optionally driven by sun.sun. */
  daylight?: boolean;
  daylightEntity?: string;
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
   * Master switch for the translucent storeys above an isolated level. Set it
   * once — `true` always, `false` never — and it wins over every preset's own
   * `section.ghostAbove`. Omit it (or `null`) and each preset decides.
   */
  ghostAbove?: boolean | null;
  showToolbar?: boolean;
  /**
   * A panel view is the wall-tablet case, where the saved views and the
   * orientation cube are the whole interface and a floating button cluster is
   * clutter. Opt back in with `true`.
   */
  showToolbarInPanel?: boolean;
  showPresetBar?: boolean;
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
  ghostAbove: false,
  // Roughly a floor slab plus a little: enough to clear the ceiling of a
  // normal storey without eating into the walls that give the room its shape.
  ceilingCut: 0.45,
};

export const DEFAULT_CAMERA_CONFIG: Required<
  Pick<
    CameraConfig,
    | 'navigation'
    | 'projection'
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
  projection: 'isometric',
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
  // shaded onto the walls.
  style: 'wireframe',
  palette: 'model',
  // A dashboard card answers "which rooms are lit", not "where exactly does the
  // photon land". Physically correct falloff makes a lamp a bright dot in a
  // dark room, which is the wrong reading at floorplan scale.
  lightMode: 'room',
  roomFillStrength: 1,
  edgeColor: '',
  quality: 'auto',
  // Off by default. Real-time shadows are the most expensive thing this card
  // can do — a shadow-casting point light costs six cube-face passes over the
  // whole house per refresh — and a floorplan reads as a cleaner diagram
  // without them. Turn them on per dashboard if you want the extra realism.
  shadows: false,
  bloom: true,
  bloomStrength: 0.55,
  bloomRadius: 0.5,
  bloomThreshold: 0.72,
  exposure: 1.0,
  ambientIntensity: 0.34,
  // Off by default: a floorplan should look the same at 3am as at noon, so the
  // lamps stay the thing that changes. Set `daylight: true` to let sun.sun
  // drive a sun/sky rig instead.
  daylight: false,
  daylightEntity: 'sun.sun',
  background: '',
  maxPixelRatio: 2,
  onDemand: true,
  fpsLimit: 60,
};

export const DEFAULT_UI_CONFIG: Required<UiConfig> = {
  // Not a boolean default: absent means "no opinion", which is what leaves the
  // per-preset setting in charge.
  ghostAbove: null,
  snapPlacement: false,
  showToolbar: true,
  showToolbarInPanel: false,
  showPresetBar: true,
  // Off by default. Isolating a storey and dragging cut planes is how you
  // *author* a view; day to day you just want to jump between the views you
  // saved. Both reappear automatically in edit mode, so nothing is lost.
  showLevelSelector: false,
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
