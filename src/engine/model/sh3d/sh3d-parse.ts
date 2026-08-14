/**
 * `Home.xml` → a typed model of the home. Pure: no three.js, no DOM, no I/O.
 *
 * ## Units and axes — the only two things you have to keep straight
 *
 * Sweet Home 3D works in **centimetres**, and its plan is an (x, y) sheet with
 * y running *down* the screen. This card works in metres with Y up. So:
 *
 *   world X = sh3d x / 100
 *   world Z = sh3d y / 100      (the plan's "down" is south, which is +Z)
 *   world Y = elevation / 100   (up)
 *
 * Everything this module returns is already in metres. Nothing downstream
 * should ever see a centimetre again.
 *
 * An `angle` is radians, turning clockwise in the plan. Because the plan's y
 * maps to world Z, that same rotation is `rotation.y = -angle` in three.js —
 * see `sh3d-build.ts`.
 *
 * ## Why a hand-written scanner and not `DOMParser`
 *
 * `DOMParser` is a browser global and does not exist in the Node environment
 * the unit tests run in. Rather than test a different code path from the one
 * that ships, this parses the document itself. `Home.xml` is a plain,
 * attribute-only dialect — no namespaces, no mixed content we care about — so
 * the scanner below is ~80 lines and does the whole job, with the pleasant side
 * effect of being faster than building a DOM we would immediately discard.
 */

/* ------------------------------------------------------------------- xml */

interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body] ?? match;
  });
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Builds an element tree. Text nodes are dropped: every value `Home.xml` holds
 * that this importer needs lives in an attribute.
 */
