# floorplan-3d-card

Interactive 3D floorplan card for Home Assistant. Read `ARCHITECTURE.md` first —
it defines the layer boundaries and the rules that keep this codebase coherent.

## Commands

- `npm run typecheck` — `tsc --noEmit`, must be clean before you call work done
- `npm run build` — typecheck + Vite lib build to `dist/floorplan-3d-card.js`
- `npm test` — vitest

## Conventions

- TypeScript strict, no `any` in exported signatures, no non-null `!` on
  values that can genuinely be missing.
- Import inside the package with the `@/` alias (`@/types/config`), not deep
  relative chains.
- three.js is imported as `import * as THREE from 'three'`; addons come from
  `three/examples/jsm/...` and must be tree-shakeable.
- Comments explain *why*, not *what*. No comment restates the line below it.
- Every subsystem implements its interface from `engine/contracts.ts` and has a
  real `dispose()`.
- German UI is not required — the UI ships English strings with a small
  localisation map; do not hardcode user-facing strings deep in the engine.
