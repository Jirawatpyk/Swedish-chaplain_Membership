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
  drizzleMemberRepo,
  f3DrizzleAuditAdapter,
  type ListMarketingAudienceDeps,
  type MarketingSuppressionLookupPort,
  type SetContactMarketingOptOutDeps,
} from '@/modules/members';
import {
  asEmailLower,
  makeDrizzleMarketingUnsubscribesRepo,
  type EmailLower,
} from '@/modules/broadcasts';

/**
 * Suppression lookup over the RLS-safe broadcasts repo. An address that fails
 * the `EmailLower` parse cannot be on the list (the list only holds parsed
 * values) → not suppressed. A DB failure THROWS — the port contract — so the
 * toggle refuses to switch "on" and the list surfaces degrade to "status
 * unavailable" rather than guessing.
 */
export function makeMarketingSuppressionLookup(
  tenant: TenantContext,
): MarketingSuppressionLookupPort {
  const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.slug);
  const parseAll = (emails: readonly string[]): EmailLower[] => {
    const out: EmailLower[] = [];
    for (const email of emails) {
      const parsed = asEmailLower(email.toLowerCase());
      if (parsed.ok) out.push(parsed.value);
    }
    return out;
  };
  return {
    async isSuppressed(email) {
      const parsed = asEmailLower(email.toLowerCase());
      if (!parsed.ok) return false;
      const suppressed = await repo.lookupBatch(tenant.slug, [parsed.value]);
      return suppressed.has(parsed.value);
    },
    async lookupSuppressed(emails) {
      const parsed = parseAll(emails);
      if (parsed.length === 0) return new Set<string>();
      return repo.lookupBatch(tenant.slug, parsed) as Promise<ReadonlySet<string>>;
    },
    async listSuppressedEmailLowers() {
      if (!repo.listEmailLowers) {
        throw new Error('MarketingUnsubscribesRepo.listEmailLowers is not implemented');
      }
      return repo.listEmailLowers(tenant.slug) as Promise<ReadonlySet<string>>;
    },
  };
}

export function buildMarketingAudienceDeps(tenant: TenantContext): ListMarketingAudienceDeps {
  return {
    tenant,
    memberRepo: drizzleMemberRepo,
    marketingSuppression: makeMarketingSuppressionLookup(tenant),
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
