/**
 * 016 T063 — server-side resolution of which staff nav entries a viewer may see.
 *
 * Lives here rather than in `src/config/nav.ts` because it needs `canPerform`,
 * which reads the feature flag off `env` — server-only. `staff-sidebar.tsx` is a
 * client component, so the DECISION is made here and only its result (a list of
 * plain strings) crosses the RSC boundary. The config itself cannot cross it at
 * all: every NavItem carries a `LucideIcon`, i.e. a function.
 *
 * Passing hrefs — rather than, say, an index list — keeps the payload
 * self-describing and order-independent, and href uniqueness IS asserted in
 * `tests/unit/nav/nav-permission-parity.test.ts` so re-ordering the sidebar
 * cannot silently re-point an entitlement. (That assertion was added by the 016
 * review; this comment claimed it before it existed.)
 */
import { canPerform } from '@/lib/rbac';
import { staffNavConfig, flattenNavItems } from '@/config/nav';
import type { Role } from '@/modules/auth';

/**
 * The hrefs of every staff nav entry `role` is permitted to open.
 *
 * An entry without a `guard` is always included — the member nav has none, and
 * an unguarded item behaves exactly as it did before this task. There is no
 * half-declared case to worry about: `SurfaceGuard` carries the key and the row
 * together, so the earlier fail-open (permission declared, row forgotten →
 * admitted unchecked for every role) is now unrepresentable.
 */
export function staffNavAllowedHrefs(
  role: Role,
  /**
   * Flag override, forwarded to `canPerform`. Production omits it (the flag is
   * snapshotted at module eval); tests pass it so a suite can assert BOTH legs
   * in one file without resetting the module registry.
   */
  deps?: { readonly rbacV2: boolean },
): readonly string[] {
  return flattenNavItems(staffNavConfig)
    .filter((item) => !item.guard || canPerform(role, item.guard.key, item.guard.legacy, deps))
    .map((item) => item.href);
}
