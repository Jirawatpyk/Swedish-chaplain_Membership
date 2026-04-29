/**
 * Public barrel for the `broadcasts` bounded context (F7 — Email Broadcast).
 *
 * The ONLY surface that code OUTSIDE `src/modules/broadcasts/**` may
 * import from. The ESLint barrel-guard rule (eslint.config.mjs) blocks
 * deep imports into ./domain/**, ./application/**, ./infrastructure/**
 * from outside the module.
 *
 * Empty at end of Phase 1 Setup (T009). Populated incrementally by
 * Foundational (T011–T035) and per-story tasks (T036+). The
 * `export {};` keeps this a valid ES module while no symbols are
 * exported yet — TypeScript will not error on the empty barrel.
 *
 * Constitution Principle III (NON-NEGOTIABLE): Clean Architecture
 * boundaries. Domain has no framework imports; Application talks to
 * Infrastructure only via ports. The barrel is the cross-module
 * Presentation ↔ Module boundary.
 */
export {};
