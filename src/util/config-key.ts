/**
 * A config's identity, independent of how its keys happen to be ordered.
 *
 * The card compares configs as strings to tell an echo of its own change from a
 * real edit. Plain `JSON.stringify` makes that comparison depend on key order,
 * and the round trip through the dashboard reorders them — so every save came
 * back looking like a change and the card re-applied it for nothing.
 */
export function configKey(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
