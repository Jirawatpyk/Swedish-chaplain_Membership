/**
 * T062 — Drizzle processor_events repo (F5).
 *
 * Implements `ProcessorEventsRepo` (Application port). Backs the
 * webhook idempotency log (natural PK = Stripe event id).
 *
 * Tenant bypass window (data-model.md § 5.4): the pre-resolution
 * INSERT happens BEFORE `runInTenant` binds a tenant — at that
 * moment we don't yet know which tenant owns the `event.account`.
 * The dedicated RLS policy `processor_events_insert_null_tenant`
 * permits INSERT with `tenant_id IS NULL`. Every subsequent read /
 * write runs inside `runInTenant(tenantCtx, ...)` once the tenant
 * is resolved.
 *
 * `insertIfNew` uses Drizzle's `.onConflictDoNothing` against the
 * PK (id). We detect the "new vs. duplicate" decision by checking
 * the returning-row count: 1 row returned ⇒ inserted, 0 rows ⇒
 * conflict (duplicate delivery of the same event id).
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
 * Factory — no tenant context bound here. The pre-resolution path
 * goes through `db` directly (bypass RLS via the NULL-tenant INSERT
 * policy); the post-resolution path opens a `runInTenant` per call.
 *
 * `findById` auto-detects which mode to use: if the caller provides
 * `resolvedTenantId`, we open `runInTenant`; otherwise we use the
 * bypass-RLS read path (only safe for the webhook pre-resolution
 * window, where the caller is the trusted webhook entry point).
 */
export function makeDrizzleProcessorEventsRepo(): ProcessorEventsRepo {
  return {
    async insertIfNew(_txUnknown, input) {
      // Pre-resolution INSERT runs OUTSIDE runInTenant per data-model
      // § 5.4. The `_tx` argument is accepted for port-shape
      // compatibility but intentionally ignored — reusing a tenant-
      // scoped tx here would force SET LOCAL app.current_tenant
      // BEFORE we know the tenant, which is exactly the race this
      // bypass window is designed to avoid.
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

    async updateTenantId(txUnknown, input): Promise<void> {
      const tx = txUnknown as TenantTx;
      await tx
        .update(processorEvents)
        .set({ tenantId: input.tenantId })
        .where(eq(processorEvents.id, input.id));
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
 * Helper for the post-resolution path: read the row inside a
 * tenant-scoped tx once the tenant id is known. Preserved as a
 * named export so the webhook dispatcher can grab it after tenant
 * resolution without constructing a full repo for one read.
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