function parseXml(text: string): XmlElement {
  const root: XmlElement = { tag: '#root', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const n = text.length;
  let i = 0;

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt + 1;
    const lead = text[i];

    if (lead === '?') {
      const end = text.indexOf('?>', i);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (lead === '!') {
      if (text.startsWith('!--', i)) {
        const end = text.indexOf('-->', i);
        i = end < 0 ? n : end + 3;
      } else if (text.startsWith('![CDATA[', i)) {
        const end = text.indexOf(']]>', i);
        i = end < 0 ? n : end + 3;
      } else {
        const end = text.indexOf('>', i);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }
    if (lead === '/') {
      const end = text.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }

    let cursor = i;
    while (cursor < n && !isSpace(text[cursor]) && text[cursor] !== '>' && text[cursor] !== '/') {
      cursor += 1;
    }
    const tag = text.slice(i, cursor);
    i = cursor;

    const attrs: Record<string, string> = {};
    let selfClosing = false;

    for (;;) {
      while (i < n && isSpace(text[i])) i += 1;
      if (i >= n) break;
      if (text[i] === '>') {
        i += 1;
        break;
      }
      if (text[i] === '/') {
        selfClosing = true;
        i += 1;
        continue;
      }

      let nameEnd = i;
      while (
        nameEnd < n &&
        !isSpace(text[nameEnd]) &&
        text[nameEnd] !== '=' &&
        text[nameEnd] !== '>' &&
        text[nameEnd] !== '/'
      ) {
        nameEnd += 1;
      }
      // No progress means a character we do not understand; skip it rather than
      // spinning forever on a malformed document.
      if (nameEnd === i) {
        i += 1;
        continue;
      }
      const name = text.slice(i, nameEnd);
      i = nameEnd;

      while (i < n && isSpace(text[i])) i += 1;
      if (text[i] !== '=') {
        attrs[name] = '';
        continue;
      }
      i += 1;
      while (i < n && isSpace(text[i])) i += 1;

      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const end = text.indexOf(quote, i + 1);
        attrs[name] = decodeEntities(end < 0 ? text.slice(i + 1) : text.slice(i + 1, end));
        i = end < 0 ? n : end + 1;
      } else {
        let valueEnd = i;
        while (valueEnd < n && !isSpace(text[valueEnd]) && text[valueEnd] !== '>') valueEnd += 1;
        attrs[name] = decodeEntities(text.slice(i, valueEnd));
        i = valueEnd;
      }
    }

    const element: XmlElement = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(element);
    if (!selfClosing) stack.push(element);
  }

  return root;
}

/* ----------------------------------------------------------------- model */

/** Every length below is metres, every angle radians, in world axes. */
export interface Sh3dLevel {
  id: string;
  name: string;
  /** World Y of the walking surface. */
  elevation: number;
  /** Structural floor below `elevation`. */
  floorThickness: number;
  /** Storey height as authored; the builder may widen it to reach the next. */
  height: number;
  /** Distinguishes two levels that share an elevation. */
  elevationIndex: number;
  /** Sweet Home 3D's own "show this level" flag. */
  visible: boolean;
}

export interface Sh3dWall {
  id: string;
  levelId: string | null;
  xStart: number;
  zStart: number;
  xEnd: number;
  zEnd: number;
  /** Height at the start. */
  height: number;
  /** Height at the end when the top slopes; otherwise absent. */
  heightAtEnd: number | null;
  thickness: number;
  /** Radians. Non-zero means the wall bows into an arc between its ends. */
  arcExtent: number;
  /** Ids of the walls joined at each end, if any — used to close the corners. */
  wallAtStart: string | null;
  wallAtEnd: string | null;
}

export interface Sh3dRoom {
  id: string;
  levelId: string | null;
  name: string | null;
  /** Arbitrary closed polygon, world XZ metres. Never assume a rectangle. */
  points: Array<[number, number]>;
  floorVisible: boolean;
  ceilingVisible: boolean;
}

export interface Sh3dOpening {
  id: string;
  levelId: string | null;
  name: string;
  /** Centre of the opening in world XZ. */
  x: number;
  z: number;
  /** Bottom of the opening above its level's floor. */
  elevation: number;
  /** Along the wall. */
  width: number;
  /** Across the wall. */
  depth: number;
  height: number;
  /** Plan rotation, radians clockwise. */
  angle: number;
  /** Our reading of whether this is glazed; see `looksLikeWindow`. */
  window: boolean;
}

export interface Sh3dFurniture {
  id: string;
  levelId: string | null;
  name: string;
  /** Name of the enclosing `furnitureGroup`, if any. */
  group: string | null;
  x: number;
  z: number;
  /** Bottom of the piece above its level's floor. */
  elevation: number;
  width: number;
  depth: number;
  height: number;
  angle: number;
  /** `AARRGGBB` from the file, reduced to 0xRRGGBB; null when unset. */
  color: number | null;
  /** A `<light>` rather than a plain piece. */
  light: boolean;
  /** The archive entry holding the real geometry, e.g. `3/window.obj`. */
  model: string | null;
}

export interface Sh3dHome {
  name: string | null;
  /** File format version; 7400 is Sweet Home 3D 7.4. */
  version: number;
  /** Default wall height for walls that do not state one. */
  wallHeight: number;
  levels: Sh3dLevel[];
  walls: Sh3dWall[];
  rooms: Sh3dRoom[];
  openings: Sh3dOpening[];
  furniture: Sh3dFurniture[];
}

/* ------------------------------------------------------------- attributes */

/** Centimetres to metres. */
const CM = 0.01;

function num(attrs: Record<string, string>, key: string, fallback: number): number {
  const raw = attrs[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function optNum(attrs: Record<string, string>, key: string): number | null {
  const raw = attrs[key];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function bool(attrs: Record<string, string>, key: string, fallback: boolean): boolean {
  const raw = attrs[key];
  if (raw === undefined || raw === '') return fallback;
  return raw !== 'false';
}

function str(attrs: Record<string, string>, key: string): string | null {
  const raw = attrs[key];
  return raw === undefined || raw === '' ? null : raw;
}

/** `AARRGGBB` (or `RRGGBB`) to 0xRRGGBB. The alpha byte is decorative here. */
export function parseColor(raw: string | null): number | null {
  if (!raw) return null;
  const hex = raw.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6,8}$/.test(hex)) return null;
  const value = Number.parseInt(hex.slice(-6), 16);
  return Number.isFinite(value) ? value : null;
}

/**
 * Sweet Home 3D does not record whether a `doorOrWindow` is a door or a window,
 * so we infer it. A raised sill is the strong signal — no door starts 40 cm off
 * the floor — and the catalogue name settles the rest. Getting it wrong only
 * changes whether the hole is filled with glass or with a leaf.
 */
function looksLikeWindow(name: string, elevationCm: number): boolean {
  if (/door|porte|tür|tur|puerta|porta|deur/i.test(name)) return false;
  if (/window|fenêtre|fenetre|fenster|ventana|finestra|raam|baie/i.test(name)) return true;
  return elevationCm > 5;
}

function slugName(attrs: Record<string, string>, fallback: string): string {
  return str(attrs, 'name') ?? fallback;
}

/* --------------------------------------------------------------- parsing */

function readLevel(el: XmlElement, index: number): Sh3dLevel {
  const a = el.attrs;
  return {
    id: str(a, 'id') ?? `level${index}`,
    name: slugName(a, `Level ${index}`),
    elevation: num(a, 'elevation', 0) * CM,
    floorThickness: num(a, 'floorThickness', 12) * CM,
    height: num(a, 'height', 250) * CM,
    elevationIndex: num(a, 'elevationIndex', index),
    visible: bool(a, 'visible', true),
  };
}

function readWall(el: XmlElement, index: number, defaultHeight: number): Sh3dWall {
  const a = el.attrs;
  const heightAtEnd = optNum(a, 'heightAtEnd');
  return {
    id: str(a, 'id') ?? `wall${index}`,
    levelId: str(a, 'level'),
    xStart: num(a, 'xStart', 0) * CM,
    zStart: num(a, 'yStart', 0) * CM,
    xEnd: num(a, 'xEnd', 0) * CM,
    zEnd: num(a, 'yEnd', 0) * CM,
    height: num(a, 'height', defaultHeight / CM) * CM,
    heightAtEnd: heightAtEnd === null ? null : heightAtEnd * CM,
    thickness: Math.max(num(a, 'thickness', 7.5) * CM, 0.01),
    arcExtent: num(a, 'arcExtent', 0),
    wallAtStart: str(a, 'wallAtStart'),
    wallAtEnd: str(a, 'wallAtEnd'),
  };
}

function readRoom(el: XmlElement, index: number): Sh3dRoom {
  const a = el.attrs;
  const points: Array<[number, number]> = [];
  for (const child of el.children) {
    if (child.tag !== 'point') continue;
    points.push([num(child.attrs, 'x', 0) * CM, num(child.attrs, 'y', 0) * CM]);
  }
  return {
    id: str(a, 'id') ?? `room${index}`,
    levelId: str(a, 'level'),
    name: str(a, 'name'),
    points,
    floorVisible: bool(a, 'floorVisible', true),
    ceilingVisible: bool(a, 'ceilingVisible', true),
  };
}

function readOpening(el: XmlElement, index: number): Sh3dOpening {
  const a = el.attrs;
  const name = slugName(a, 'opening');
  const elevationCm = num(a, 'elevation', 0);
  return {
    id: str(a, 'id') ?? `doorOrWindow${index}`,
    levelId: str(a, 'level'),
    name,
    x: num(a, 'x', 0) * CM,
    z: num(a, 'y', 0) * CM,
    elevation: elevationCm * CM,
    width: num(a, 'width', 80) * CM,
    depth: num(a, 'depth', 10) * CM,
    height: num(a, 'height', 200) * CM,
    angle: num(a, 'angle', 0),
    window: looksLikeWindow(name, elevationCm),
  };
}

/**
 * `widthInPlan` / `depthInPlan` / `heightInPlan` are the piece's extent *after*
 * any pitch or roll the model carries. They are exactly what a box placeholder
 * wants, so they win over the nominal dimensions when present.
 */
function readFurniture(
  el: XmlElement,
  index: number,
  group: string | null,
  light: boolean,
): Sh3dFurniture {
  const a = el.attrs;
  return {
    id: str(a, 'id') ?? `furniture${index}`,
    levelId: str(a, 'level'),
    name: slugName(a, 'furniture'),
    group,
    x: num(a, 'x', 0) * CM,
    z: num(a, 'y', 0) * CM,
    elevation: num(a, 'elevation', 0) * CM,
    width: num(a, 'widthInPlan', num(a, 'width', 50)) * CM,
    depth: num(a, 'depthInPlan', num(a, 'depth', 50)) * CM,
    height: num(a, 'heightInPlan', num(a, 'height', 50)) * CM,
    angle: num(a, 'angle', 0),
    color: parseColor(str(a, 'color')),
    light,
    model: str(a, 'model'),
  };
}

/**
 * Walks the home, flattening `furnitureGroup` as it goes: a group's children
 * carry absolute coordinates already, so the group itself is only a name and a
 * bounding box, and keeping the nesting would buy nothing.
 */
export function parseHomeXml(xml: string): Sh3dHome {
  const root = parseXml(xml);
  const home = root.children.find((child) => child.tag === 'home');
  if (!home) {
    throw new Error('Home.xml has no <home> element — the file looks corrupt.');
  }

  const wallHeight = num(home.attrs, 'wallHeight', 250) * CM;
  const result: Sh3dHome = {
    name: str(home.attrs, 'name'),
    version: num(home.attrs, 'version', 0),
    wallHeight,
    levels: [],
    walls: [],
    rooms: [],
    openings: [],
    furniture: [],
  };

  const walk = (element: XmlElement, group: string | null): void => {
    for (const child of element.children) {
      switch (child.tag) {
        case 'level':
          result.levels.push(readLevel(child, result.levels.length));
          break;
        case 'wall':
          result.walls.push(readWall(child, result.walls.length, wallHeight));
          break;
        case 'room':
          result.rooms.push(readRoom(child, result.rooms.length));
          break;
        case 'doorOrWindow':
          result.openings.push(readOpening(child, result.openings.length));
          break;
        case 'pieceOfFurniture':
          result.furniture.push(readFurniture(child, result.furniture.length, group, false));
          break;
        case 'light':
          result.furniture.push(readFurniture(child, result.furniture.length, group, true));
          break;
        case 'furnitureGroup':
          walk(child, str(child.attrs, 'name') ?? group);
          break;
        default:
          break;
      }
    }
  };
  walk(home, null);

  result.levels.sort(
    (a, b) => a.elevation - b.elevation || a.elevationIndex - b.elevationIndex,
  );

  // A home with no <level> at all is a single-storey home; give it the one
  // level everything implicitly belongs to so the rest of the pipeline has
  // exactly one shape to deal with.
  if (result.levels.length === 0) {
    result.levels.push({
      id: 'level0',
      name: 'Ground floor',
      elevation: 0,
      floorThickness: 0.12,
      height: wallHeight,
      elevationIndex: 0,
      visible: true,
    });
  }

  return result;
}
