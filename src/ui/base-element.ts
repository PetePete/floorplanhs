/**
 * Shared base for the ten chrome components.
 *
 * It exists to hold three things that would otherwise be copy-pasted ten times:
 * the style stack, a `hass` setter that does *not* re-render by default, and a
 * bound localiser.
 *
 * The `hass` behaviour is the important one. Home Assistant pushes a new `hass`
 * object on every state change of every entity in the house — several per
 * second on a busy install. A `@property` would repaint every panel each time.
 * Here `hass` is a plain accessor and subclasses opt in via `hassChanged`.
 */

import { LitElement, type CSSResultGroup } from 'lit';
import type { PropertyValues } from 'lit';
import { property } from 'lit/decorators.js';
import { uiBaseStyles } from '@/card/card-styles';
import { localize, type LocalizeKey, type LocalizeParams } from '@/ha/localize';
import { readTheme, type ThemeColors } from '@/ha/theme';
import type { HomeAssistant } from '@/types/hass';

/** Layout bucket handed down by the card's ResizeObserver. */
export type UiSize = 'wide' | 'medium' | 'narrow';

/**
 * Guarded `customElements.define`. Home Assistant re-evaluates a card module
 * when the user reloads resources, and a second `define()` for a live tag
 * throws — taking every card on the dashboard down with it.
 */
export function defineFp(tag: string) {
  return (ctor: CustomElementConstructor): void => {
    if (!customElements.get(tag)) customElements.define(tag, ctor);
  };
}

export abstract class FpBaseElement extends LitElement {
  static override styles: CSSResultGroup = uiBaseStyles;

  /** Mirrors the dashboard theme so the glass surfaces pick the right recipe. */
  @property({ type: Boolean, reflect: true }) dark = false;

  @property({ attribute: false }) size: UiSize = 'wide';

  private _hass?: HomeAssistant;
  private _theme: ThemeColors | null = null;
  private readonly cleanups: Array<() => void> = [];

  set hass(value: HomeAssistant | undefined) {
    const previous = this._hass;
    if (previous === value) return;
    this._hass = value;
    this._theme = null;
    this.hassChanged(previous, value);
  }

  get hass(): HomeAssistant | undefined {
    return this._hass;
  }

  /**
   * Called on every HA state push. The default deliberately does nothing —
   * override and call `requestUpdate()` only for the values you actually show.
   */
  protected hassChanged(_previous: HomeAssistant | undefined, _next: HomeAssistant | undefined): void {
    /* opt-in */
  }

  /** HA's palette, resolved from the CSS variables in scope. Cached per hass. */
  protected get theme(): ThemeColors {
    if (!this._theme) this._theme = readTheme(this, this._hass);
    return this._theme;
  }

  /** Card-local translation with a mandatory readable English fallback. */
  protected t(key: LocalizeKey | string, fallback: string, params?: LocalizeParams): string {
    return localize(this._hass, key, fallback, params);
  }

  protected get reducedMotion(): boolean {
    return (
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /** Register a teardown that runs on disconnect. Rule 5: dispose everything. */
  protected onCleanup(fn: () => void): void {
    this.cleanups.push(fn);
  }

  /** Typed, bubbling, shadow-piercing event. All chrome talks to the card here. */
  protected emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }));
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const fn of this.cleanups.splice(0)) {
      try {
        fn();
      } catch (err) {
        console.error('[floorplan-3d] cleanup threw', err);
      }
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has('dark')) this._theme = null;
  }
}
