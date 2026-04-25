/**
 * T062 — Drizzle processor_events repo (F5).
 *
 * Implements `ProcessorEventsRepo` (Application port). Backs the
 * webhook idempotency log (natural PK = Stripe event id).
 *
 * NULL tenant_id semantics (audit 2026-04-25 reality check —
 * data-model.md § 5.4):
 *   The original "pre-resolution NULL → UPDATE to resolve" design
 *   is unimplementable under PostgreSQL RLS (SELECT-policy applied
 *   as visibility filter blocks NULL rows from being UPDATE-able by
 *   chamber_app). Production REVISED behaviour:
 *     - successful events INSERT with the resolved tenant_id from the
 *       start (route resolves via `resolveTenantByProcessorAccountId`
 *       BEFORE entering the use-case);
 *     - NULL-tenant rows ONLY appear via `insertRejectedProcessorEvent`
 *       for rejection-audit (env mismatch / api-version mismatch /
 *       unknown-account `acknowledged_only`);
 *     - rejection rows are system-level audit and are never promoted —
 *       they remain invisible to all chamber_app contexts and are
 *       inspected out-of-band by the `neondb_owner` operator role.
 *
 * `insertIfNew` runs OUTSIDE `runInTenant` because the rejection
 * write must succeed even when no tenant context is available; the
 * INSERT policy's `WITH CHECK (tenant_id IS NULL OR ...)` permits the
 * NULL row. We detect the "new vs. duplicate" decision by checking the
 * returning-row count: 1 row returned ⇒ inserted, 0 rows ⇒ conflict
 * (duplicate delivery). Note: `.returning()` on a NULL-tenant INSERT
 * triggers SELECT-policy evaluation which blocks the row → returning
 * array is empty even on successful INSERT. The fallback `db.select()`
 * (line 93) handles both real conflicts AND this NULL-tenant returning
 * blank case (also bypass-RLS, so it sees the just-inserted row).
 *
 * Domain-type leak containment: Drizzle row types stay here; the
 * caller sees `ProcessorEvent` Domain shapes only.
 */
import { eq, sql } from 'drizzle-orm';
import type { ProcessorEventsRepo } from '../../application/ports/processor-events-repo';
import type {
  ProcessorEvent,
  ProcessorEventOutcome,
} from '../../domain/processor-event';
import { processorEvents, type ProcessorEventRow } from '../schema';
import { db, runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

function toDomain(row: ProcessorEventRow): ProcessorEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    eventType: row.eventType,
    apiVersion: row.apiVersion,
    livemode: row.livemode,
    processorAccountId: row.processorAccountId,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    outcome: row.outcome as ProcessorEventOutcome,
    payloadSha256: row.payloadSha256,
    correlationId: row.correlationId,
  };
}

/**
 * Factory — no tenant context bound here. INSERT path uses raw `db`
 * to support both:
 *   (a) the rejection-audit path with `tenantId: null` (which fails
 *       SELECT policy under chamber_app — must run outside runInTenant);
 *   (b) the resolved-tenant INSERT (route has already resolved tenantId
 *       from `processor_account_id` before calling this — runs as the
 *       owner role + ON CONFLICT DO NOTHING handles dedup).
 *
 * Read paths use `db` directly because processor_events is a system-
 * wide idempotency log — per-tenant filtering happens upstream via the
 * resolved tenantId in `processWebhookEvent` rather than at the repo
 * boundary.
 */
export function makeDrizzleProcessorEventsRepo(): ProcessorEventsRepo {
  return {
    async insertIfNew(_txUnknown, input) {
      // Audit 2026-04-25 finding #5: `_txUnknown` is intentionally
      // ignored — see file-level docstring for why insertIfNew runs
      // outside runInTenant. The arg stays in the port shape for
      // signature consistency with `markProcessed`/`updateOutcome`
      // (which DO use a tx). Callers that pass a non-null tx will
      // have the value silently dropped — documented contract.
      const inserted = await db
        .insert(processorEvents)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          eventType: input.eventType,
          apiVersion: input.apiVersion,
          livemode: input.livemode,
          processorAccountId: input.processorAccountId,
          outcome: input.outcome,
          payloadSha256: input.payloadSha256,
          correlationId: input.correlationId,
          receivedAt: input.receivedAt,
        })
        .onConflictDoNothing({ target: processorEvents.id })
        .returning();

      if (inserted.length > 0) {
        return {
          inserted: true,
          event: toDomain(inserted[0] as ProcessorEventRow),
        };
      }

      // Duplicate — look up the existing row to return its snapshot.
      const [existing] = await db
        .select()
        .from(processorEvents)
        .where(eq(processorEvents.id, input.id))
        .limit(1);
      if (!existing) {
        throw new Error(
          `drizzle-processor-events-repo: insertIfNew saw conflict but row ${input.id} not found`,
        );
      }
      return {
        inserted: false,
        event: toDomain(existing as ProcessorEventRow),
      };
    },

    async markProcessed(txUnknown, id): Promise<void> {
      const tx = txUnknown as TenantTx;
      await tx
        .update(processorEvents)
        .set({ processedAt: sql`now()` })
        .where(eq(processorEvents.id, id));
    },

    async updateOutcome(txUnknown, input): Promise<void> {
      const tx = txUnknown as TenantTx;
      await tx
        .update(processorEvents)
        .set({ outcome: input.outcome })
        .where(eq(processorEvents.id, input.id));
    },

    async findById(id: string): Promise<ProcessorEvent | null> {
      // Bypass-path read: event resolution reads MAY precede tenant
      // resolution. The webhook handler calls this before it has a
      // tenant context (to detect replayed events). Safe because
      // processor_events is a system-wide idempotency log owned by
      // the webhook-handler role; per-tenant reads happen via the
      // separate tenant-scoped RLS policy applied inside
      // `runInTenant` for post-resolution flows.
      const [row] = await db
        .select()
        .from(processorEvents)
        .where(eq(processorEvents.id, id))
        .limit(1);
      return row ? toDomain(row as ProcessorEventRow) : null;
    },
  };
}

/**
 * Helper for the post-resolution path: read the row inside a tenant-
 * scoped tx once the tenant id is known. Useful for the webhook
 * dispatcher's idempotency probe AFTER tenant resolution.
 *
 * Audit 2026-04-25 finding #7: kept as a named helper alongside
 * `ProcessorEventsRepo.findById` (which uses bypass-RLS for the
 * pre-resolution path). The two surfaces serve different RLS
 * contexts — consolidating into one method would force callers to
 * juggle a `tenantId | null` arg that the bypass-RLS path can't use.
 */
export async function findProcessorEventInTenant(
  tenantId: string,
  id: string,
): Promise<ProcessorEvent | null> {
  const ctx = asTenantContext(tenantId);
  return runInTenant(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(processorEvents)
      .where(eq(processorEvents.id, id))
      .limit(1);
    return row ? toDomain(row as ProcessorEventRow) : null;
  });
}
