/**
 * Getting `Home.xml` out of a `.sh3d` file.
 *
 * A Sweet Home 3D save file is a plain ZIP. Since version 5.0 the whole home is
 * in one entry, `Home.xml`; everything else in the archive is content the home
 * references — furniture models as OBJ, textures as JPEG/PNG, thumbnails —
 * addressed from the XML by entry name (`model='3/window.obj'`).
 *
 * Only `Home.xml` is inflated. The archives are big — the sample this was
 * written against is 36 MB across 515 entries, of which `Home.xml` is 128 kB —
 * and inflating the OBJ and JPEG payloads to throw them away would cost more
 * than the rest of the import put together.
 */

import { unzipSync } from 'fflate';

/** Thrown for anything the user can act on: wrong file, wrong version. */
export class Sh3dError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sh3dError';
  }
}

const HOME_XML = 'Home.xml';
/** The pre-5.0 entry: a Java-serialised object graph we cannot read. */
const LEGACY_HOME = 'Home';

export interface Sh3dArchive {
  xml: string;
  /** Every entry name, so the caller can tell what content came with the home. */
  entries: string[];
}

/** True when the bytes begin with the ZIP local-file signature `PK\x03\x04`. */
export function looksLikeZip(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const head = new Uint8Array(buffer, 0, 4);
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/**
 * Reads the home document out of a `.sh3d` archive.
 *
 * The filter runs over every entry in the central directory but only returns
 * true for `Home.xml`, so we collect the full listing and pay the inflate cost
 * exactly once.
 */
export function readSh3dArchive(buffer: ArrayBuffer): Sh3dArchive {
  if (!looksLikeZip(buffer)) {
    throw new Sh3dError(
      'This is not a Sweet Home 3D file — a .sh3d is a ZIP archive and this one does not start like one.',
    );
  }

  const entries: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buffer), {
      filter: (file) => {
        entries.push(file.name);
        return file.name === HOME_XML;
      },
    });
  } catch (err) {
    throw new Sh3dError(
      `Could not read the .sh3d archive — ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const home = files[HOME_XML];
  if (!home) {
    if (entries.includes(LEGACY_HOME)) {
      throw new Sh3dError(
        'This file was saved by an old Sweet Home 3D — open and re-save it with version 5 or newer.',
      );
    }
    throw new Sh3dError(
      `No ${HOME_XML} inside the archive (${entries.length} entries) — is this really a Sweet Home 3D file?`,
    );
  }

  return { xml: new TextDecoder('utf-8').decode(home), entries };
}
