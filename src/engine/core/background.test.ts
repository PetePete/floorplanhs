import { describe, expect, it } from 'vitest';
import { resolveBackground } from '@/engine/core/background';

describe('resolveBackground', () => {
  it('leaves the canvas transparent by default, inheriting the theme polarity', () => {
    for (const value of ['', '  ', 'transparent', 'none', undefined]) {
      expect(resolveBackground(value, true)).toEqual({ color: null, dark: true });
      expect(resolveBackground(value, false)).toEqual({ color: null, dark: false });
    }
  });

  it('pins light and dark against the theme', () => {
    // The whole point of the keywords: a mono-dark model on a dark dashboard
    // needs a light ground, and the theme must not be able to take it away.
    const light = resolveBackground('light', true);
    expect(light.dark).toBe(false);
    expect(light.color).not.toBeNull();

    const dark = resolveBackground('dark', false);
    expect(dark.dark).toBe(true);
    expect(dark.color).not.toBeNull();
  });

  it('follows the theme for system, but stays opaque', () => {
    expect(resolveBackground('system', true).dark).toBe(true);
    expect(resolveBackground('system', true).color).not.toBeNull();
    expect(resolveBackground('auto', false).dark).toBe(false);
    expect(resolveBackground('auto', false).color).not.toBeNull();
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveBackground('  LIGHT ', true).dark).toBe(false);
  });

  it('judges a CSS colour by its own luminance, not the theme', () => {
    expect(resolveBackground('#ffffff', true).dark).toBe(false);
    expect(resolveBackground('#101014', false).dark).toBe(true);
    expect(resolveBackground('white', true).dark).toBe(false);
    expect(resolveBackground('black', false).dark).toBe(true);
    expect(resolveBackground('rgb(240, 242, 245)', true).dark).toBe(false);
  });

  it('passes the colour through verbatim so the renderer parses it once', () => {
    expect(resolveBackground('#ffcc88', true).color).toBe('#ffcc88');
  });

  it('falls back to the theme for values it cannot measure', () => {
    // `var(--card-background-color)` is legal config; three.js cannot parse it,
    // and guessing wrong here would pick unreadable edge ink.
    expect(resolveBackground('var(--card-background-color)', true).dark).toBe(true);
    expect(resolveBackground('var(--card-background-color)', false).dark).toBe(false);
  });

  it('does not let one unparseable value poison the next lookup', () => {
    resolveBackground('var(--nope)', true);
    expect(resolveBackground('#ffffff', true).dark).toBe(false);
  });
});
