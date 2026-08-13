/**
 * Bundle entry point.
 *
 * Home Assistant loads this file as a single ES module from `/local` or
 * `/hacsfiles` and expects three things to have happened by the time it
 * resolves: the card tag is defined, the editor tag is defined, and an entry
 * exists in `window.customCards` so the card shows up in the picker.
 *
 * Everything here is defensive about running twice. HA re-fetches card
 * resources when the user hits "reload resources", and a duplicate
 * `customElements.define` throws — which would take down every card on the
 * dashboard, not just this one.
 */

import { Floorplan3dCard } from '@/card/floorplan-3d-card';
import { CARD_TAG, CARD_TYPE, CARD_VERSION } from '@/types/config';

// Side-effect import: defines <floorplan-3d-card-editor>.
import '@/editor/floorplan-3d-card-editor';

const DOCUMENTATION_URL = 'https://github.com/floorplan-3d-card/floorplan-3d-card';

function defineCard(): void {
  if (customElements.get(CARD_TAG)) return;
  customElements.define(CARD_TAG, Floorplan3dCard);
}

/**
 * The picker reads this array. `preview: true` makes HA render a live instance
 * from `getStubConfig` in the card chooser, which is the whole first impression
 * of the card.
 */
function registerInPicker(): void {
  const cards = (window.customCards = window.customCards ?? []);
  if (cards.some((entry) => entry.type === CARD_TYPE)) return;
  cards.push({
    type: CARD_TYPE,
    name: 'Floorplan 3D',
    description:
      'Interactive 3D floorplan with cross-sections, camera views and lights driven by your entities.',
    preview: true,
    documentationURL: DOCUMENTATION_URL,
  });
}

/** The console banner every HA custom card prints; it is how users report versions. */
function printBanner(): void {
  const flag = '__floorplan3dBannerPrinted';
  const store = window as unknown as Record<string, boolean | undefined>;
  if (store[flag]) return;
  store[flag] = true;

  console.info(
    `%c FLOORPLAN-3D-CARD %c v${CARD_VERSION} `,
    'color:#fff;background:#03a9f4;font-weight:700;border-radius:3px 0 0 3px;padding:2px 6px',
    'color:#03a9f4;background:#1c1c1c;font-weight:700;border-radius:0 3px 3px 0;padding:2px 6px',
  );
}

defineCard();
registerInPicker();
printBanner();

export { Floorplan3dCard };
export type { Floorplan3dCardConfig } from '@/types/config';
