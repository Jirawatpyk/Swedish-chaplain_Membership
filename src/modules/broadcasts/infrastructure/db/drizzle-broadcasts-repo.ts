/**
 * T063 — Drizzle `BroadcastsRepo` adapter (F7).
 *
 * Domain ↔ Drizzle mapping. Mirrors F4 `makeDrizzleInvoiceRepo` factory
 * shape with `externalTx` tenant-probe guard so cross-feature transaction
 * sharing (e.g., F4 invoice + F7 broadcast in the same atomic write —
 * not used in US1 but plumbed for future) cannot accidentally write to a
 * different tenant's namespace.
 *
 * Tenant scoping: every read/write goes through `runInTenant(ctx, fn)`
 * which sets `chamber_app` role + `app.current_tenant` for RLS.
 *
 * `findByResendBroadcastIdBypassRls` is the US5 webhook pre-tenant
 * resolver — uses the default `db` (BYPASS-RLS schema-owner connection)
 * because the route handler does not yet know which tenant owns the
 * incoming `resend_broadcast_id`.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import {
  asBroadcastId,
  type Broadcast,
  type BroadcastId,
} from '../../domain/broadcast';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import { TERMINAL_BROADCAST_STATUSES } from '../../domain/value-objects/broadcast-status';
import type { ChamberSubstitutedBody } from '../../domain/value-objects/template-snapshot';
import type {
  BroadcastsRepo,
  ListByTenantStatusOpts,
  ListByTenantStatusResult,
  NewBroadcastDraftInput,
} from '../../application/ports/broadcasts-repo';
import {
  BroadcastConcurrentMutationError,
  BroadcastNotFoundError,
} from '../../application/ports/broadcasts-repo';
import { broadcastDeliveries, broadcasts, type BroadcastRow } from '../schema';

/**
 * @internal Exported solely for unit-test access
 *   (tests/unit/broadcasts/infrastructure/delivery-aggregate-reduce.test.ts).
 *   NOT part of the broadcasts barrel — do not import from outside this file.
 *
 * Reduces SQL `GROUP BY status` rows (snake_case status enum from
 * `broadcast_deliveries`) into a camelCase shape at the Application
 * boundary. Renaming `soft_bounced` → `softBounced` here keeps SQL
 * naming inside Infrastructure (Constitution Principle III). Adding
 * a future status enum value (e.g. `queued`, `opened`) without
 * updating this function would silently drop the count, so the
 * unknown-status path MUST emit `logger.error` to surface the gap
 * (alert pipeline pages on error level, not warn).
 */
type DeliveryAggregate = {
  delivered: number;
  bounced: number;
  softBounced: number;
  complained: number;
  sent: number;
};

const DELIVERY_STATUS_TO_KEY: Record<string, keyof DeliveryAggregate> = {
  delivered: 'delivered',
  bounced: 'bounced',
  soft_bounced: 'softBounced',
  complained: 'complained',
  sent: 'sent',
};

export function reduceDeliveryAggregateRows(
  rows: ReadonlyArray<{ status: string; count: number }>,
  ctx: { readonly tenantId: string; readonly broadcastId: string },
): DeliveryAggregate {
  const out: DeliveryAggregate = {
    delivered: 0,
    bounced: 0,
    softBounced: 0,
    complained: 0,
    sent: 0,
  };
  for (const r of rows) {
    const key = DELIVERY_STATUS_TO_KEY[r.status];
    if (key !== undefined) {
      out[key] = r.count;
      continue;
    }
    // Unknown status = code/schema drift, not user data corruption.
    // Use logger.error so the alert pipeline fires (warn is below
    // the on-call threshold per docs/observability.md).
    logger.error(
      {
        tenantId: ctx.tenantId,
        broadcastId: ctx.broadcastId,
        status: r.status,
        count: r.count,
      },
      'broadcasts.delivery_aggregate.unknown_status',
    );
  }
  return out;
}

/**
 * Best-effort tenant-context probe. Reads
 * `current_setting('app.current_tenant', TRUE)` on a tx handle to
 * confirm the caller is inside a `runInTenant(ctx, …)` scope bound to
 * the expected tenant. Throws on missing/empty tenant context (caller
 * passed a bare `db` instead of a tx) OR on tenant mismatch (caller
 * borrowed a tx bound to a different tenant).
 *
 * Threat model (review ERR-L-R3-1, round 3): the probe is a
 * COOPERATIVE-bug guard, NOT a security boundary. A malicious caller
 * with raw SQL access could `SET LOCAL app.current_tenant` to spoof
 * the probe — but no untrusted code path reaches these mutation sites
 * in F7 (all callers go through the runInTenant + chamber_app role
 * binding contract from `lib/db.ts`). The probe catches accidental
 * misuse (caller passes bare `db` or wrong-tenant tx), not deliberate
 * attack.
 *
 * For defence-in-depth security, the chamber_app role + RLS+FORCE
 * policies on the underlying tables are the actual enforcement layer.
 */
