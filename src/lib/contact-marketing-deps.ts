/**
 * 108 PR-D — composition root for the contact marketing surfaces: the staff
 * toggle, the portal self-toggle, and the Marketing audience list.
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
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics } from '@/lib/metrics';
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
 * Suppression lookup over the RLS-safe broadcasts repo.
 *
 * An address that fails the `EmailLower` parse THROWS (code-review finding 1).
 * It used to be answered "not suppressed" without a query, which the caller
 * reads as permission to switch marketing back ON — so a person who had
 * unsubscribed could start receiving again. `asEmail` (members) and
 * `asEmailLower` (broadcasts) share one grammar, so no stored `contacts.email`
 * should fail here; but the multi-batch webhook path brands a Resend payload
 * WITHOUT parsing, so the suppression list can hold a value this side rejects.
 * If the branch ever fires the honest answer is "I could not check", which the
 * callers already turn into 503 `suppression_unavailable`.
 *
 * A DB failure THROWS — the port contract — so the toggle refuses to switch
 * "on" and the list surfaces degrade to "status unavailable" rather than
 * guessing. Every caller swallows that throw into its own degraded state, so
 * THIS is the layer that logs and counts it (review errors HIGH-1): six
 * `catch {}` blocks upstream would otherwise leave an outage with no trace.
 */
/**
 * Thrown when an address fails `asEmailLower` on the suppression path. Its own
 * class so `errKind` names it in the log without carrying the address.
 */
class UnparseableSuppressionAddress extends Error {
  constructor() {
    super('suppression lookup: address failed the EmailLower grammar');
    this.name = 'UnparseableSuppressionAddress';
  }
}

export function makeMarketingSuppressionLookup(
  tenant: TenantContext,
): MarketingSuppressionLookupPort {
  const repo = makeDrizzleMarketingUnsubscribesRepo(tenant.slug);
  // Code-review finding 1 — FAIL CLOSED on a value this grammar rejects.
  // The old behaviour silently DROPPED such an address from the batch, which
  // the caller then read as "not suppressed": the audience page and the member
  // badge would show `on` for someone who had unsubscribed. The branch is
  // believed unreachable (the two grammars are identical), but the multi-batch
  // webhook path brands a Resend payload WITHOUT parsing, so a suppression row
  // can hold a value this side rejects — and if that ever happens the answer
  // must be "I don't know", never "not suppressed".
  const parseAll = (emails: readonly string[]): EmailLower[] => {
    const out: EmailLower[] = [];
    for (const email of emails) {
      const parsed = asEmailLower(email.toLowerCase());
      if (!parsed.ok) throw new UnparseableSuppressionAddress();
      out.push(parsed.value);
    }
    return out;
  };
  // Class only, never the message: a Postgres error carries the SQL and its
  // bound parameters, and those parameters are addresses.
  const observed = async <T>(op: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      logger.error(
        { tenantId: tenant.slug, op, err: errKind(e) },
        'marketing.suppression_lookup_threw',
      );
      broadcastsMetrics.suppressionLookupFailed(tenant.slug, op);
      throw e;
    }
  };
  return {
    async isSuppressed(email) {
      return observed('isSuppressed', async () => {
        const parsed = asEmailLower(email.toLowerCase());
        // Inside `observed` so the throw is logged (class only) and counted
        // like any other suppression-lookup failure; the callers already map
        // it to 503 `suppression_unavailable` and refuse to switch marketing
        // ON, which is the correct answer to "I could not check".
        if (!parsed.ok) throw new UnparseableSuppressionAddress();
        const suppressed = await repo.lookupBatch(tenant.slug, [parsed.value]);
        return suppressed.has(parsed.value);
      });
    },
    async lookupSuppressed(emails) {
      const parsed = parseAll(emails);
      if (parsed.length === 0) return new Set<string>();
      return observed(
        'lookupSuppressed',
        () => repo.lookupBatch(tenant.slug, parsed) as Promise<ReadonlySet<string>>,
      );
    },
    async listSuppressedEmailLowers() {
      if (!repo.listEmailLowers) {
        throw new Error('MarketingUnsubscribesRepo.listEmailLowers is not implemented');
      }
      return observed(
        'listSuppressedEmailLowers',
        () => repo.listEmailLowers!(tenant.slug) as Promise<ReadonlySet<string>>,
      );
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
