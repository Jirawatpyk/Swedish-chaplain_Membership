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
 * `findByResendBroadcastIdBypassRls` is a US4 webhook concern; stub
 * throws here.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  asBroadcastId,
  type Broadcast,
  type BroadcastId,
} from '../../domain/broadcast';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import type {
  BroadcastsRepo,
  ListByTenantStatusOpts,
  ListByTenantStatusResult,
  NewBroadcastDraftInput,
} from '../../application/ports/broadcasts-repo';
import {
  BroadcastConcurrentMutationError,
} from '../../application/ports/broadcasts-repo';
import { broadcasts, type BroadcastRow } from '../schema';
import { runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

// ---------------------------------------------------------------------------
// Row → Domain mapping
// ---------------------------------------------------------------------------

function rowToBroadcast(row: BroadcastRow): Broadcast {
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
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, broadcastId] = decoded.split('|');
    if (broadcastId === undefined) return null;
    return {
      submittedAt: iso === '' || iso === undefined ? null : new Date(iso),
      broadcastId,
    };
  } catch {
    return null;
  }
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
      tenantIdArg: string,
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

    async findById(
      tenantIdArg: string,
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
      tenantIdArg: string,
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
      tenantIdArg: string,
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
      tenantIdArg: string,
      broadcastId: BroadcastId,
      target: BroadcastStatus,
      fields: Partial<Broadcast>,
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

      const [row] = await tx
        .update(broadcasts)
        .set(setClause)
        .where(
          and(
            eq(broadcasts.tenantId, tenantIdArg),
            eq(broadcasts.broadcastId, broadcastId),
          ),
        )
        .returning();
      if (!row) {
        throw new Error(
          `applyTransition: broadcast ${broadcastId} not found in tenant ${tenantIdArg}`,
        );
      }
      return rowToBroadcast(row as BroadcastRow);
    },

    async attachResendIds(
      txUnknown,
      tenantIdArg: string,
      broadcastId: BroadcastId,
      resendAudienceId: string,
      resendBroadcastId: string,
    ): Promise<void> {
      const tx = txUnknown as TenantTx;
      await tx
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
        );
    },

    async listByTenantStatus(
      tenantIdArg: string,
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
      tenantIdArg: string,
      memberId: string,
      quotaYear: number,
    ): Promise<{
      readonly submittedOrApproved: number;
      readonly sent: number;
    }> {
      return runInTenant(ctx, async (tx) => {
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
                eq(broadcasts.status, 'sent'),
                eq(broadcasts.quotaYearConsumed, quotaYear),
              ),
            ),
        ]);
        return {
          submittedOrApproved: submittedOrApprovedRows[0]?.count ?? 0,
          sent: sentRows[0]?.count ?? 0,
        };
      });
    },

    async findByResendBroadcastIdBypassRls(
      _resendBroadcastId: string,
    ): Promise<
      { readonly tenantId: string; readonly broadcast: Broadcast } | null
    > {
      throw new Error(
        'findByResendBroadcastIdBypassRls: deferred to F7 US4 (webhook handler). Not callable in US1 surface.',
      );
    },
  };
}
