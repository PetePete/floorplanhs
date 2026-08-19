/**
 * What of the card's chrome is on screen, as rules rather than as expressions
 * buried in a template.
 *
 * These have been got wrong more than once — a control coming back outside edit
 * mode, a button that does nothing in the view it is shown in — and a rule
 * spelled out inside a 200-line render method is a rule nobody can check. Here
 * each one is a function with a name and a test.
 */

import type { Floorplan3dCardConfig, SectionState, UiConfig } from '@/types/config';

export type AuthorMode = 'auto' | 'never' | 'always';

/** The tools that only make sense while building the card, not while using it. */
export function authorToolsVisible(mode: AuthorMode, editing: boolean): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  return editing;
}

/**
 * The scissors. An editing tool, so it follows the dashboard's edit mode —
 * `showSectionControls: true` is the way to keep it on a card people only look
 * at, and it is off by default.
 */
export function sectionButtonVisible(ui: UiConfig, mode: AuthorMode, editing: boolean): boolean {
  if (mode === 'never') return false;
  return ui.showSectionControls === true || authorToolsVisible(mode, editing);
}

/** The section panel itself, which must never be reachable when its button is not. */
export function sectionPanelVisible(ui: UiConfig, mode: AuthorMode, editing: boolean): boolean {
  return sectionButtonVisible(ui, mode, editing);
}

/**
 * Pulling the storeys apart says something about a building and nothing about a
 * single storey: with one floor showing, the button moved that floor up and down
 * for no reason.
 */
export function explodeAvailable(
  levelCount: number,
  section: SectionState | null,
  visibleLevels: string[] | null,
): boolean {
  if (levelCount < 2) return false;
  if (section?.mode === 'level') return false;
  return visibleLevels === null || visibleLevels.length > 1;
}

/**
 * One switch decides the toolbar, everywhere.
 *
 * A panel view used to hide it unless a second flag opted back in, which made
 * `showToolbar: true` a lie in exactly the layout a floorplan is most likely to
 * be given — and that second flag was never read by the schema at all.
 */
export function toolbarVisible(ui: UiConfig): boolean {
  return ui.showToolbar !== false;
}

/** The navigator: building, storeys and saved views. On unless switched off. */
export function levelSelectorVisible(ui: UiConfig): boolean {
  return ui.showLevelSelector !== false;
}

/**
 * Dark or light, from the card's own setting and the dashboard's.
 *
 * `auto` follows Home Assistant, which is what a card should do by default. The
 * other two are a decision: a floorplan is a drawing, and a drawing that has to
 * read on a wall tablet in daylight cannot be at the mercy of whichever theme
 * the dashboard is wearing this week.
 */
export function resolveDark(theme: UiConfig['theme'], dashboardIsDark: boolean): boolean {
  if (theme === 'light') return false;
  if (theme === 'dark') return true;
  return dashboardIsDark;
}

/** Handy in tests and at the call site: every rule against one config. */
export function chromeVisibility(
  config: Floorplan3dCardConfig,
  state: { editing: boolean; levelCount: number; visibleLevels: string[] | null },
): {
  author: boolean;
  section: boolean;
  explode: boolean;
  toolbar: boolean;
  levels: boolean;
} {
  const ui = config.ui ?? {};
  const mode = ui.authorTools ?? 'auto';
  return {
    author: authorToolsVisible(mode, state.editing),
    section: sectionButtonVisible(ui, mode, state.editing),
    explode: explodeAvailable(state.levelCount, config.section ?? null, state.visibleLevels),
    toolbar: toolbarVisible(ui),
    levels: levelSelectorVisible(ui),
  };
}
