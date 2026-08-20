/**
 * Where the camera was, kept across a remount of the card.
 *
 * Home Assistant rebuilds a view's cards whenever the dashboard config changes,
 * and in edit mode the card changes that config itself — every placement, move
 * or deletion. Without this, each drop threw away the whole view and framed the
 * house from scratch: the one moment you are working closely with the model is
 * the one moment it kept jumping away from you.
 *
 * Module-level and never persisted. A fresh page load starts empty and gets the
 * configured opening view, which is the behaviour the config promises; this only
 * spans the seconds between a card being torn down and its replacement mounting.
 */

import type { CameraPreset, SectionState } from '@/types/config';

export interface ViewMemory {
  camera: CameraPreset;
  section: SectionState | null;
  visibleLevels: string[] | null;
  explode: number;
  activePreset: string | null;
  /** Navigator folded away. Folding it to work, then having it pop back on
   *  every placement, is the annoyance it was folded away for. */
  collapsed: boolean;
  /** Whether that was the user's doing rather than the card's width rule. */
  collapseChosen: boolean;
  dockCollapsed: boolean;
  dockCollapseChosen: boolean;
  at: number;
}

const MEMORY = new Map<string, ViewMemory>();

/**
 * Long enough to cover a save round-trip and a remount, short enough that
 * coming back to a dashboard minutes later opens as configured.
 */
const TTL_MS = 30_000;

export function rememberView(key: string, state: Omit<ViewMemory, 'at'>): void {
  MEMORY.set(key, { ...state, at: Date.now() });
}

export function recallView(key: string): ViewMemory | null {
  const state = MEMORY.get(key);
  if (!state) return null;
  MEMORY.delete(key);
  return Date.now() - state.at <= TTL_MS ? state : null;
}
