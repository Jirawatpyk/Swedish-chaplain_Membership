/**
 * F119 T066 — who "marketing" means as a hand-off recipient (FR-021a;
 * contracts/dashboard-and-notifications.md § 3.1, research R15).
 *
 * Composed here, in `src/lib`, because it crosses modules through barrels:
 * the auth roles + the cross-tenant active-user read (`listActiveUsersByRole`)
 * adapted to the broadcasts `MarketingDirectoryPort`. The F114 reviewer
 * directory (`members-change-request-deps.ts`) is the precedent.
 *
 * The role sets are asked of the permission EVALUATOR (`canPerform`, the
 * composition-layer alias of `hasPermission`) — never a role literal and never
 * the bundle table: super-admin keys come from the evaluator's early return,
 * so the bundle gives the wrong answer, and a literal would silently stop
 * matching the day a bundle changes. Today:
 *   marketingRoles() → the marketing role
 *   fallbackRoles()  → admin, super_admin and marketing (every
 *                      `broadcasts.write` holder), used when no marketing user
 *                      is ACTIVE — FR-021a's "the tenant's admins instead".
 *
 * Locale: `users` has no locale column, so every staff copy renders in the
 * platform default (the F114 finding).
 */
import { defaultLocale } from '@/i18n/config';
import { broadcastsMetrics } from '@/lib/metrics';
import { canPerform } from '@/lib/rbac';
import { ROLES, listActiveUsersByRole, type Role } from '@/modules/auth';
import type { MarketingDirectoryPort, MarketingRecipient } from '@/modules/broadcasts';

/**
 * The admin tiers the contract subtracts (§ 3.1). Not `ADMINISTRATIVE_ROLES`,
 * which is super_admin alone (the RBAC-administration tier).
 */
const ADMIN_TIERS: readonly Role[] = ['admin', 'super_admin'];

/** Every role the evaluator grants `broadcasts.write` — the fallback roster. */
export function fallbackRoles(): readonly Role[] {
  return ROLES.filter((role) => canPerform(role, 'broadcasts.write'));
}

/** The `broadcasts.write` holders outside the admin tiers — "marketing". */
export function marketingRoles(): readonly Role[] {
  return fallbackRoles().filter((role) => !ADMIN_TIERS.includes(role));
}

/**
 * The hand-off roster with no side effect: the ACTIVE marketing users, else
 * the ACTIVE fallback users. The dispatcher arms re-check a recipient against
 * this at send time; only `listRecipients` counts an empty roster.
 */
export async function resolveMarketingRoster(): Promise<readonly MarketingRecipient[]> {
  const primary = marketingRoles();
  const marketing = primary.length > 0 ? await listActiveUsersByRole(primary) : [];
  const rows = marketing.length > 0 ? marketing : await listActiveUsersByRole(fallbackRoles());
  return rows.map((r) => ({ userId: r.id, email: r.email, locale: defaultLocale }));
}

/** `MarketingDirectoryPort` for one tenant — the tenant labels the empty-roster counter. */
export function makeMarketingDirectory(tenantId: string): MarketingDirectoryPort {
  return {
    async listRecipients() {
      const roster = await resolveMarketingRoster();
      if (roster.length === 0) broadcastsMetrics.noMarketingRecipient(tenantId);
      return roster;
    },
  };
}
