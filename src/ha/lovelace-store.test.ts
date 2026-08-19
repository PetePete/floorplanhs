import { describe, expect, it } from 'vitest';

import { cardMatcher, countCards, substituteCard } from '@/ha/lovelace-store';

const TYPE = 'floorplan-3d-card';

function dashboard(...cards: unknown[]): Record<string, unknown> {
  return {
    views: [
      { title: 'Ground', cards: [{ type: 'light' }, ...cards] },
      { title: 'Nested', sections: [{ type: 'grid', cards: [{ type: 'markdown' }] }] },
    ],
  };
}

describe('countCards', () => {
  it('counts through views, sections and nested stacks', () => {
    const config = {
      views: [
        { cards: [{ type: `custom:${TYPE}` }] },
        {
          sections: [
            {
              cards: [
                { type: 'vertical-stack', cards: [{ type: `custom:${TYPE}` }, { type: 'light' }] },
              ],
            },
          ],
        },
      ],
    };
    expect(countCards(config, TYPE)).toBe(2);
  });

  it('ignores other card types', () => {
    expect(countCards(dashboard({ type: 'custom:other-card' }), TYPE)).toBe(0);
  });
});

describe('cardMatcher', () => {
  it('matches the very object Home Assistant handed the card', () => {
    const own = { type: `custom:${TYPE}`, model: { url: '/local/a.sh3d' } };
    const config = dashboard(own);
    const matches = cardMatcher(config, own, TYPE);
    expect(matches?.(own)).toBe(true);
  });

  it('matches an equal copy, for dashboards that hand out clones', () => {
    const own = { type: `custom:${TYPE}`, model: { url: '/local/a.sh3d' } };
    const clone = JSON.parse(JSON.stringify(own)) as unknown;
    const matches = cardMatcher(dashboard(clone), own, TYPE);
    expect(matches?.(clone)).toBe(true);
  });

  it('falls back to the type when the card is the only one of its kind', () => {
    const config = dashboard({ type: `custom:${TYPE}` });
    const matches = cardMatcher(config, null, TYPE);
    expect(matches).not.toBeNull();
    expect(matches?.({ type: `custom:${TYPE}` })).toBe(true);
  });

  /** Two identical cards and no way to tell them apart: saving would move the
   *  placement on the wrong one, so nothing is matched. */
  it('refuses to guess between two cards it cannot tell apart', () => {
    const config = dashboard({ type: `custom:${TYPE}` }, { type: `custom:${TYPE}` });
    expect(cardMatcher(config, null, TYPE)).toBeNull();
  });

  it('does not match a card of another type that happens to be equal', () => {
    const own = { type: `custom:${TYPE}`, title: 'x' };
    const matches = cardMatcher(dashboard(own), own, TYPE);
    expect(matches?.({ type: 'custom:other-card', title: 'x' })).toBe(false);
  });
});

describe('substituteCard', () => {
  it('replaces the card and leaves everything else alone', () => {
    const own = { type: `custom:${TYPE}`, entities: [] };
    const config = dashboard(own);
    const next = { type: `custom:${TYPE}`, entities: [{ entity: 'light.a' }] };

    const updated = substituteCard(config, cardMatcher(config, own, TYPE)!, next) as typeof config;
    const cards = (updated.views as Array<{ cards?: unknown[] }>)[0]?.cards ?? [];
    expect(cards[1]).toBe(next);
    expect(cards[0]).toEqual({ type: 'light' });
    // Untouched branches are shared, not copied.
    expect((updated.views as unknown[])[1]).toBe((config.views as unknown[])[1]);
  });

  it('reaches a card nested inside a stack inside a section', () => {
    const own = { type: `custom:${TYPE}`, entities: [] };
    const config = {
      views: [{ sections: [{ cards: [{ type: 'vertical-stack', cards: [{ type: 'light' }, own] }] }] }],
    };
    const next = { type: `custom:${TYPE}`, entities: [{ entity: 'light.b' }] };

    const updated = substituteCard(config, cardMatcher(config, own, TYPE)!, next);
    expect(JSON.stringify(updated)).toContain('light.b');
    expect(updated).not.toBeNull();
  });

  it('returns null when the card is not in this dashboard', () => {
    const own = { type: `custom:${TYPE}`, entities: [] };
    const config = dashboard({ type: `custom:${TYPE}`, title: 'a different one' });
    const matches = cardMatcher(config, own, TYPE);
    expect(matches).not.toBeNull();
    expect(substituteCard(config, matches!, { type: `custom:${TYPE}` })).toBeNull();
  });

  it('does not mutate the config it was given', () => {
    const own = { type: `custom:${TYPE}`, entities: [] };
    const config = dashboard(own);
    const before = JSON.stringify(config);
    substituteCard(config, cardMatcher(config, own, TYPE)!, { type: `custom:${TYPE}`, entities: [1] });
    expect(JSON.stringify(config)).toBe(before);
  });
});
