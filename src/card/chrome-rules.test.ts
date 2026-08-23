import { describe, expect, it } from 'vitest';

import {
  authorToolsVisible,
  chromeVisibility,
  explodeAvailable,
  fitOnEntry,
  levelSelectorVisible,
  resolveDark,
  sectionButtonVisible,
  sectionPanelVisible,
  toolbarVisible,
} from '@/card/chrome-rules';
import { CARD_TYPE, DEFAULT_SECTION_STATE } from '@/types/config';
import type { Floorplan3dCardConfig, SectionState } from '@/types/config';

const plain: Floorplan3dCardConfig = { type: CARD_TYPE, model: { url: '/local/house.sh3d' } };

function section(patch: Partial<SectionState>): SectionState {
  return { ...DEFAULT_SECTION_STATE, ...patch };
}

describe('author tools', () => {
  it('follow the dashboard in auto mode', () => {
    expect(authorToolsVisible('auto', false)).toBe(false);
    expect(authorToolsVisible('auto', true)).toBe(true);
  });

  it('are absent in never mode even while editing', () => {
    expect(authorToolsVisible('never', true)).toBe(false);
  });

  it('are present in always mode outside edit mode', () => {
    expect(authorToolsVisible('always', false)).toBe(true);
  });
});

describe('section button', () => {
  /** The regression: the scissors reappearing on a card nobody is editing. */
  it('is hidden on a default card that is not being edited', () => {
    expect(sectionButtonVisible({}, 'auto', false)).toBe(false);
  });

  it('appears with the dashboard in edit mode', () => {
    expect(sectionButtonVisible({}, 'auto', true)).toBe(true);
  });

  it('stays on when the config asks for it', () => {
    expect(sectionButtonVisible({ showSectionControls: true }, 'auto', false)).toBe(true);
  });

  it('obeys authorTools: never over showSectionControls', () => {
    expect(sectionButtonVisible({ showSectionControls: true }, 'never', true)).toBe(false);
  });

  /** A panel that opens without a button to open it is a panel you cannot close. */
  it('gates the panel exactly as it gates the button', () => {
    for (const ui of [{}, { showSectionControls: true }, { showSectionControls: false }]) {
      for (const mode of ['auto', 'never', 'always'] as const) {
        for (const editing of [false, true]) {
          expect(sectionPanelVisible(ui, mode, editing)).toBe(sectionButtonVisible(ui, mode, editing));
        }
      }
    }
  });
});

describe('explode', () => {
  it('needs more than one storey', () => {
    expect(explodeAvailable(1, null, null)).toBe(false);
    expect(explodeAvailable(3, null, null)).toBe(true);
  });

  it('is unavailable in a level view', () => {
    expect(explodeAvailable(3, section({ mode: 'level', levelId: 'ground' }), null)).toBe(false);
  });

  it('is unavailable with a single storey visible', () => {
    expect(explodeAvailable(3, null, ['ground'])).toBe(false);
    expect(explodeAvailable(3, null, ['ground', 'upper'])).toBe(true);
  });
});

describe('toolbar and navigator', () => {
  it('are on unless switched off', () => {
    expect(toolbarVisible({})).toBe(true);
    expect(toolbarVisible({ showToolbar: false })).toBe(false);
    expect(levelSelectorVisible({})).toBe(true);
    expect(levelSelectorVisible({ showLevelSelector: false })).toBe(false);
  });
});

describe('chromeVisibility', () => {
  it('leaves a plain card with navigation only', () => {
    const visible = chromeVisibility(plain, { editing: false, levelCount: 2, visibleLevels: null });
    expect(visible).toEqual({
      author: false,
      section: false,
      explode: true,
      toolbar: true,
      levels: true,
    });
  });

  it('reads the section state out of the config', () => {
    const config: Floorplan3dCardConfig = {
      ...plain,
      section: section({ mode: 'level', levelId: 'upper' }),
    };
    expect(
      chromeVisibility(config, { editing: true, levelCount: 3, visibleLevels: null }).explode,
    ).toBe(false);
  });
});

/**
 * `ui.theme` was in the schema and in the editor and read by nobody: picking
 * Light did nothing at all.
 */
describe('theme', () => {
  it('follows the dashboard on auto', () => {
    expect(resolveDark('auto', true)).toBe(true);
    expect(resolveDark('auto', false)).toBe(false);
  });

  it('follows the dashboard when nothing is set', () => {
    expect(resolveDark(undefined, true)).toBe(true);
    expect(resolveDark(undefined, false)).toBe(false);
  });

  it('overrules a dark dashboard when the card asks for light', () => {
    expect(resolveDark('light', true)).toBe(false);
  });

  it('overrules a light dashboard when the card asks for dark', () => {
    expect(resolveDark('dark', false)).toBe(true);
  });
});

/**
 * A viewpoint is saved with the shape of the card it was framed in. Restored
 * into a card of a different shape it puts you inside the building, and the
 * first move is to pinch back out until the house appears — so on those cards
 * the card does it for you.
 */
describe('framing the house on entry', () => {
  it('does it on a phone held upright', () => {
    expect(fitOnEntry(392, true)).toBe(true);
  });

  /** As wide as a laptop and still nothing like one. */
  it('does it on a phone held sideways', () => {
    expect(fitOnEntry(844, true)).toBe(true);
  });

  it('does it in a narrow column beside a sidebar', () => {
    expect(fitOnEntry(430, false)).toBe(true);
  });

  it('leaves a full-width card alone', () => {
    expect(fitOnEntry(1200, false)).toBe(false);
  });

  /**
   * The phones that miss a 400px test by twenty pixels are exactly the ones
   * this is for, which is why the wider breakpoint is the one that counts.
   */
  it('does not stop caring at four hundred pixels', () => {
    expect(fitOnEntry(412, false)).toBe(true);
    expect(fitOnEntry(659, false)).toBe(true);
  });

  it('says no rather than yes when the card has not been measured yet', () => {
    expect(fitOnEntry(0, false)).toBe(false);
  });
});
