/**
 * A permission requirement stated as ONE value.
 *
 * Until PR 5 this carried a PAIR — the key plus the legacy-shim row that
 * reproduced the flag-OFF population — because `canPerform` needed both and a
 * key without a row was a fail-open four independent reviewers found. The
 * legacy leg is gone (T068), so the guard collapses to the key alone, exactly
 * as this file's own header predicted, and `defineGuard` was the single place
 * that edit happened.
 *
 * The wrapper type survives the collapse deliberately: `NavItem.guard` and the
 * parity tests speak `SurfaceGuard`, and "the permission the TARGET PAGE
 * requires" is still a distinct concept from a bare `PermissionKey` used in a
 * render decision — the parity suite reads one from nav config and one from
 * the page's `requirePagePermission(...)` call and asserts they agree.
 */
import type { PermissionKey } from './permission-catalogue';

export interface SurfaceGuard {
  readonly key: PermissionKey;
}

/** Mint a guard. */
export function defineGuard(key: PermissionKey): SurfaceGuard {
  return { key };
}
