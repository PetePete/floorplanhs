import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Sh3dError, looksLikeZip, readSh3dArchive } from '@/engine/model/sh3d/sh3d-archive';
import { parseHomeXml } from '@/engine/model/sh3d/sh3d-parse';
import { buildFromSh3d, buildSh3dHome, mitreShear } from '@/engine/model/sh3d/sh3d-build';
import {
  TEST_HOME_XML as HOME_XML,
  TEST_HOME_TWO_ROOMS_XML as TWO_ROOMS_XML,
  sh3dArchive as archive,
} from '@/engine/model/sh3d/test-home';

describe('sh3d archive', () => {
  it('reads Home.xml out of a .sh3d', () => {
    const { xml, entries } = readSh3dArchive(archive({ 'Home.xml': HOME_XML, 'Content/0': 'x' }));
    expect(xml).toContain('<home');
    expect(entries).toContain('Content/0');
  });

  it('rejects a file saved by a pre-5.0 Sweet Home 3D', () => {
    // Before 5.0 the home was a Java-serialised `Home` entry with no XML.
    expect(() => readSh3dArchive(archive({ Home: 'java serialised bytes' }))).toThrowError(
      /old Sweet Home 3D — open and re-save it with version 5 or newer/,
    );
  });

  it('rejects something that is not a ZIP at all', () => {
    const bytes = new TextEncoder().encode('glTF not a zip');
    const buffer = bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer;
    expect(looksLikeZip(buffer)).toBe(false);
    expect(() => readSh3dArchive(buffer)).toThrowError(Sh3dError);
  });

  it('rejects a ZIP with no home in it', () => {
    expect(() => readSh3dArchive(archive({ 'readme.txt': 'hello' }))).toThrowError(
      /No Home\.xml inside/,
    );
  });
});

describe('sh3d parse', () => {
  const home = parseHomeXml(HOME_XML);

  it('converts centimetres to metres', () => {
    expect(home.wallHeight).toBeCloseTo(2.5, 6);
    const wall = home.walls[0];
    expect(wall.xStart).toBeCloseTo(0, 6);
    expect(wall.xEnd).toBeCloseTo(6, 6);
    expect(wall.thickness).toBeCloseTo(0.2, 6);
    expect(wall.height).toBeCloseTo(2.5, 6);
  });

  it("maps Sweet Home 3D's plan y onto world Z", () => {
    expect(home.walls[1].zStart).toBeCloseTo(0, 6);
    expect(home.walls[1].zEnd).toBeCloseTo(4, 6);
    expect(home.rooms[0].points).toEqual([
      [0.1, 0.1],
      [5.9, 0.1],
      [5.9, 3.9],
      [0.1, 3.9],
    ]);
  });

  it('reads the storeys in elevation order', () => {
    expect(home.levels.map((l) => l.id)).toEqual(['level0', 'level1']);
    expect(home.levels.map((l) => l.elevation)).toEqual([0, 2.62]);
    expect(home.levels[0].floorThickness).toBeCloseTo(0.12, 6);
  });

  it('treats a raised opening as a window and a floor-level one as a door', () => {
    expect(home.openings[0].window).toBe(true);
    expect(home.openings[0].elevation).toBeCloseTo(0.9, 6);
    const doors = parseHomeXml(
      HOME_XML.replace("name='Window' x='300.0' y='400.0' elevation='90.0'", "name='Front door' x='300.0' y='400.0' elevation='0.0'"),
    );
    expect(doors.openings[0].window).toBe(false);
  });

  it('flattens furniture groups, keeping the group name', () => {
    const grouped = parseHomeXml(
      HOME_XML.replace(
        /<pieceOfFurniture[^]*?\/>/,
        `<furnitureGroup id='g0' level='level0' name='Staircase' x='0' y='0' width='10' depth='10' height='10'>
           <pieceOfFurniture id='f1' level='level0' name='Step' x='100.0' y='100.0' width='80.0' depth='30.0' height='3.0'/>
           <pieceOfFurniture id='f2' level='level0' name='Step' x='130.0' y='100.0' width='80.0' depth='30.0' height='3.0'/>
         </furnitureGroup>`,
      ),
    );
    expect(grouped.furniture).toHaveLength(2);
    expect(grouped.furniture.every((piece) => piece.group === 'Staircase')).toBe(true);
    expect(grouped.furniture[0].x).toBeCloseTo(1, 6);
  });

  it('survives a home with no levels by inventing one', () => {
    const flat = parseHomeXml(HOME_XML.replace(/<level[^]*?\/>\s*<level[^]*?\/>/, ''));
    expect(flat.levels).toHaveLength(1);
    expect(flat.levels[0].elevation).toBe(0);
    expect(flat.walls).toHaveLength(4);
  });
});

