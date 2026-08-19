/**
 * Writing back to the dashboard from the card itself.
 *
 * A card is normally a read-only citizen: Lovelace hands it a config and takes
 * changes only from that card's *editor*. That is fine for typing a number into
 * a field and hopeless for dragging a lamp onto a floor, where the whole point
 * is the room-sized view the dashboard has and the editor's preview does not.
 *
 * Home Assistant does hand every view a `lovelace` object, and that object owns
 * the dashboard config and can save it. This module finds it, locates one card
 * inside that config, and produces the config with that one card replaced. It
 * never saves by itself — the caller decides that, and only in edit mode.
 */

import { ancestorsAcrossShadow } from '@/util/dom-chain';

export interface LovelaceHost {
  /** The whole dashboard config, views and all. */
  config: unknown;
  /** True while the user has the dashboard in edit mode. */
  editMode?: boolean;
  /** `storage` can be written; a YAML dashboard cannot. */
  mode?: string;
  saveConfig(config: unknown): Promise<void>;
}

function isLovelaceHost(value: unknown): value is LovelaceHost {
  if (!value || typeof value !== 'object') return false;
  const host = value as Partial<LovelaceHost>;
  return typeof host.saveConfig === 'function' && host.config !== undefined;
}

/**
 * The nearest ancestor carrying a `lovelace` object.
 *
 * The walk crosses shadow boundaries, because that is where Home Assistant puts
 * the card: inside `hui-card`, inside the view's shadow root. `hui-view` and
 * `hui-panel-view` are the elements that hold the object.
 */
export function findLovelaceHost(start: Node): LovelaceHost | null {
  for (const el of ancestorsAcrossShadow(start)) {
    if (el.localName === 'body' || el.localName === 'html') break;
    const candidate = (el as HTMLElement & { lovelace?: unknown }).lovelace;
    if (isLovelaceHost(candidate)) return candidate;
  }
  return null;
}

/** How a card object is recognised inside the dashboard config. */
export type CardMatcher = (candidate: unknown) => boolean;

function isCardOfType(value: unknown, type: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const declared = (value as { type?: unknown }).type;
  return typeof declared === 'string' && declared.replace(/^custom:/, '') === type;
}

/**
 * Which object in the dashboard config *is* this card.
 *
 * Identity first: Home Assistant usually passes the very object it holds. Then
 * an exact value match, for the dashboards that hand out copies. Only if the
 * card type occurs exactly once in the whole dashboard does the type alone
 * decide — with two of them and no better evidence, guessing would write a
 * placement into the wrong card, so nothing is matched at all.
 */
export function cardMatcher(config: unknown, own: unknown, type: string): CardMatcher | null {
  const serialised = own === undefined ? null : JSON.stringify(own);
  if (own && typeof own === 'object') {
    return (candidate) =>
      candidate === own ||
      (isCardOfType(candidate, type) && JSON.stringify(candidate) === serialised);
  }
  return countCards(config, type) === 1 ? (candidate) => isCardOfType(candidate, type) : null;
}

/** How many cards of this type the dashboard holds, nesting included. */
export function countCards(node: unknown, type: string): number {
  if (Array.isArray(node)) {
    return node.reduce<number>((sum, item) => sum + countCards(item, type), 0);
  }
  if (node && typeof node === 'object') {
    let count = isCardOfType(node, type) ? 1 : 0;
    for (const value of Object.values(node as Record<string, unknown>)) {
      count += countCards(value, type);
    }
    return count;
  }
  return 0;
}

/**
 * The config with one card replaced, or `null` if that card is not in there.
 *
 * Structural sharing, not a deep clone: only the objects on the path down to
 * the card are new. Nesting is walked generically, so a card inside a stack, a
 * grid, or a section is found without knowing what any of those are.
 */
export function substituteCard(node: unknown, matches: CardMatcher, next: unknown): unknown | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const replaced = matches(node[i]) ? next : substituteCard(node[i], matches, next);
      if (replaced === null) continue;
      const copy = node.slice();
      copy[i] = replaced;
      return copy;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (matches(value)) return { ...(node as Record<string, unknown>), [key]: next };
      const replaced = substituteCard(value, matches, next);
      if (replaced !== null) return { ...(node as Record<string, unknown>), [key]: replaced };
    }
  }
  return null;
}
