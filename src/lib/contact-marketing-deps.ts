/**
 * 108 PR-D — composition root for the contact marketing toggle.
 *
 * Wires `setContactMarketingOptOut` (members Application) to its
 * Infrastructure: the Drizzle contact repo + F3 audit adapter from the
 * members barrel, and — the reason this file exists — an adapter over the
 * broadcasts-owned suppression list (`marketing_unsubscribes`) for the
 * `MarketingSuppressionLookupPort`.
 *
 * **Why here and not in `members-deps.ts`** (plan § Complexity Tracking #3):
 * broadcasts already imports the members barrel (`members-bridge.ts`), so a
 * members-side import of the broadcasts barrel would close a barrel cycle
 * (the 066 class that breaks tsx scripts and client bundles). `src/lib/**` is
 * the sanctioned composition layer (Principle III, precedent
 * `events-csv-import-deps.ts`). Duplicating the suppression READ inside
 * members was rejected: two readers of one GDPR record drift.
 *
 * Routes import from here; Application code never reaches into `src/lib`.
 */
import type { TenantContext } from '@/modules/tenants';
import {
  drizzleContactRepo,
  f3DrizzleAuditAdapter,
  type MarketingSuppressionLookupPort,
  type SetContactMarketingOptOutDeps,
} from '@/modules/members';
import { asEmailLower, makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts';

/**
 * Suppression lookup over the RLS-safe broadcasts repo. An address that fails
 * the `EmailLower` parse cannot be on the list (the list only holds parsed
 * values) → `false`. A DB failure THROWS — the port contract — so the use
 * case refuses to switch "on" rather than guessing.
 */
export function makeMarketingSuppressionLookup(
  tenant: TenantContext,
): MarketingSuppressionLookupPort {
  const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.slug);
  return {
    async isSuppressed(email) {
      const parsed = asEmailLower(email.toLowerCase());
      if (!parsed.ok) return false;
      const suppressed = await repo.lookupBatch(tenant.slug, [parsed.value]);
      return suppressed.has(parsed.value);
    },
  };
}

export function buildContactMarketingDeps(tenant: TenantContext): SetContactMarketingOptOutDeps {
  return {
    tenant,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    marketingSuppression: makeMarketingSuppressionLookup(tenant),
  };
}