describe('sh3d build', () => {
  const house = buildSh3dHome(parseHomeXml(HOME_XML), { textures: false });

  it('reports both storeys at their metric elevations', () => {
    expect(house.levels.map((l) => l.id)).toEqual(['level0', 'level1']);
    expect(house.levels[0].elevation).toBeCloseTo(0, 6);
    expect(house.levels[1].elevation).toBeCloseTo(2.62, 6);
    // The ground floor is stretched to reach the storey above it.
    expect(house.levels[0].height).toBeCloseTo(2.62, 6);
  });

  it('builds the walls at metre scale, centred on the origin', () => {
    const walls = house.nodes.get('level0/structure/walls') as THREE.Mesh | undefined;
    expect(walls).toBeDefined();
    const box = new THREE.Box3().setFromObject(walls!);
    // Sweet Home 3D wall coordinates are centrelines, so the 600 x 400 cm box
    // of centrelines becomes 6.20 x 4.20 m once each wall is extruded across
    // its own 20 cm thickness. Recentred, and 2.50 m tall.
    expect(box.max.x - box.min.x).toBeCloseTo(6.2, 2);
    expect(box.max.z - box.min.z).toBeCloseTo(4.2, 2);
    expect(box.max.y - box.min.y).toBeCloseTo(2.5, 2);
    expect(box.min.x).toBeCloseTo(-3.1, 2);
    expect(box.min.y).toBeCloseTo(0, 3);
  });

  it('fills a window opening with glass and stamps it', () => {
    const glazing = house.nodes.get('level0/structure/glazing') as THREE.Mesh | undefined;
    expect(glazing, 'the window should produce a glass pane').toBeDefined();
    expect(glazing!.userData.glass).toBe(true);
    expect(glazing!.material).toBe(house.materials.glass);
    const box = new THREE.Box3().setFromObject(glazing!);
    // 100 cm wide, from 90 cm to 210 cm above the floor.
    expect(box.max.x - box.min.x).toBeCloseTo(0.94, 2);
    expect(box.min.y).toBeCloseTo(0.93, 2);
    expect(box.max.y).toBeCloseTo(2.07, 2);
  });

  it('names the room from the plan and gives it a floor', () => {
    const floor = house.nodes.get('level0/living_room/floor') as THREE.Mesh | undefined;
    expect(floor).toBeDefined();
    expect(floor!.userData.level).toBe('level0');
    expect(floor!.userData.room).toBe('living_room');
    expect(floor!.userData.part).toBe('floor');
    const box = new THREE.Box3().setFromObject(floor!);
    // The slab hangs below the walking surface by the floor thickness.
    expect(box.max.y).toBeCloseTo(0, 3);
    expect(box.min.y).toBeCloseTo(-0.12, 3);
  });

  it('places furniture as a box and marks it hideable', () => {
    const table = house.nodes.get('level0/living_room/furniture_table') as THREE.Mesh | undefined;
    expect(table).toBeDefined();
    expect(table!.userData.furniture).toBe(true);
    const box = new THREE.Box3().setFromObject(table!);
    expect(box.max.x - box.min.x).toBeCloseTo(1.2, 2);
    expect(box.max.z - box.min.z).toBeCloseTo(0.8, 2);
    expect(box.min.y).toBeCloseTo(0, 3);
    expect(box.max.y).toBeCloseTo(0.75, 3);
  });

  it('stamps every mesh with level, room and part', () => {
    house.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh !== true) return;
      expect(mesh.name.split('/')).toHaveLength(3);
      expect(typeof mesh.userData.level).toBe('string');
      expect(typeof mesh.userData.room).toBe('string');
      expect(typeof mesh.userData.part).toBe('string');
    });
  });

  it('disposes its materials, including the ones it invented for furniture', () => {
    const other = buildSh3dHome(parseHomeXml(HOME_XML), { textures: false });
    // The library carries the standard palette plus the furniture colours.
    expect(other.materials.getAll().length).toBeGreaterThan(10);
    expect(() => other.materials.dispose()).not.toThrow();
    expect(() => other.materials.dispose()).not.toThrow();
  });

  it('builds straight from an archive', () => {
    const built = buildFromSh3d(archive({ 'Home.xml': HOME_XML }), { textures: false });
    expect(built.report).toEqual({
      levels: 2,
      walls: 4,
      rooms: 1,
      openings: 1,
      unmatchedOpenings: 0,
      furniture: 1,
      furnitureWithModels: 0,
    });
  });

  it('mitres a corner, leaving one edge outside and one inside', () => {
    // Sweet Home 3D only records wallAtStart/wallAtEnd for walls drawn as one
    // connected run, and the fixture's walls carry neither — so the join has to
    // be found from the geometry or the corner is not built at all.
    //
    // What the mitre has to produce is exactly two vertical edges: one at the
    // outside corner and one at the inside corner. Square-cut walls pushed into
    // each other instead give four — the two real corners plus the buried box's
    // end edges, which sit on the neighbour's face a wall thickness away and
    // show up as spurious lines in a hidden-line drawing.
    const home = buildSh3dHome(parseHomeXml(HOME_XML), { textures: false });
    const mesh = home.nodes.get('level0/structure/walls') as THREE.Mesh;
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute('position');
    const v = new THREE.Vector3();

    // The north-west corner of the 6.00 x 4.00 m shell, after recentring. Walls
    // are 20 cm thick, so the outside corner is at (-3.10, -2.10) and the
    // inside one at (-2.90, -1.90).
    const footprints = new Set<string>();
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      if (v.x > -2.7 || v.z > -1.7) continue;
      footprints.add(`${v.x.toFixed(2)},${v.z.toFixed(2)}`);
    }
    expect([...footprints].sort()).toEqual(['-2.90,-1.90', '-3.10,-2.10']);
  });

  it('stops an interior wall on the face of the one it runs into', () => {
    // Sweet Home 3D draws to centrelines, so a partition meeting a wall
    // part-way along ends half that wall's thickness *inside* it. Its end face
    // and both of that face's vertical edges are then buried in solid, while
    // the line a plan actually wants — where the partition meets the visible
    // face — belongs to neither body and is drawn nowhere.
    const home = buildSh3dHome(parseHomeXml(TWO_ROOMS_XML), { textures: false });
    const mesh = home.nodes.get('level0/structure/walls') as THREE.Mesh;
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute('position');
    const v = new THREE.Vector3();

    // The 10 cm partition runs along x = 0. The north wall is 20 cm thick on
    // the z = -2.00 centreline, so its inside face is at z = -1.90 and that is
    // where the partition has to stop.
    let nearest = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      if (Math.abs(v.x) > 0.06) continue;
      if (v.z > 0) continue;
      nearest = Math.max(nearest, v.z);
      expect(v.z, 'no partition geometry inside the wall').toBeGreaterThan(-1.95);
    }
    expect(nearest).toBeCloseTo(-1.9, 2);
  });

  it('does not mitre two walls that merely run alongside each other', () => {
    // A real plan is full of ends that are near each other without being a
    // corner: an inner leaf and its outer skin run parallel 18 cm apart, so
    // their ends sit within a wall thickness of one another and the join
    // detector pairs them. Their bisector then lies almost along the wall, the
    // mitre goes to infinity with it, and the shear drags one wall metres down
    // its own axis — a 9.8 m house came out 36.8 m wide.
    const home = buildSh3dHome(
      parseHomeXml(`<?xml version='1.0'?>
<home version='7400' name='Parallel' wallHeight='250.0'>
  <level id='level0' name='Ground' elevation='0.0' floorThickness='12.0' height='250.0' elevationIndex='0'/>
  <wall id='inner' level='level0' xStart='13.0' yStart='490.0' xEnd='990.0' yEnd='489.0'
        height='236.0' thickness='12.0'/>
  <wall id='outer' level='level0' xStart='13.0' yStart='472.0' xEnd='988.0' yEnd='472.0'
        height='236.0' thickness='25.0'/>
</home>`),
      { textures: false },
    );
    const width = home.bounds.max.x - home.bounds.min.x;
    // The walls are 9.77 m long; anything beyond them plus a little for the
    // thickness means a mitre ran away.
    expect(width).toBeLessThan(10.2);
  });

  it('still mitres a corner sharp enough to be one', () => {
    // The limit must not be so eager that ordinary corners lose their mitre.
    expect(mitreShear([1, 0], [0, 1])).toBeCloseTo(1, 5);
    // 45 degrees: cot(22.5) = 2.414, comfortably inside the limit.
    const diagonal = Math.SQRT1_2;
    expect(Math.abs(mitreShear([1, 0], [diagonal, diagonal]))).toBeCloseTo(2.414, 2);
    // Nearly parallel: refused, and cut square instead.
    expect(mitreShear([1, 0], [0.9998, 0.02])).toBe(0);
  });

  it('slopes a wall top when heightAtEnd differs', () => {
    // One wall on its own. With the other three present their corner geometry
    // reaches the same x as this wall's ends — they are joined, so every wall
    // now runs half a thickness past the drawn corner — and the tallest vertex
    // at each end belongs to a side wall of uniform height, hiding the slope.
    const sloped = buildSh3dHome(
      parseHomeXml(`<?xml version='1.0'?>
<home version='7400' name='Sloped' wallHeight='250.0'>
  <level id='level0' name='Ground' elevation='0.0' floorThickness='12.0' height='250.0' elevationIndex='0'/>
  <wall id='w0' level='level0' xStart='0.0' yStart='0.0' xEnd='600.0' yEnd='0.0'
        height='250.0' heightAtEnd='150.0' thickness='20.0'/>
</home>`),
      { textures: false },
    );
    const mesh = sloped.nodes.get('level0/structure/walls') as THREE.Mesh;
    mesh.updateWorldMatrix(true, false);
    const position = mesh.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    // A bounding box would only show that *something* is 2.50 m tall, so sample
    // the vertices at each end of the wall, which falls west to east from
    // 2.50 m to 1.50 m.
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      minX = Math.min(minX, v.x);
      maxX = Math.max(maxX, v.x);
    }

    let westTop = -Infinity;
    let eastTop = -Infinity;
    for (let i = 0; i < position.count; i += 1) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      if (Math.abs(v.x - minX) < 0.05) westTop = Math.max(westTop, v.y);
      if (Math.abs(v.x - maxX) < 0.05) eastTop = Math.max(eastTop, v.y);
    }
    expect(westTop).toBeCloseTo(2.5, 2);
    expect(eastTop).toBeCloseTo(1.5, 2);
  });
});
