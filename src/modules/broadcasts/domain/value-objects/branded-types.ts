/**
 * Shared Domain branded types for the broadcasts bounded context.
 *
 * F7.1b B1 closure 2026-05-21 — extracted Round 7 of staff-review pass.
 *
 * Previously `Hostname` lived in
 * `src/modules/broadcasts/application/ports/image-allowlist-port.ts`
 * (Phase 2) as a workaround for the Phase 2 ↔ Phase 4 ordering
 * constraint (the Application port had to declare it BEFORE the Phase 4
 * Domain VO was authored). That reverse Domain→Application import was
 * tracked as Plan.md Complexity Tracking entry #5.
 *
 * This file is the new canonical home — Domain owns its own brands,
 * Application imports FROM Domain. The Application port preserves a
 * back-compat re-export so existing consumer imports keep working
 * during the migration window.
 *
 * Brands declared here MUST be:
 *   - pure type-level (no runtime impact)
 *   - free of framework imports (Constitution III)
 *   - single-source-of-truth (no duplicate brand declarations)
 *
 * Validators (`asHostname`, etc.) live alongside their semantic VO —
 * NOT in this file. Branded primitives only.
 */

/**
 * Hostname Domain branded type. RFC-1035 lowercase ASCII, ≥1 dot, no
 * wildcards. Validation lives in `asHostname` Domain VO at
 * `image-source-allowlist.ts`. Migration 0164's CHECK constraint
 * provides DB-layer enforcement.
 */
export type Hostname = string & { readonly __brand: 'Hostname' };
