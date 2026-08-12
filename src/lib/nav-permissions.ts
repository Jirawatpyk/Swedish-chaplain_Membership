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
 * self-describing and order-independent: hrefs are unique across the staff
 * config (asserted in `tests/unit/nav/nav-permission-parity.test.ts`), so
 * re-ordering the sidebar cannot silently re-point an entitlement.
 */
import { canPerform } from '@/lib/rbac';
import { staffNavConfig, flattenNavItems } from '@/config/nav';
import type { Role } from '@/modules/auth';

/**
 * The hrefs of every staff nav entry `role` is permitted to open.
 *
 * An entry without a `requiredPermission` is always included — the filter only
 * consults this set for entries that declare one, so an unpermissioned item
 * behaves exactly as it did before this task.
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
    .filter(
      (item) =>
        !item.requiredPermission ||
        !item.legacyRow ||
        canPerform(role, item.requiredPermission, item.legacyRow, deps),
    )
    .map((item) => item.href);
}
