/**
 * Exploded view: the storeys pulled apart along Y so you can see into all of
 * them at once, the way an assembly drawing separates the parts of a machine.
 *
 * The whole feature is one number per storey, and the work is in making sure
 * everything that lives in world space gets the *same* number. Geometry, the
 * edge lines, the room tint, the entity markers, the leader lines, the section
 * planes and the drop raycast all have to agree, or a marker floats away from
 * its room, or a cut lands in mid-air, or a dropped entity is written back to
 * the config at a height it was never at.
 *
 * Which is the other half: the offsets are a *view* transform and never reach
 * the configuration. A position in the YAML is always the real position in the
 * building. `worldToConfig` is where that boundary is enforced.
 */

import type { LevelDefinition } from '@/types/config';

/** Metres of extra separation between neighbouring storeys, per step. */
export type ExplodeGap = number;

/**
 * Y offset for every storey, keyed by level id.
 *
 * Storeys are ordered by their real elevation and lifted by whole steps, so the
 * gaps stay equal however unevenly the building's floors are actually spaced —
 * an exploded drawing is about separation, not about preserving proportion.
 */
export function explodeOffsets(
  levels: readonly LevelDefinition[],
  gap: ExplodeGap,
): Map<string, number> {
  const offsets = new Map<string, number>();
  if (!(gap > 0) || levels.length < 2) return offsets;

  const ordered = [...levels].sort((a, b) => a.elevation - b.elevation);
  for (let i = 0; i < ordered.length; i += 1) {
    if (i > 0) offsets.set(ordered[i].id, i * gap);
  }
  return offsets;
}

/** The offset of one storey; 0 for the bottom one and for anything unknown. */
export function offsetOf(offsets: ReadonlyMap<string, number> | null, level: unknown): number {
  return typeof level === 'string' ? (offsets?.get(level) ?? 0) : 0;
}
