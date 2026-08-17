/**
 * A synthetic Sweet Home 3D home, shared by every test that needs a house.
 *
 * Written out rather than checked in as a binary `.sh3d`: the format is
 * centimetres and the conversion is what is being tested, so the numbers have
 * to be readable next to the assertions. No binary fixture goes in the
 * repository, and no test may depend on a real building's plan.
 *
 * Two storeys; the ground floor is a 600 x 400 cm box of four 20 cm walls with
 * one room covering it, a 100 cm window 90 cm up the south wall, and a table.
 */

import { strToU8, zipSync } from 'fflate';

/**
 * What `userData.room` and `entities[].room` carry: the *slugified room name*,
 * not the Sweet Home 3D `id` attribute.
 */
export const TEST_HOME_ROOM = 'living_room';

/**
 * The importer centres the home on the origin, so the 600 x 400 cm room spans
 * x -2.90..2.90, z -1.90..1.90 in world metres.
 */
export const TEST_HOME_ROOM_CENTRE: [number, number, number] = [0, 2.2, 0];
export const TEST_HOME_LEVELS = ['level0', 'level1'] as const;

export const TEST_HOME_XML = `<?xml version='1.0'?>
<home version='7400' name='Test home' wallHeight='250.0'>
  <level id='level0' name='Ground' elevation='0.0' floorThickness='12.0' height='250.0' elevationIndex='0'/>
  <level id='level1' name='First' elevation='262.0' floorThickness='12.0' height='240.0' elevationIndex='0'/>
  <wall id='w0' level='level0' xStart='0.0' yStart='0.0' xEnd='600.0' yEnd='0.0' height='250.0' thickness='20.0'/>
  <wall id='w1' level='level0' xStart='600.0' yStart='0.0' xEnd='600.0' yEnd='400.0' height='250.0' thickness='20.0'/>
  <wall id='w2' level='level0' xStart='600.0' yStart='400.0' xEnd='0.0' yEnd='400.0' height='250.0' thickness='20.0'/>
  <wall id='w3' level='level0' xStart='0.0' yStart='400.0' xEnd='0.0' yEnd='0.0' height='250.0' thickness='20.0'/>
  <room id='r0' level='level0' name='Living room'>
    <point x='10.0' y='10.0'/>
    <point x='590.0' y='10.0'/>
    <point x='590.0' y='390.0'/>
    <point x='10.0' y='390.0'/>
  </room>
  <doorOrWindow id='d0' level='level0' name='Window' x='300.0' y='400.0' elevation='90.0'
                width='100.0' depth='20.0' height='120.0' angle='0.0'/>
  <pieceOfFurniture id='f0' level='level0' name='Table' x='300.0' y='200.0' elevation='0.0'
                    width='120.0' depth='80.0' height='75.0' angle='0.0' color='FF8A5F3C'/>
</home>`;

/**
 * The same shell split down the middle by a 10 cm partition into two rooms.
 *
 * Room fill lives or dies on that partition: a fill that leaks past it is
 * indistinguishable from a plain point light. One room cannot show that, so
 * anything testing the boundary uses this home instead.
 *
 * Ground floor spans 0..600 x 0..400 cm. The importer centres the building, so
 * world x runs -3..3 and world z runs -2..2.
 */
export const TEST_HOME_TWO_ROOMS_XML = `<?xml version='1.0'?>
<home version='7400' name='Two rooms' wallHeight='250.0'>
  <level id='level0' name='Ground' elevation='0.0' floorThickness='12.0' height='250.0' elevationIndex='0'/>
  <wall id='w0' level='level0' xStart='0.0' yStart='0.0' xEnd='600.0' yEnd='0.0' height='250.0' thickness='20.0'/>
  <wall id='w1' level='level0' xStart='600.0' yStart='0.0' xEnd='600.0' yEnd='400.0' height='250.0' thickness='20.0'/>
  <wall id='w2' level='level0' xStart='600.0' yStart='400.0' xEnd='0.0' yEnd='400.0' height='250.0' thickness='20.0'/>
  <wall id='w3' level='level0' xStart='0.0' yStart='400.0' xEnd='0.0' yEnd='0.0' height='250.0' thickness='20.0'/>
  <wall id='w4' level='level0' xStart='300.0' yStart='0.0' xEnd='300.0' yEnd='400.0' height='250.0' thickness='10.0'/>
  <room id='r0' level='level0' name='Living room'>
    <point x='10.0' y='10.0'/>
    <point x='295.0' y='10.0'/>
    <point x='295.0' y='390.0'/>
    <point x='10.0' y='390.0'/>
  </room>
  <room id='r1' level='level0' name='Kitchen'>
    <point x='305.0' y='10.0'/>
    <point x='590.0' y='10.0'/>
    <point x='590.0' y='390.0'/>
    <point x='305.0' y='390.0'/>
  </room>
</home>`;

/** Slugified room names, which is what `userData.room` carries. */
export const TWO_ROOMS = { west: 'living_room', east: 'kitchen' } as const;

/** Centres of the two rooms in world metres, at lamp height. */
export const TWO_ROOM_CENTRES: Record<'west' | 'east', [number, number, number]> = {
  west: [-1.475, 2.2, 0],
  east: [1.475, 2.2, 0],
};

export function TEST_HOME_TWO_ROOMS_SH3D(): ArrayBuffer {
  return sh3dArchive({ 'Home.xml': TEST_HOME_TWO_ROOMS_XML });
}

export function sh3dArchive(files: Record<string, string>): ArrayBuffer {
  const zipped = zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
  return zipped.buffer.slice(
    zipped.byteOffset,
    zipped.byteOffset + zipped.byteLength,
  ) as ArrayBuffer;
}

/** The fixture as the bytes `buildFromSh3d` expects. */
export function TEST_HOME_SH3D(): ArrayBuffer {
  return sh3dArchive({ 'Home.xml': TEST_HOME_XML });
}
