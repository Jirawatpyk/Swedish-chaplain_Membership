/**
 * A permission requirement stated as ONE value: the key, plus the legacy row
 * that reproduces the flag-OFF population for it.
 *
 * These two always travel together — `canPerform(role, key, legacyRow)` needs
 * both, and a key without a row cannot be evaluated. Carrying them as two
 * independent optional fields let one exist without the other, and the code
 * downstream resolved that in the UNSAFE direction: `staffNavAllowedHrefs`
 * short-circuited a permissioned nav item with no row straight into the
 * allow-list, visible to every role including `marketing`. Four independent
 * reviewers found that same fail-open.
 *
 * The pair is deliberately NOT a per-key lookup table. `legacy-shim.ts` records
 * that rows are selected PER CALL SITE, never per key — `invoicing.read`
 * legitimately appears with `legacySessionOnly` on `/admin/invoices` and with
 * `legacyAdminOrManager` on `/admin/credit-notes`, because those two pages
 * admitted different populations before 016.
 *
 * PR 5 deletes the legacy leg, at which point this collapses to the key alone
 * and `defineGuard` becomes the natural place to make that edit once.
 */
import type { LegacyRow } from './legacy-shim';
import type { PermissionKey } from './permission-catalogue';

export interface SurfaceGuard {
  readonly key: PermissionKey;
  /** The flag-OFF row for {@link key} — the SAME value the target surface passes. */
  readonly legacy: LegacyRow;
}

/**
 * Mint a guard. A function rather than an object literal so the pair is
 * constructed in one expression and cannot be spread apart at the call site.
 */
export function defineGuard(key: PermissionKey, legacy: LegacyRow): SurfaceGuard {
  return { key, legacy };
}