async function assertTenantBoundTx(
  tx: TenantTx,
  expectedTenantId: string,
  callerName: string,
): Promise<void> {
  const probe = (await tx.execute(
    sql`SELECT current_setting('app.current_tenant', TRUE) AS current_tenant`,
  )) as unknown as Array<{ current_tenant: string | null }>;
  const currentTenant = probe[0]?.current_tenant ?? null;
  if (currentTenant === null || currentTenant.length === 0) {
    throw new Error(
      `${callerName}: tx is NOT inside a runInTenant scope (app.current_tenant is unset). Refusing to mutate without tenant binding.`,
    );
  }
  if (currentTenant !== expectedTenantId) {
    throw new Error(
      `${callerName}: tx tenant mismatch — repo bound to "${expectedTenantId}" but tx carries "${currentTenant}". Refusing to write to a different tenant's namespace.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Row → Domain mapping
// ---------------------------------------------------------------------------

/**
 * R6.1 H2 + M14 — derive the canonical `templateProvenance` DU from
 * the raw column pair on `BroadcastRow`. SINGLE writer of the field;
 * the Domain interface no longer exposes the raw columns (they live
 * on the Infrastructure-only Row type).
 *
 * Invariant: either BOTH columns are populated (snapshot path) or
 * BOTH are null (blank canvas). If EXACTLY ONE is non-null the row
 * is corrupt (out-of-band SQL / failed migration / etc); the mapper
 * still returns `null` (safer than half-truth) and emits an error log
 * so SRE has a forensic trail to find the offending row.
 *
 * Indexed-access return type `Broadcast['templateProvenance']` tracks
 * Domain drift automatically — if the Domain DU shape changes, this
 * helper surfaces the mismatch at compile time. Direct `!== null`
 * guards in the `if` block let TS flow-narrow without `as string`
 * casts.
 */
export function deriveTemplateProvenance(
  row: BroadcastRow,
): Broadcast['templateProvenance'] {
  if (
    row.startedFromTemplateId !== null &&
    row.templateNameSnapshot !== null
  ) {
    return {
      templateId: row.startedFromTemplateId,
      templateNameSnapshot: row.templateNameSnapshot,
    };
  }
  if (
    (row.startedFromTemplateId !== null) !==
    (row.templateNameSnapshot !== null)
  ) {
    logger.error(
      {
        broadcastId: row.broadcastId,
        tenantId: row.tenantId,
        hasStartedFromTemplateId: row.startedFromTemplateId !== null,
        hasTemplateNameSnapshot: row.templateNameSnapshot !== null,
      },
      'broadcasts.mapper.template_provenance_half_populated',
    );
  }
  return null;
}

/**
 * @internal — exported solely for the R8.5 end-to-end mapper test
 * (`tests/unit/broadcasts/infrastructure/drizzle-broadcasts-repo-mapper.test.ts`).
 * Production callers SHOULD invoke the repo's `findById` / other port
 * methods which wrap this with `runInTenant`. Importing `rowToBroadcast`
 * directly from outside this file bypasses the Drizzle adapter's
 * tenant-bound tx + Domain port boundary.
 */
export function rowToBroadcast(row: BroadcastRow): Broadcast {
  return {
    tenantId: row.tenantId,
    broadcastId: asBroadcastId(row.broadcastId),

    requestedByMemberId: row.requestedByMemberId,
    requestedByMemberPlanIdSnapshot: row.requestedByMemberPlanIdSnapshot,
    submittedByUserId: row.submittedByUserId,
    actorRole: row.actorRole,

    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodySource: row.bodySource,
    fromName: row.fromName,
    replyToEmail: row.replyToEmail,

    segmentType: row.segmentType,
    segmentParams: (row.segmentParams as Record<string, unknown> | null) ?? null,
    customRecipientEmails: row.customRecipientEmails ?? null,
    estimatedRecipientCount: row.estimatedRecipientCount,

    status: row.status,
    submittedAt: row.submittedAt,
    approvedAt: row.approvedAt,
    approvedByUserId: row.approvedByUserId,
    rejectedAt: row.rejectedAt,
    rejectedByUserId: row.rejectedByUserId,
    rejectionReason: row.rejectionReason,
    scheduledFor: row.scheduledFor,
    sendingStartedAt: row.sendingStartedAt,
    sentAt: row.sentAt,
    cancelledAt: row.cancelledAt,
    cancelledByUserId: row.cancelledByUserId,
    cancellationReason: row.cancellationReason,
    failedToDispatchAt: row.failedToDispatchAt,
    failureReason: row.failureReason,

    quotaYearConsumed: row.quotaYearConsumed,
    quotaConsumedAt: row.quotaConsumedAt,

    resendAudienceId: row.resendAudienceId,
    resendBroadcastId: row.resendBroadcastId,

    retentionYears: row.retentionYears as 5 | 10,

    // F7.1a US1 + US7 columns (Phase 2 0162 + 3 B0 Domain type extension).
    // DB defaults: manual_retry_count=0; the 4 nullable fields default
    // to NULL on existing F7 MVP rows (ADD COLUMN was non-destructive).
    manualRetryCount: row.manualRetryCount,
    partialDeliveryAcceptedAt: row.partialDeliveryAcceptedAt,
    partialDeliveryAcceptedByUserId: row.partialDeliveryAcceptedByUserId,
    templateProvenance: deriveTemplateProvenance(row),

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Cursor format: base64 of `submittedAt-iso|broadcast-id`
function encodeCursor(submittedAt: Date | null, broadcastId: string): string {
  const iso = submittedAt === null ? '' : submittedAt.toISOString();
  return Buffer.from(`${iso}|${broadcastId}`, 'utf8').toString('base64url');
}

function decodeCursor(
  cursor: string,
): { submittedAt: Date | null; broadcastId: string } | null {
  // Review ERR-H4: log decode failures (length-only, never the cursor
  // bytes — they may carry tenant ids in clear text). Returning null
  // keeps the existing "tampered cursor → reset to first page"
  // behavior; the log makes deliberate tampering distinguishable from
  // a genuine race against pagination state.
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, broadcastId] = decoded.split('|');
    if (broadcastId === undefined) {
      logger.warn(
        { cursorLen: cursor.length },
        'broadcasts.repo.cursor_decode_missing_broadcast_id',
      );
      return null;
    }
    return {
      submittedAt: iso === '' || iso === undefined ? null : new Date(iso),
      broadcastId,
    };
  } catch (e) {
    logger.warn(
      {
        cursorLen: cursor.length,
        err: e instanceof Error ? e.constructor.name : 'unknown',
      },
      'broadcasts.repo.cursor_decode_threw',
    );
    return null;
  }
}

/**
 * Shared two-bucket member-quota count, run on a caller-supplied tx. Reserved
 * = `submitted` ∪ `approved`; consumed (`sent`) = `sent` ∪
 * `partial_delivery_accepted`, year-fenced on `quota_year_consumed` (Design D1
 * / FR-008c). Extracted (code-review) so `countForMemberQuota` (own runInTenant)
 * and `recheckMemberQuotaUnderLock` (bug #4 under-lock recheck) read via ONE
 * definition — a future bucket-set change (as the D1 amendment already made
 * once) can't drift the pre-tx check from the TOCTOU recheck.
 */
async function countMemberQuotaBucketsOnTx(
  tx: TenantTx,
  tenantIdArg: TenantSlug,
  memberId: string,
  quotaYear: number,
): Promise<{ readonly submittedOrApproved: number; readonly sent: number }> {
  const [submittedOrApprovedRows, sentRows] = await Promise.all([
    tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.tenantId, tenantIdArg),
          eq(broadcasts.requestedByMemberId, memberId),
          sql`${broadcasts.status}::text IN ('submitted', 'approved')`,
        ),
      ),
    tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(broadcasts)
      .where(
        and(
          eq(broadcasts.tenantId, tenantIdArg),
          eq(broadcasts.requestedByMemberId, memberId),
          inArray(broadcasts.status, ['sent', 'partial_delivery_accepted']),
          eq(broadcasts.quotaYearConsumed, quotaYear),
        ),
      ),
  ]);
  return {
    submittedOrApproved: submittedOrApprovedRows[0]?.count ?? 0,
    sent: sentRows[0]?.count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeDrizzleBroadcastsRepo(
  tenantId: string,
  externalTx?: unknown,
): BroadcastsRepo {
  const ctx = asTenantContext(tenantId);

  return {
    async withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      if (externalTx !== undefined) {
        // tx-reuse path — verify caller's tx tenant matches our binding
        // before running the callback. Same defence-in-depth guard as F4.
        const externalTxTyped = externalTx as TenantTx;
        const probe = (await externalTxTyped.execute(
          sql`SELECT current_setting('app.current_tenant', TRUE) AS current_tenant`,
        )) as unknown as Array<{ current_tenant: string | null }>;
        const current_tenant = probe[0]?.current_tenant ?? null;
        if (current_tenant !== ctx.slug) {
          throw new Error(
            `makeDrizzleBroadcastsRepo: externalTx tenant mismatch — repo bound to "${ctx.slug}" but tx carries "${current_tenant ?? '(unset)'}". Refusing to write to a different tenant's namespace.`,
          );
        }
        return fn(externalTx);
      }
      return runInTenant(ctx, async (tx) => fn(tx));
    },

    async insertDraft(
      txUnknown,
      input: NewBroadcastDraftInput,
    ): Promise<Broadcast> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .insert(broadcasts)
        .values({
          tenantId: input.tenantId,
          broadcastId: input.broadcastId,
          requestedByMemberId: input.requestedByMemberId,
          requestedByMemberPlanIdSnapshot:
            input.requestedByMemberPlanIdSnapshot,
          submittedByUserId: input.submittedByUserId,
          actorRole: input.actorRole,
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          bodySource: input.bodySource,
          fromName: input.fromName,
          replyToEmail: input.replyToEmail,
          segmentType: input.segmentType,
          segmentParams: input.segmentParams,
          customRecipientEmails:
            input.customRecipientEmails === null
              ? null
              : [...input.customRecipientEmails],
          estimatedRecipientCount: input.estimatedRecipientCount,
          scheduledFor: input.scheduledFor,
          status: 'draft',
        })
        .returning();
      if (!row) throw new Error('insertDraft: no row returned');
      return rowToBroadcast(row as BroadcastRow);
    },

    async updateDraft(
      txUnknown,
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
      patch: Partial<NewBroadcastDraftInput>,
    ): Promise<Broadcast> {
      const tx = txUnknown as TenantTx;
      const setClause: Record<string, unknown> = {
        updatedAt: new Date(),
      };
      if (patch.subject !== undefined) setClause['subject'] = patch.subject;
      if (patch.bodyHtml !== undefined) setClause['bodyHtml'] = patch.bodyHtml;
      if (patch.bodySource !== undefined)
        setClause['bodySource'] = patch.bodySource;
      if (patch.fromName !== undefined) setClause['fromName'] = patch.fromName;
      if (patch.replyToEmail !== undefined)
        setClause['replyToEmail'] = patch.replyToEmail;
      if (patch.segmentType !== undefined)
        setClause['segmentType'] = patch.segmentType;
      if (patch.segmentParams !== undefined)
        setClause['segmentParams'] = patch.segmentParams;
      if (patch.customRecipientEmails !== undefined)
        setClause['customRecipientEmails'] =
          patch.customRecipientEmails === null
            ? null
            : [...patch.customRecipientEmails];
      if (patch.estimatedRecipientCount !== undefined)
        setClause['estimatedRecipientCount'] = patch.estimatedRecipientCount;
      if (patch.scheduledFor !== undefined)
        setClause['scheduledFor'] = patch.scheduledFor;

      const updated = await tx
        .update(broadcasts)
        .set(setClause)
        .where(
          and(
            eq(broadcasts.tenantId, tenantIdArg),
            eq(broadcasts.broadcastId, broadcastId),
            eq(broadcasts.status, 'draft'),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) {
        // Either row doesn't exist OR status is no longer 'draft'.
        // Re-read to distinguish (mirrors F4 conflict pattern). Caller
        // likely already validated existence; surfacing concurrent
        // mutation is the more useful signal.
        const probe = await tx
          .select({ status: broadcasts.status })
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, tenantIdArg),
              eq(broadcasts.broadcastId, broadcastId),
            ),
          )
          .limit(1);
        const probeRow = probe[0];
        if (probeRow !== undefined) {
          throw new BroadcastConcurrentMutationError(
            tenantIdArg,
            broadcastId,
            probeRow.status,
          );
        }
        throw new Error(
          `updateDraft: broadcast ${broadcastId} not found in tenant ${tenantIdArg}`,
        );
      }
      return rowToBroadcast(row as BroadcastRow);
    },

    async updateDraftFromTemplate(
      txUnknown,
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
      snapshot: {
        // R3.3 H-3 — brand flows end-to-end. The adapter accepts
        // ChamberSubstitutedBody (Domain VO output) to match the port
        // contract; Drizzle's `text` column type structurally accepts
        // the brand (it's a string subtype) so no runtime cast needed
        // at the .set() call.
        readonly subject: ChamberSubstitutedBody;
        readonly bodyHtml: ChamberSubstitutedBody;
        readonly bodySource: ChamberSubstitutedBody;
        readonly startedFromTemplateId: string;
        readonly templateNameSnapshot: string;
      },
    ): Promise<Broadcast> {
      // Narrow UPDATE for template snapshot: subject + body_html +
      // body_source + started_from_template_id + template_name_snapshot.
      // Refuses unless status='draft' so the immutable-after-submit
      // invariant (Q3) holds for template-based mutations too. R1.2
      // H-code-1: assertTenantBoundTx as defence-in-depth so a future
      // cross-port-tx-sharing bug (e.g. snapshot use-case passing a tx
      // bound to tenant A while this repo is constructed for tenant B)
      // fails loudly instead of silently writing into the wrong slice.
      // Mirrors attachResendIds/attachAudienceId/pruneExpiredDrafts.
      const tx = txUnknown as TenantTx;
      await assertTenantBoundTx(tx, ctx.slug, 'updateDraftFromTemplate');
      const updated = await tx
        .update(broadcasts)
        .set({
          subject: snapshot.subject,
          bodyHtml: snapshot.bodyHtml,
          bodySource: snapshot.bodySource,
          startedFromTemplateId: snapshot.startedFromTemplateId,
          templateNameSnapshot: snapshot.templateNameSnapshot,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(broadcasts.tenantId, tenantIdArg),
            eq(broadcasts.broadcastId, broadcastId),
            eq(broadcasts.status, 'draft'),
          ),
        )
        .returning();
      const row = updated[0];
      if (!row) {
        const probe = await tx
          .select({ status: broadcasts.status })
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, tenantIdArg),
              eq(broadcasts.broadcastId, broadcastId),
            ),
          )
          .limit(1);
        const probeRow = probe[0];
        if (probeRow !== undefined) {
          throw new BroadcastConcurrentMutationError(
            tenantIdArg,
            broadcastId,
            probeRow.status,
          );
        }
        // R3.3 H-6 — typed error so the snapshot use-case catch can
        // narrow (vs bare Error → generic 500). Should never fire
        // post-ownership-check (Constitution I clause 2 invariant
        // violation if it does — log severity stays loud at caller).
        throw new BroadcastNotFoundError(tenantIdArg, broadcastId);
      }
      return rowToBroadcast(row as BroadcastRow);
    },

    async findById(
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
    ): Promise<Broadcast | null> {
      return runInTenant(ctx, async (tx) => {
        const [row] = await tx
          .select()
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, tenantIdArg),
              eq(broadcasts.broadcastId, broadcastId),
            ),
          )
          .limit(1);
        return row === undefined
          ? null
          : rowToBroadcast(row as BroadcastRow);
      });
    },

    async findByIdInTx(
      txUnknown,
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
    ): Promise<Broadcast | null> {
      const tx = txUnknown as TenantTx;
      const [row] = await tx
        .select()
        .from(broadcasts)
        .where(
          and(
            eq(broadcasts.tenantId, tenantIdArg),
            eq(broadcasts.broadcastId, broadcastId),
          ),
        )
        .limit(1);
      return row === undefined ? null : rowToBroadcast(row as BroadcastRow);
    },

    async lockForUpdate(
      txUnknown,
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
    ): Promise<BroadcastStatus | null> {
      const tx = txUnknown as TenantTx;
      // Review C2: per-(tenant, broadcast) advisory lock auto-released
      // at tx-end. Closes the TOCTOU window between cron dispatch and
      // manual admin send-now/approve/reject so a single broadcast can
      // never be dispatched twice through different code paths.
      // Namespace `broadcasts:` is disjoint from F4 `invoicing:` and F5
      // `payments:` so cross-feature contention is impossible.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('broadcasts:' || ${tenantIdArg} || ':' || ${broadcastId as string}, 0))`,
      );
      const result = (await tx.execute(
        sql`SELECT status::text AS status FROM broadcasts
             WHERE tenant_id = ${tenantIdArg}
               AND broadcast_id = ${broadcastId}
             FOR UPDATE`,
      )) as unknown as Array<{ status: BroadcastStatus }>;
      const row = result[0];
      return row === undefined ? null : row.status;
    },

    async applyTransition(
      txUnknown,
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
      target: BroadcastStatus,
      fields: Partial<Broadcast>,
      expectedFromStatus: BroadcastStatus,
    ): Promise<Broadcast> {
      const tx = txUnknown as TenantTx;
      const setClause: Record<string, unknown> = {
        status: target,
        updatedAt: new Date(),
      };
      // Whitelist mutable lifecycle fields the caller may pass through.
      const passthrough: ReadonlyArray<keyof Broadcast> = [
        'submittedAt',
        'approvedAt',
        'approvedByUserId',
        'rejectedAt',
        'rejectedByUserId',
        'rejectionReason',
        'scheduledFor',
        'sendingStartedAt',
        'sentAt',
        'cancelledAt',
        'cancelledByUserId',
        'cancellationReason',
        'failedToDispatchAt',
        'failureReason',
        'quotaYearConsumed',
        'quotaConsumedAt',
        'estimatedRecipientCount',
      ];
      for (const key of passthrough) {
        if (fields[key] !== undefined) {
          setClause[key] = fields[key];
        }
      }

      // Verify-fix R4 (Types-#5, 2026-05-02): expectedFromStatus is
      // now REQUIRED. UPDATE adds `AND status = $expected` to its
      // WHERE clause. Returning 0 rows means the row drifted (TOCTOU)
      // OR doesn't exist; either way → BroadcastConcurrentMutationError
      // (caller maps to broadcast_concurrent_action_blocked / 409).
      const [row] = await tx
        .update(broadcasts)
        .set(setClause)
        .where(
          and(
            eq(broadcasts.tenantId, tenantIdArg),
            eq(broadcasts.broadcastId, broadcastId),
            eq(broadcasts.status, expectedFromStatus),
          ),
        )
        .returning();
      if (!row) {
        throw new BroadcastConcurrentMutationError(
          tenantIdArg,
          broadcastId,
          expectedFromStatus,
        );
      }
      return rowToBroadcast(row as BroadcastRow);
    },

    async attachResendIds(
      txUnknown,
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
      resendAudienceId: string,
      resendBroadcastId: string,
    ): Promise<void> {
      const tx = txUnknown as TenantTx;
      // Review ERR-H1 (round 2): probe `current_tenant` BEFORE issuing
      // the UPDATE so a caller passing a bare `db` handle (no tx
      // binding, no RLS context) is rejected up-front rather than
      // committing a wrong-rowcount mutation that the rowcount throw
      // below cannot roll back.
      await assertTenantBoundTx(tx, ctx.slug, 'attachResendIds');
      // Review ERR-M4: assert exactly one row was updated. A 0-row
      // update would leave the Resend resource orphaned (sent without
      // a local id linkage) — fail loud so the dispatcher rolls back
      // and the operator sees the broken broadcast id.
      const updated = await tx
        .update(broadcasts)
        .set({
          resendAudienceId,
          resendBroadcastId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(broadcasts.tenantId, tenantIdArg),
            eq(broadcasts.broadcastId, broadcastId),
          ),
        )
        .returning({ broadcastId: broadcasts.broadcastId });
      if (updated.length !== 1) {
        throw new Error(
          `attachResendIds: expected 1 row updated for broadcast ${broadcastId} (tenant ${tenantIdArg}) but updated ${updated.length}`,
        );
      }
    },

    async attachAudienceId(
      txUnknown,
      tenantIdArg: TenantSlug,
      broadcastId: BroadcastId,
      resendAudienceId: string,
    ): Promise<void> {
      const tx = txUnknown as TenantTx;
      // Review ERR-H1 (round 2) + ERR-M4: probe tx binding then assert
      // rowcount.
      await assertTenantBoundTx(tx, ctx.slug, 'attachAudienceId');
      const updated = await tx
        .update(broadcasts)
        .set({
          resendAudienceId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(broadcasts.tenantId, tenantIdArg),
            eq(broadcasts.broadcastId, broadcastId),
          ),
        )
        .returning({ broadcastId: broadcasts.broadcastId });
      if (updated.length !== 1) {
        throw new Error(
          `attachAudienceId: expected 1 row updated for broadcast ${broadcastId} (tenant ${tenantIdArg}) but updated ${updated.length}`,
        );
      }
    },

    async listByTenantStatus(
      tenantIdArg: TenantSlug,
      opts: ListByTenantStatusOpts,
    ): Promise<ListByTenantStatusResult> {
      return runInTenant(ctx, async (tx) => {
        const conditions = [eq(broadcasts.tenantId, tenantIdArg)];
        if (opts.statusFilter !== undefined && opts.statusFilter.length > 0) {
          conditions.push(
            sql`${broadcasts.status}::text = ANY(ARRAY[${sql.join(
              opts.statusFilter.map((s) => sql`${s}`),
              sql`, `,
            )}]::text[])`,
          );
        }
        if (opts.memberIdFilter !== undefined) {
          conditions.push(
            eq(broadcasts.requestedByMemberId, opts.memberIdFilter),
          );
        }

        const sort = opts.sort ?? 'created_at_desc';
        const cursor =
          opts.cursor !== undefined ? decodeCursor(opts.cursor) : null;

        if (cursor !== null) {
          if (sort === 'submitted_at_asc') {
            conditions.push(
              sql`(${broadcasts.submittedAt}, ${broadcasts.broadcastId}) > (${cursor.submittedAt}, ${cursor.broadcastId})`,
            );
          } else {
            conditions.push(
              sql`(${broadcasts.submittedAt}, ${broadcasts.broadcastId}) < (${cursor.submittedAt}, ${cursor.broadcastId})`,
            );
          }
        }

        const orderBy =
          sort === 'submitted_at_asc'
            ? [asc(broadcasts.submittedAt), asc(broadcasts.broadcastId)]
            : sort === 'submitted_at_desc'
              ? [desc(broadcasts.submittedAt), desc(broadcasts.broadcastId)]
              : [desc(broadcasts.createdAt), desc(broadcasts.broadcastId)];

        const limit = Math.max(1, Math.min(opts.pageSize, 100));
        const rows = await tx
          .select()
          .from(broadcasts)
          .where(and(...conditions))
          .orderBy(...orderBy)
          .limit(limit + 1);

        const hasNext = rows.length > limit;
        const trimmed = hasNext ? rows.slice(0, limit) : rows;
        const last = trimmed[trimmed.length - 1];
        const nextCursor =
          hasNext && last !== undefined
            ? encodeCursor(last.submittedAt, last.broadcastId)
            : null;

        return {
          rows: trimmed.map((r) => rowToBroadcast(r as BroadcastRow)),
          nextCursor,
        };
      });
    },

    async countForMemberQuota(
      tenantIdArg: TenantSlug,
      memberId: string,
      quotaYear: number,
    ): Promise<{
      // Design D1 (2026-06-21): this counts exactly TWO statuses —
      // submitted + approved (the only states that hold a reservation).
      // failed_to_dispatch is terminal and RELEASES the slot, so it is
      // excluded. The field name is kept as-is because callers depend
      // on it.
      readonly submittedOrApproved: number;
      // Consumed-quota bucket: `sent` ∪ `partial_delivery_accepted`,
      // year-fenced on `quota_year_consumed` (FR-008c). Both terminal
      // states stamp the quota year (schema CHECK
      // `broadcasts_quota_year_only_on_sent`). Field name kept as `sent`
      // for caller stability even though it now covers two states.
      readonly sent: number;
    }> {
      // Two-bucket count shared with recheckMemberQuotaUnderLock — see
      // countMemberQuotaBucketsOnTx for the Design D1 / FR-008c bucket rules.
      return runInTenant(ctx, (tx) =>
        countMemberQuotaBucketsOnTx(tx, tenantIdArg, memberId, quotaYear),
      );
    },

    async recheckMemberQuotaUnderLock(
      txUnknown,
      tenantIdArg: TenantSlug,
      memberId: string,
      quotaYear: number,
    ): Promise<{
      readonly submittedOrApproved: number;
      readonly sent: number;
    }> {
      const tx = txUnknown as TenantTx;
      // Bug #4 fix (2026-07-10): serialise concurrent submits per
      // (tenant, member, quota-year). The advisory xact lock is held until
      // the caller's tx ends, so a second concurrent submit blocks here
      // until the first commits (reserving its slot); it then re-reads the
      // fresh counts below and is correctly quota-blocked. Namespace
      // `broadcasts-quota:` is DISJOINT from the per-broadcast `broadcasts:`
      // lock (lockForUpdate) and from F4 `invoicing:` / F5 `payments:`.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('broadcasts-quota:' || ${tenantIdArg} || ':' || ${memberId} || ':' || ${quotaYear}::text, 0))`,
      );
      // Same two-bucket count as countForMemberQuota — shared definition so the
      // pre-tx check and this under-lock recheck can never diverge.
      return countMemberQuotaBucketsOnTx(tx, tenantIdArg, memberId, quotaYear);
    },

    async findByResendBroadcastIdBypassRls(
      resendBroadcastId: string,
    ): Promise<
      { readonly tenantId: TenantSlug; readonly broadcast: Broadcast } | null
    > {
      // Webhook pre-tenant resolution path (FR-024 / T160). Reads via
      // the default `db` connection — the schema owner has BYPASSRLS
      // and is the only role that can locate the row before
      // `app.current_tenant` is bound. The route handler MUST re-enter
      // `runInTenant(ctx, ...)` for every downstream write so RLS+FORCE
      // applies to the rest of the transaction (Constitution Principle I
      // clause 1). Best-effort lookup: returns `null` for unknown ids.
      const [row] = await db
        .select()
        .from(broadcasts)
        .where(eq(broadcasts.resendBroadcastId, resendBroadcastId))
        .limit(1);
      if (row === undefined) return null;
      // Brand the row's tenant_id back to `TenantSlug` at the
      // bypass-RLS adapter boundary. The DB column is `text` so
      // it lacks the brand; the regex guard inside `asTenantContext`
      // is the source of truth for slug validity — but we don't need
      // a full ctx here, just the brand. Cast is safe because the
      // row is sourced from a tenant-isolated insert path (the only
      // writes to `broadcasts.tenant_id` go through `runInTenant`).
      return {
        tenantId: row.tenantId as TenantSlug,
        broadcast: rowToBroadcast(row as BroadcastRow),
      };
    },

    async listForMemberPaginated(
      tenantIdArg: TenantSlug,
      memberId: string,
      opts: { readonly page: number; readonly perPage: number },
    ): Promise<{
      readonly rows: ReadonlyArray<Broadcast>;
      readonly total: number;
      readonly totalPages: number;
      readonly page: number;
    }> {
      const perPage = Math.max(1, Math.min(opts.perPage, 100));
      return runInTenant(ctx, async (tx) => {
        const baseWhere = and(
          eq(broadcasts.tenantId, tenantIdArg),
          eq(broadcasts.requestedByMemberId, memberId),
        );

        const totalRows = await tx
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(broadcasts)
          .where(baseWhere);
        const total = totalRows[0]?.count ?? 0;

        if (total === 0) {
          return {
            rows: [],
            total: 0,
            totalPages: 0,
            page: 1,
          };
        }

        const totalPages = Math.ceil(total / perPage);
        const clampedPage = Math.max(1, Math.min(opts.page, totalPages));
        const offset = (clampedPage - 1) * perPage;

        const rows = await tx
          .select()
          .from(broadcasts)
          .where(baseWhere)
          .orderBy(desc(broadcasts.createdAt), desc(broadcasts.broadcastId))
          .limit(perPage)
          .offset(offset);

        return {
          rows: rows.map((r) => rowToBroadcast(r as BroadcastRow)),
          total,
          totalPages,
          page: clampedPage,
        };
      });
    },

    async findOwnedByMember(tenantIdArg, memberId, broadcastId) {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, tenantIdArg),
              eq(broadcasts.broadcastId, broadcastId),
            ),
          )
          .limit(1);

        const row = rows[0];
        if (row === undefined) {
          return { broadcast: null, probeKind: 'not_found' as const };
        }
        if (row.requestedByMemberId !== memberId) {
          return { broadcast: null, probeKind: 'cross_member' as const };
        }
        return {
          broadcast: rowToBroadcast(row as BroadcastRow),
          probeKind: 'owned' as const,
        };
      });
    },

    async aggregateDeliveryCountsForBroadcast(tenantIdArg, broadcastId) {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({
            status: broadcastDeliveries.status,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(broadcastDeliveries)
          .where(
            and(
              eq(broadcastDeliveries.tenantId, tenantIdArg),
              eq(broadcastDeliveries.broadcastId, broadcastId),
            ),
          )
          .groupBy(broadcastDeliveries.status);

        return reduceDeliveryAggregateRows(rows, {
          tenantId: tenantIdArg,
          broadcastId: broadcastId as string,
        });
      });
    },

    /**
     * F7 US6 / Phase 8 — T171a draft-expiry prune (FR-001a).
     *
     * Deletes `broadcasts WHERE tenant_id = $1 AND status = 'draft' AND
     * updated_at < $2 RETURNING broadcast_id`. Wrapped in
     * `assertTenantBoundTx` for defence-in-depth (Constitution Principle
     * I clause 1+2 — `app.current_tenant` GUC matches `tenantIdArg` even
     * though SQL `WHERE tenant_id = $1` already enforces isolation).
     *
     * NO audit emission per FR-001a (drafts are user scratch space).
     * Returns the deleted row count for cron observability + test
     * assertions; the cron route logs this as `prunedCount` in the
     * tick-complete summary.
     */
    async pruneExpiredDrafts(tenantIdArg, olderThan) {
      return runInTenant(ctx, async (tx) => {
        await assertTenantBoundTx(tx, ctx.slug, 'pruneExpiredDrafts');
        // Bind cutoff as ISO string + cast to TIMESTAMPTZ — the Neon
        // serverless driver does not auto-serialize JS Date objects in
        // sql template params (throws "The 'string' argument must be of
        // type string"). All other Date binds in this repo already
        // pre-format via `toISOString()`.
        const deleted = (await tx.execute(sql`
          DELETE FROM broadcasts
          WHERE tenant_id = ${tenantIdArg}
            AND status = 'draft'
            AND updated_at < ${olderThan.toISOString()}::timestamptz
          RETURNING broadcast_id
        `)) as unknown as Array<{ broadcast_id: string }>;
        return { prunedCount: deleted.length };
      });
    },

    /**
     * F7 Phase 9 / T178a — list in-flight broadcasts owned by a member.
     * Used by the F3 archival/erasure cascade. Status filter narrow:
     * only `submitted` + `approved` are cancellable per FR-004a / Q10
     * (the cancellation cutoff is at Resend dispatch).
     */
    async listInFlightOwnedByMember(tenantIdArg, memberId) {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select()
          .from(broadcasts)
          .where(
            and(
              eq(broadcasts.tenantId, tenantIdArg),
              eq(broadcasts.requestedByMemberId, memberId),
              sql`${broadcasts.status}::text IN ('submitted', 'approved')`,
            ),
          )
          .orderBy(desc(broadcasts.createdAt), desc(broadcasts.broadcastId));
        return rows.map((r) => rowToBroadcast(r as BroadcastRow));
      });
    },

    /**
     * COMP-1 US2b — GDPR Art.17 / PDPA §33 broadcast content redaction.
     * Runs inside the caller's erasure tx (threaded `txUnknown` from
     * `runInTenant`). One UPDATE redacts EVERY broadcast the member
     * authored (all statuses, including `draft`): subject/body_html/
     * body_source/from_name/reply_to_email → `[redacted]`,
     * rejection_reason/cancellation_reason/failure_reason → NULL (nullable
     * free-text that can echo the member's PII — the reason notes from a
     * manual reject/cancel, and failure_reason from a raw gateway error that
     * can quote the author's reply_to_email/from_name), and
     * custom_recipient_emails → `['[redacted]']` on `custom` rows (the
     * `broadcasts_custom_recipient_cap` CHECK, migration 0064, forbids a
     * 0-element / NULL array on a `custom` row, so a plain `= NULL` would
     * RAISE 23514) / NULL on non-custom rows.
     *
     * `SET LOCAL app.allow_broadcast_redaction = 'on'` opts into the
     * `broadcasts_immutable_after_submit_fn` GUC arm (migration 0224) so
     * post-`draft` rows accept the PII change; the trigger early-returns
     * for `draft` rows, so the single UPDATE covers drafts too. No `status`
     * filter — the GUC arm + early-return handle every status.
     *
     * CHANGED-ROWS COUNT (2026-06-19 /code-review #4): the WHERE adds
     * `subject <> '[redacted]'` so an ALREADY-scrubbed row is excluded and
     * `scrubbedCount` reflects rows CHANGED, not rows MATCHED. This makes a
     * re-drive (US2d reconciler / manual re-run) of an already-scrubbed
     * member return `scrubbedCount = 0`, so the use-case's zero-work guard
     * fires and no DUPLICATE `broadcast_content_redacted` audit is emitted.
     * Still idempotent (a re-drive is a no-op), but now the count proves it.
     *
     * FAIL-LOUD: any DB error (e.g. an unexpected non-PII column drift
     * RAISE) propagates and rolls the caller's tx back — never swallowed.
     */
    async scrubContentForMemberInTx(txUnknown, tenantIdArg, memberId) {
      const tx = txUnknown as TenantTx;
      // Defence-in-depth: this method uniquely RE-ENABLES mutation of
      // post-submit-immutable PII columns via the GUC, so a fail-fast
      // tenant-binding assert (mirrors the sibling write methods) is most
      // valuable here — refuse to redact against an unbound / wrong-tenant tx.
      await assertTenantBoundTx(tx, ctx.slug, 'scrubContentForMemberInTx');
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      const rows = (await tx.execute(sql`
        UPDATE broadcasts SET
          subject = '[redacted]',
          body_html = '[redacted]',
          body_source = '[redacted]',
          from_name = '[redacted]',
          reply_to_email = '[redacted]',
          -- rejection_reason + cancellation_reason are nullable free-text
          -- columns persisted VERBATIM from the admin/user note (reject-
          -- broadcast.ts / cancel-broadcast.ts). On a member-originated
          -- broadcast the note can quote the member (e.g. "rejected —
          -- contains erik@acme.com"), so NULL them to complete Art.17 /
          -- PDPA §33 erasure.
          rejection_reason = NULL,
          cancellation_reason = NULL,
          -- failure_reason is set from the raw gateway error message
          -- (dispatch-scheduled-broadcast.ts: shape.reason ?? e.message),
          -- which can echo the broadcast's reply_to_email / from_name — the
          -- author's OWN PII, the same address the scrub redacts above on
          -- this row. NULL it too so no copy survives (2026-06-19
          -- /code-review #8). The migration-0224 GUC arm whitelists this
          -- column so the change is permitted on a post-draft row.
          failure_reason = NULL,
          custom_recipient_emails = CASE
            WHEN segment_type = 'custom' THEN ARRAY['[redacted]']::text[]
            ELSE NULL
          END
        WHERE tenant_id = ${tenantIdArg}
          AND requested_by_member_id = ${memberId}
          -- ZERO-WORK GUARD (2026-06-19 /code-review #4): count only rows we
          -- actually CHANGE. subject is the canonical redaction marker (it is
          -- NEVER legitimately '[redacted]' on a live broadcast — it is a
          -- NOT NULL, content-validated column), so an already-scrubbed row
          -- is excluded here and the RETURNING set reflects rows CHANGED, not
          -- rows MATCHED. Without this filter a US2d-reconciler re-drive of an
          -- already-scrubbed member re-matched every row (scrubbedCount >= 1),
          -- so the use-case zero-work guard never fired and a DUPLICATE
          -- broadcast_content_redacted audit was emitted on every re-drive.
          AND subject <> '[redacted]'
        RETURNING broadcast_id
      `)) as unknown as Array<{ broadcast_id: string }>;
      return { scrubbedCount: rows.length };
    },

    /**
     * COMP-1 US2b — GDPR Art.17 / PDPA §33 delivery tombstone. Runs inside
     * the caller's erasure tx. Sets `recipient_member_id` → NULL and
     * `recipient_email_lower` → `erased+<delivery_id>@erased.invalid` for
     * every `broadcast_deliveries` row whose `recipient_email_lower` is one
     * of the erased member's email addresses (`recipientEmails`). Rows are
     * RETAINED (never deleted) for record-of-processing (PDPA §39 / GDPR
     * Art.30).
     *
     * KEYED ON EMAIL, NOT recipient_member_id (the 2026-06-18 /code-review
     * fix). `recipient_member_id` is NEVER populated in production — the only
     * inserter is the Resend webhook, which hard-codes it to NULL at both
     * insert sites (process-webhook-event.ts:173,221); no resolver/backfill
     * exists, and drizzle-at-risk-scorer.ts already abandoned that axis as
     * unreliable. A `recipient_member_id = $member` tombstone therefore
     * matched 0 rows in prod (a silent no-op), so the erased member's
     * plaintext `recipient_email_lower` (+ the email embedded in
     * `error_message`) survived forever while erasure reported COMPLETE.
     * Deliveries are correlated to members by `recipient_email_lower`
     * everywhere else (the sole recipient lookup index
     * `broadcast_deliveries_recipient_lookup_idx (tenant_id,
     * recipient_email_lower)`); the caller passes the member's LIVE-contact
     * emails ONLY. Deliveries are only ever addressed to contact emails, so the
     * linked-login axis adds zero coverage AND a cross-member over-tombstone
     * risk — do NOT re-add it (the US2a cross-member over-scrub lesson). Live-
     * contact only because a removed contact's address is ambiguously owned (it
     * may now belong to a different member), so tombstoning by it could scrub a
     * peer's delivery.
     *
     * Emails are lower-cased here before matching: `recipient_email_lower` is
     * always lower-cased by the webhook, but a contact email is case-PRESERVED
     * in storage (the unique index is on `lower(email)`), so a `Mixed.Case@…`
     * contact would otherwise never match its own lower-stored delivery row
     * (PII survival).
     *
     * Empty `recipientEmails` → short-circuit `{ tombstonedCount: 0 }` WITHOUT
     * running the UPDATE: no email can match, and skipping the `= ANY('{}')`
     * predicate is clearer and avoids any edge-case surprise. A re-drive is a
     * clean no-op by construction — the sentinel `recipient_email_lower`
     * (`erased+…@erased.invalid`) is never in a member's real email set, so a
     * second pass over the same set matches 0 rows.
     *
     * `SET LOCAL app.allow_broadcast_redaction = 'on'` opts into the
     * UPDATE-only GUC arm on `broadcast_deliveries_append_only_fn`
     * (migration 0225) — a plain UPDATE inside `runInTenant`/`chamber_app`,
     * NO `ALTER TABLE … DISABLE TRIGGER` (chamber_app is not the table
     * owner). The GUC arm permits ONLY these three recipient-PII columns to
     * change: `recipient_member_id` + `recipient_email_lower` +
     * `error_message` (the last holds raw Resend bounce diagnostics that can
     * embed the recipient email, so it must be NULLable under the GUC too —
     * this method writes all three). A change to any OTHER column would RAISE
     * `broadcast_deliveries_redaction_only_pii_cols`.
     *
     * FAIL-LOUD: any DB error propagates and rolls the caller's tx back.
     */
    async tombstoneDeliveriesForMemberInTx(txUnknown, tenantIdArg, recipientEmails) {
      // Short-circuit: no addresses → no rows can match. Skip the UPDATE.
      if (recipientEmails.length === 0) return { tombstonedCount: 0 };
      const tx = txUnknown as TenantTx;
      // Defence-in-depth: this method uniquely RE-ENABLES mutation of an
      // append-only table via the GUC, so a fail-fast tenant-binding assert
      // (mirrors the sibling write methods) is most valuable here — refuse
      // to tombstone against an unbound / wrong-tenant tx.
      await assertTenantBoundTx(tx, ctx.slug, 'tombstoneDeliveriesForMemberInTx');
      // Lower-case every address so a case-preserved contact email matches the
      // always-lower-cased recipient_email_lower. De-dupe for a tidy ANY array.
      const lowered = [
        ...new Set(recipientEmails.map((e) => e.toLowerCase())),
      ];
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      const rows = (await tx.execute(sql`
        UPDATE broadcast_deliveries
        SET recipient_member_id = NULL,
            recipient_email_lower =
              'erased+' || delivery_id || '@erased.invalid',
            -- error_message holds raw Resend bounce diagnostics that can
            -- embed the recipient email (e.g. SMTP 550 5.1.1 <addr> ...);
            -- NULL it so the erased member email does not survive as
            -- plaintext (GDPR Art.17 / PDPA 33). The 0225 GUC arm permits
            -- this column to change under app.allow_broadcast_redaction.
            error_message = NULL
        WHERE tenant_id = ${tenantIdArg}
          AND recipient_email_lower = ANY(ARRAY[${sql.join(
            lowered.map((e) => sql`${e}`),
            sql`, `,
          )}]::text[])
        RETURNING delivery_id
      `)) as unknown as Array<{ delivery_id: string }>;
      return { tombstonedCount: rows.length };
    },

    /**
     * COMP-1 FIX-9 — GDPR Art.17 / PDPA §33 cross-author custom-recipient
     * redaction. The AUTHOR scrub (`scrubContentForMemberInTx`) keys on
     * `requested_by_member_id`, so it only redacts the rows the erased member
     * AUTHORED — it never reaches the erased member's email sitting in a
     * DIFFERENT (sibling) author's `custom_recipient_emails` text[]
     * (segment_type='custom'), leaving the erased subject's plaintext PII
     * surviving on a peer's row (the SAME bug-class as the delivery-tombstone
     * fix: the canonical erasure axis for recipient PII in F7 is EMAIL, not
     * author id).
     *
     * This method ELEMENT-WISE redacts the erased member's email out of EVERY
     * author's custom rows tenant-wide, keyed on EMAIL (case-insensitive),
     * preserving the sibling author's OTHER legitimate recipients. Runs inside
     * the caller's atomic erasure tx (FAIL-LOUD).
     *
     * IMPLEMENTATION NOTES:
     *   - unnest(...) WITH ORDINALITY + array_agg(... ORDER BY ord) rebuilds
     *     the array element-by-element (NOT array_replace, which is
     *     case-SENSITIVE) and PRESERVES element order.
     *   - the per-element CASE lowers BOTH sides (`lower(elem) = ANY(lowered)`)
     *     so a case-PRESERVED stored element matches the lower-cased erasure
     *     key (else PII survives, mirroring the delivery tombstone).
     *   - the EXISTS guard scopes the UPDATE to rows that ACTUALLY contain a
     *     matching element, so `redactedCount` reflects rows CHANGED — a
     *     re-drive over an already-redacted set matches 0 rows (idempotent,
     *     no duplicate audit churn).
     *   - ELEMENT-WISE (not whole-array) preserves the sibling author's OTHER
     *     recipients; the author-scrub legitimately whole-array-replaces the
     *     member's OWN rows (there the whole audience is subject-adjacent).
     *     The member's OWN custom rows are ALSO element-wise redacted here
     *     harmlessly; the POST-COMMIT author-scrub subsequently
     *     whole-array-replaces them — order-independent, non-conflicting (the
     *     author-scrub's zero-work guard keys on `subject <> '[redacted]'`,
     *     independent of the custom array).
     *   - the 0224 GUC arm whitelists `custom_recipient_emails` to change on
     *     post-draft rows under `app.allow_broadcast_redaction = 'on'`; the
     *     `broadcasts_custom_recipient_cap` CHECK (length 1..100, non-null on
     *     custom) is structurally satisfied — array_agg over a non-empty source
     *     preserves length and never NULLs.
     *
     * Empty `recipientEmails` → short-circuit `{ redactedCount: 0 }` WITHOUT
     * running the UPDATE. FAIL-LOUD: any DB error propagates and rolls the
     * caller's tx back.
     */
    async redactMemberEmailFromCustomRecipientsInTx(
      txUnknown,
      tenantIdArg,
      recipientEmails,
    ) {
      // Short-circuit: no addresses → no element can match. Skip the UPDATE.
      if (recipientEmails.length === 0) return { redactedCount: 0 };
      const tx = txUnknown as TenantTx;
      // Defence-in-depth: this method RE-ENABLES mutation of a post-submit
      // immutable PII column via the GUC, so a fail-fast tenant-binding assert
      // (mirrors the sibling write methods) refuses an unbound / wrong-tenant tx.
      await assertTenantBoundTx(
        tx,
        ctx.slug,
        'redactMemberEmailFromCustomRecipientsInTx',
      );
      // Lower-case + de-dupe so a case-preserved stored element matches its
      // lower-cased erasure key, and the ANY array is tidy.
      const lowered = [
        ...new Set(recipientEmails.map((e) => e.toLowerCase())),
      ];
      await tx.execute(sql`SET LOCAL app.allow_broadcast_redaction = 'on'`);
      const rows = (await tx.execute(sql`
        UPDATE broadcasts b SET custom_recipient_emails = sub.arr
        FROM (
          SELECT b2.broadcast_id,
                 array_agg(
                   CASE
                     WHEN lower(elem) = ANY(ARRAY[${sql.join(
                       lowered.map((e) => sql`${e}`),
                       sql`, `,
                     )}]::text[]) THEN '[redacted]'
                     ELSE elem
                   END
                   ORDER BY ord
                 ) AS arr
          FROM broadcasts b2,
               LATERAL unnest(b2.custom_recipient_emails)
                 WITH ORDINALITY AS u(elem, ord)
          WHERE b2.tenant_id = ${tenantIdArg}
            AND b2.segment_type = 'custom'
            AND EXISTS (
              SELECT 1
              FROM unnest(b2.custom_recipient_emails) e2
              WHERE lower(e2) = ANY(ARRAY[${sql.join(
                lowered.map((e) => sql`${e}`),
                sql`, `,
              )}]::text[])
            )
          GROUP BY b2.broadcast_id
        ) sub
        WHERE b.tenant_id = ${tenantIdArg}
          AND b.broadcast_id = sub.broadcast_id
        RETURNING b.broadcast_id
      `)) as unknown as Array<{ broadcast_id: string }>;
      return { redactedCount: rows.length };
    },

    /**
     * COMP-1 US3-C — GDPR Art.17 / PDPA §33 sub-processor (Resend) audience
     * derivation. Reads inside the caller's erasure tx the
     * `(resend_audience_id, recipient_email_lower)` pairs the erased member
     * received broadcasts in, so a later cascade can remove the member's email
     * from those Resend AUDIENCES.
     *
     * MUST run BEFORE `tombstoneDeliveriesForMemberInTx` in the same atomic
     * scrub tx — the tombstone redacts `recipient_email_lower` (and
     * `recipient_member_id` is always NULL in production), destroying the join
     * keys. Correlating the delivery to its broadcast by `broadcast_id` lets us
     * read the broadcast's `resend_audience_id`; only audience-bearing
     * broadcasts (`resend_audience_id IS NOT NULL`) are returned.
     *
     * Parity with the sibling in-tx reads/writes: `assertTenantBoundTx` as
     * defence-in-depth (this read joins two tenant-scoped tables; a wrong-tenant
     * tx would silently derive the WRONG audience set), the `lowered`
     * (lower-case + de-dupe) email set, and the `= ANY(ARRAY[...]::text[])`
     * binding form (NOT a raw JS array through the Neon serverless driver,
     * which throws the "argument must be of type string" class). The `SELECT
     * DISTINCT` collapses many deliveries into the same audience to one pair.
     *
     * Empty email set → short-circuit `[]` (no email can match; skip the `=
     * ANY('{}')` predicate entirely). This is a READ — it mutates nothing — so
     * NO `SET LOCAL app.allow_broadcast_redaction` GUC is needed.
     */
    async listMemberResendAudienceContactsInTx(txUnknown, tenantIdArg, emails) {
      const lowered = [...new Set(emails.map((e) => e.toLowerCase()))];
      if (lowered.length === 0) return [];
      const tx = txUnknown as TenantTx;
      await assertTenantBoundTx(
        tx,
        ctx.slug,
        'listMemberResendAudienceContactsInTx',
      );
      const rows = (await tx.execute(sql`
        SELECT DISTINCT b.resend_audience_id AS audience_id,
                        d.recipient_email_lower AS email
        FROM broadcast_deliveries d
        JOIN broadcasts b
          ON b.tenant_id = d.tenant_id
         AND b.broadcast_id = d.broadcast_id
        WHERE d.tenant_id = ${tenantIdArg}
          AND d.recipient_email_lower = ANY(ARRAY[${sql.join(
            lowered.map((e) => sql`${e}`),
            sql`, `,
          )}]::text[])
          AND b.resend_audience_id IS NOT NULL
      `)) as unknown as Array<{ audience_id: string; email: string }>;
      return rows.map((r) => ({ audienceId: r.audience_id, email: r.email }));
    },

    /**
     * PR-2 Task 2 — list terminal broadcasts whose Resend audience is still
     * live (not yet cleaned up by the cron).
     *
     * Runs its own `runInTenant` call (this is a read-only method with no
     * in-flight caller tx). The query is tenant-scoped by both the
     * `WHERE tenant_id = $1` clause and the RLS+FORCE policy.
     *
     * Terminal statuses: sent, failed_to_dispatch, cancelled, rejected,
     * partial_delivery_accepted. Ordered `updated_at ASC` so the cron
     * processes oldest-terminal-first (nearest any per-broadcast SLA).
     * LIMIT keeps each cron tick's batch small and predictable.
     */
    async listTerminalBroadcastsWithLiveAudience(tenantIdArg, graceCutoff, limit) {
      return runInTenant(ctx, async (tx) => {
        // Finding G — derive the IN-list from the domain's single source of
        // truth (`TERMINAL_BROADCAST_STATUSES`) so a future state-machine
        // change cannot silently desync this SQL from `isTerminalStatus`.
        const terminalStatusList = sql.join(
          TERMINAL_BROADCAST_STATUSES.map((s) => sql`${s}`),
          sql`, `,
        );
        const rows = (await tx.execute(sql`
          SELECT broadcast_id, resend_audience_id
          FROM broadcasts
          WHERE tenant_id = ${tenantIdArg}
            AND status::text IN (${terminalStatusList})
            AND resend_audience_id IS NOT NULL
            AND audience_deleted_at IS NULL
            AND updated_at < ${graceCutoff.toISOString()}::timestamptz
          ORDER BY updated_at ASC
          LIMIT ${limit}
        `)) as unknown as Array<{
          broadcast_id: string;
          resend_audience_id: string;
        }>;
        return rows.map((r) => ({
          broadcastId: r.broadcast_id,
          resendAudienceId: r.resend_audience_id,
        }));
      });
    },

    /**
     * PR-2 Task 2 — stamp `audience_deleted_at = now()` on a single
     * broadcast row, inside the caller's `runInTenant` tx.
     *
     * Idempotent: if the row already has `audience_deleted_at` set, the
     * UPDATE changes it to `now()` again (harmless — the important bit
     * is that `audience_deleted_at IS NOT NULL`, not the exact timestamp).
     * The WHERE clause is intentionally permissive on `audience_deleted_at`
     * so a re-drive after a partial cron failure does not silently skip.
     */
    async markAudienceDeletedInTx(txUnknown, broadcastId) {
      const tx = txUnknown as TenantTx;
      await assertTenantBoundTx(tx, ctx.slug, 'markAudienceDeletedInTx');
      await tx.execute(sql`
        UPDATE broadcasts
           SET audience_deleted_at = now()
         WHERE tenant_id = ${ctx.slug}
           AND broadcast_id = ${broadcastId}::uuid
      `);
    },

    /**
     * PR-2 Task 2 — return the subset of `broadcastIds` that still have a
     * `broadcasts` row for this tenant. Used by the orphan-reclaim use-case
     * to distinguish live broadcasts (skip) from purged ones (reclaim).
     *
     * Array-param form: mirrors `tombstoneDeliveriesForMemberInTx` and
     * `listMemberResendAudienceContactsInTx` — `= ANY(ARRAY[...]::uuid[])`
     * with each element inserted as a separate `sql` parameter. The explicit
     * `::uuid[]` cast lets Postgres validate each element and surface a
     * 22P02 error on a malformed UUID rather than silently skipping it.
     *
     * A raw JS array through the Neon serverless driver throws "The
     * 'string' argument must be of type string" (error 22P02) when the
     * driver tries to serialise the array type — this repo already uses the
     * `sql.join(ids.map(...), sql`, `)` form throughout; we follow suit for
     * internal consistency (see `tombstoneDeliveriesForMemberInTx` above for
     * the canonical prior example).
     *
     * Runs its own `runInTenant` (read-only; no caller-supplied tx needed).
     * Tenant-scoped by both `WHERE tenant_id = $1` and RLS+FORCE on
     * `broadcasts` (Constitution Principle I).
     */
    async existingBroadcastIds(tenantIdArg, broadcastIds) {
      // Short-circuit: nothing to look up — avoid an empty ANY() query.
      if (broadcastIds.length === 0) return new Set<BroadcastId>();
      return runInTenant(ctx, async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT broadcast_id
          FROM broadcasts
          WHERE tenant_id = ${tenantIdArg}
            AND broadcast_id = ANY(ARRAY[${sql.join(
              broadcastIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}])
        `)) as unknown as Array<{ broadcast_id: string }>;
        return new Set(rows.map((r) => asBroadcastId(r.broadcast_id)));
      });
    },

    async referencedAudienceIdsForBroadcasts(tenantIdArg, broadcastIds) {
      // Bug #16 — for each LIVE broadcast row, the SET of every Resend audience
      // id it references: broadcasts.resend_audience_id (MVP single-audience)
      // UNION every broadcast_batch_manifests.provider_audience_id (F7.1a US1
      // split). Absent ids (row gone) are not keyed. Including the per-batch
      // audiences is load-bearing: on the split path broadcasts.resend_audience_id
      // stays NULL, so without the manifests join a live split broadcast's
      // in-use batch audiences would be misclassified as orphans and deleted.
      if (broadcastIds.length === 0) {
        return new Map<BroadcastId, ReadonlySet<string>>();
      }
      const idArray = sql.join(
        broadcastIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      return runInTenant(ctx, async (tx) => {
        const rows = (await tx.execute(sql`
          SELECT b.broadcast_id AS broadcast_id,
                 b.resend_audience_id AS row_audience_id,
                 m.provider_audience_id AS batch_audience_id
          FROM broadcasts b
          LEFT JOIN broadcast_batch_manifests m
            ON m.tenant_id = b.tenant_id
           AND m.broadcast_id = b.broadcast_id
          WHERE b.tenant_id = ${tenantIdArg}
            AND b.broadcast_id = ANY(ARRAY[${idArray}])
        `)) as unknown as Array<{
          broadcast_id: string;
          row_audience_id: string | null;
          batch_audience_id: string | null;
        }>;
        const map = new Map<BroadcastId, Set<string>>();
        for (const r of rows) {
          const key = asBroadcastId(r.broadcast_id);
          // Every live row that appears gets an entry (empty set if it
          // references no audience yet) — the LEFT JOIN guarantees at least
          // one row per existing broadcast even with zero manifests.
          const set = map.get(key) ?? new Set<string>();
          if (r.row_audience_id !== null) set.add(r.row_audience_id);
          if (r.batch_audience_id !== null) set.add(r.batch_audience_id);
          map.set(key, set);
        }
        return map;
      });
    },
  };
}
