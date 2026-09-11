/**
 * F114 — Drizzle implementation of `ChangeRequestRepo` (migration 0300,
 * research R2 / R3 / R4 / R9 / R15).
 *
 * Every `*InTx` method threads the CALLER's `runInTenant` tx — never the
 * global `db` (RLS gotcha: a pool-fresh connection has no `app.current_tenant`
 * and FORCE RLS then shows zero rows / refuses every write). No explicit
 * `WHERE tenant_id = …` on the request table — the RLS policy adds it; the
 * `tenant_id` column is written from the draft (the `WITH CHECK` refuses a
 * forged value).
 *
 * Writes that require `state = 'pending'` put that predicate IN the UPDATE
 * (`WHERE id = … AND state = 'pending'`) so a concurrent transition that
 * committed first matches zero rows → `repo.not_found`, which the use cases
 * map to `not_pending` / `already_decided` after re-reading (FR-017 "first
 * committed transition wins").
 *
 * Keyset pagination on `(submitted_at, id)` — no OFFSET (plan § Technical
 * Context queue budget; T119 proves it at 5,000 rows).
 */
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { runInTenant, type TenantTx } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
// The outbox / users tables live in the auth-shared schema. Same documented
// Infrastructure-only exception the members email adapter uses.
import { users } from '@/modules/auth/infrastructure/db/schema';
import type {
  ChangeRequestCursor,
  ChangeRequestDecision,
  ChangeRequestDraft,
  ChangeRequestListFilter,
  ChangeRequestListResult,
  ChangeRequestListRow,
  ChangeRequestPage,
  ChangeRequestRepo,
  PendingStats,
} from '../../application/ports/change-request-repo';
import type { RepoError } from '../../application/ports/member-repo';
import type {
  ChangeRequest,
  ChangeRequestId,
  ChangeRequestOutcome,
  ChangeRequestScope,
  ChangeRequestState,
  FieldOutcome,
  ProposedField,
  ProposedValue,
  SubmitterRole,
  WithdrawnReason,
} from '../../domain/change-request/change-request';
import { PROPOSABLE_FIELD_KEYS, type ProposableFieldKey, type ProposedFieldTarget } from '../../domain/change-request/proposable-fields';
import type { ContactId } from '../../domain/contact';
import type { UserId } from '../../domain/value-objects/user-id';
import type { MemberId, TenantId } from '../../domain/member';
import { mapDbError, unexpected } from './_repo-error';
import { contacts } from './schema-contacts';
import { members } from './schema-members';
import {
  memberChangeRequestFields,
  memberChangeRequests,
  type MemberChangeRequestFieldRow,
  type MemberChangeRequestRow,
} from './schema-change-requests';

// ---------------------------------------------------------------------------
// Row → Domain
// ---------------------------------------------------------------------------

function fieldRowToDomain(f: MemberChangeRequestFieldRow): ProposedField {
  return {
    key: f.fieldKey as ProposableFieldKey,
    target: f.target as ProposedFieldTarget,
    seen: (f.seenValue ?? null) as ProposedValue,
    proposed: (f.proposedValue ?? null) as ProposedValue,
    affectsTaxDocuments: f.affectsTaxDocuments,
    outcome: (f.outcome ?? null) as FieldOutcome | null,
    appliedAt: f.appliedAt ?? null,
  };
}

/** Field rows in a stable, Group-B order (the CHECK list order), never insertion order. */
// ONE source (round 5, types F1): a hand-copied list typed `string[]` let a
// tenth Group B key compile clean and sort to -1 (ahead of first_name) in
// every read — the review table, both emails.
const FIELD_ORDER: readonly string[] = PROPOSABLE_FIELD_KEYS;

function rowToDomain(r: MemberChangeRequestRow, fieldRows: readonly MemberChangeRequestFieldRow[]): ChangeRequest {
  const fields = [...fieldRows]
    .sort((x, y) => FIELD_ORDER.indexOf(x.fieldKey) - FIELD_ORDER.indexOf(y.fieldKey))
    .map(fieldRowToDomain);
  return {
    id: r.id as ChangeRequestId,
    tenantId: r.tenantId as TenantId,
    memberId: r.memberId as MemberId,
    submittedByUserId: r.submittedByUserId as UserId,
    submittedByContactId: r.submittedByContactId as ContactId,
    submitterRoleAtSubmission: r.submitterRoleAtSubmission as SubmitterRole,
    scope: r.scope as ChangeRequestScope,
    state: r.state as ChangeRequestState,
    outcome: (r.outcome ?? null) as ChangeRequestOutcome | null,
    withdrawnReason: (r.withdrawnReason ?? null) as WithdrawnReason | null,
    replacedByRequestId: (r.replacedByRequestId ?? null) as ChangeRequestId | null,
    submittedAt: r.submittedAt,
    staffNotifiedAt: r.staffNotifiedAt ?? null,
    decidedAt: r.decidedAt ?? null,
    decidedByUserId: (r.decidedByUserId ?? null) as UserId | null,
    decisionReason: r.decisionReason ?? null,
    decisionNote: r.decisionNote ?? null,
    withdrawnAt: r.withdrawnAt ?? null,
    outcomeAcknowledgedAt: r.outcomeAcknowledgedAt ?? null,
    fields,
  };
}

async function loadFields(
  tx: TenantTx,
  requestIds: readonly string[],
): Promise<Map<string, MemberChangeRequestFieldRow[]>> {
  const out = new Map<string, MemberChangeRequestFieldRow[]>();
  if (requestIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(memberChangeRequestFields)
    .where(inArray(memberChangeRequestFields.requestId, [...requestIds]));
  for (const f of rows) {
    const bucket = out.get(f.requestId);
    if (bucket) bucket.push(f);
    else out.set(f.requestId, [f]);
  }
  return out;
}

async function readOne(
  tx: TenantTx,
  id: string,
  lock: boolean,
): Promise<Result<ChangeRequest, RepoError>> {
  const base = tx.select().from(memberChangeRequests).where(eq(memberChangeRequests.id, id)).limit(1);
  const rows = lock ? await base.for('update') : await base;
  const row = rows[0];
  if (!row) return err({ code: 'repo.not_found' });
  const fields = await loadFields(tx, [row.id]);
  return ok(rowToDomain(row, fields.get(row.id) ?? []));
}

// ---------------------------------------------------------------------------
// List projections
// ---------------------------------------------------------------------------

type JoinedRow = {
  request: MemberChangeRequestRow;
  companyName: string;
  memberNumber: number;
  memberStatus: string;
  submitterFirstName: string;
  submitterLastName: string;
  decidedByName: string | null;
  decidedByStatus: string | null;
};

function joinedSelect(tx: TenantTx) {
  return tx
    .select({
      request: memberChangeRequests,
      companyName: members.companyName,
      memberNumber: members.memberNumber,
      memberStatus: members.status,
      submitterFirstName: contacts.firstName,
      submitterLastName: contacts.lastName,
      decidedByName: users.displayName,
      decidedByStatus: users.status,
    })
    .from(memberChangeRequests)
    .innerJoin(members, eq(members.memberId, memberChangeRequests.memberId))
    .innerJoin(contacts, eq(contacts.contactId, memberChangeRequests.submittedByContactId))
    .leftJoin(users, eq(users.id, memberChangeRequests.decidedByUserId));
}

function toListRow(j: JoinedRow, fieldRows: readonly MemberChangeRequestFieldRow[]): ChangeRequestListRow {
  const request = rowToDomain(j.request, fieldRows);
  return {
    request,
    member: {
      companyName: j.companyName,
      memberNumber: j.memberNumber,
      status: j.memberStatus,
      archived: j.memberStatus === 'archived',
    },
    submitter: { displayName: `${j.submitterFirstName} ${j.submitterLastName}`.trim() },
    decidedBy:
      request.decidedByUserId === null
        ? null
        : {
            displayName: j.decidedByName ?? '',
            deactivated: j.decidedByStatus === 'disabled',
          },
  };
}

/**
 * Keyset predicate on `(submitted_at, id)`. Oldest-first pages walk UP from
 * the cursor; newest-first pages walk DOWN. `id` breaks ties so two rows
 * with the same timestamp cannot be skipped or repeated.
 */
function afterCursor(cursor: ChangeRequestCursor | null, oldestFirst: boolean) {
  if (!cursor) return undefined;
  const t = memberChangeRequests.submittedAt;
  const i = memberChangeRequests.id;
  return oldestFirst
    ? or(gt(t, cursor.submittedAt), and(eq(t, cursor.submittedAt), gt(i, cursor.id)))
    : or(lt(t, cursor.submittedAt), and(eq(t, cursor.submittedAt), lt(i, cursor.id)));
}

async function runList(
  ctx: TenantContext,
  where: ReturnType<typeof and>,
  oldestFirst: boolean,
  page: ChangeRequestPage,
): Promise<Result<ChangeRequestListResult, RepoError>> {
  try {
    const limit = Math.max(1, Math.min(page.limit, 100));
    return await runInTenant(ctx, async (tx) => {
      const order = oldestFirst
        ? [asc(memberChangeRequests.submittedAt), asc(memberChangeRequests.id)]
        : [desc(memberChangeRequests.submittedAt), desc(memberChangeRequests.id)];
      const rows = await joinedSelect(tx)
        .where(and(where, afterCursor(page.cursor, oldestFirst)))
        .orderBy(...order)
        .limit(limit + 1);
      const hasMore = rows.length > limit;
      const slice = hasMore ? rows.slice(0, limit) : rows;
      const fields = await loadFields(
        tx,
        slice.map((r) => r.request.id),
      );
      const items = slice.map((j) => toListRow(j, fields.get(j.request.id) ?? []));
      const last = slice[slice.length - 1];
      return ok({
        items,
        nextCursor:
          hasMore && last
            ? { submittedAt: last.request.submittedAt, id: last.request.id as ChangeRequestId }
            : null,
      });
    });
  } catch (e) {
    return err(unexpected(e));
  }
}

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

export const drizzleChangeRequestRepo: ChangeRequestRepo = {
  async insertInTx(tx, draft: ChangeRequestDraft) {
    try {
      const [row] = await tx
        .insert(memberChangeRequests)
        .values({
          id: draft.id,
          tenantId: draft.tenantId,
          memberId: draft.memberId,
          submittedByUserId: draft.submittedByUserId,
          submittedByContactId: draft.submittedByContactId,
          submitterRoleAtSubmission: draft.submitterRoleAtSubmission,
          scope: draft.scope,
          state: 'pending',
          submittedAt: draft.submittedAt,
          staffNotifiedAt: draft.staffNotifiedAt,
          createdAt: draft.submittedAt,
          updatedAt: draft.submittedAt,
        })
        .returning();
      if (!row) return err({ code: 'repo.unexpected', cause: 'insert returned no row' });
      // A unique violation from here on is the (request_id, field_key)
      // uniqueness of the field rows — a caller bug, never the one-pending
      // race the outer catch maps (review: migration M-4).
      let fieldRows: MemberChangeRequestFieldRow[];
      try {
        fieldRows =
        draft.fields.length === 0
          ? []
          : await tx
              .insert(memberChangeRequestFields)
              .values(
                draft.fields.map((f) => ({
                  tenantId: draft.tenantId,
                  requestId: row.id,
                  fieldKey: f.key,
                  target: f.target,
                  seenValue: f.seen,
                  proposedValue: f.proposed,
                  affectsTaxDocuments: f.affectsTaxDocuments,
                })),
              )
              .returning();
      } catch (e) {
        return err(unexpected(e));
      }
      return ok(rowToDomain(row, fieldRows));
    } catch (e) {
      return err(mapDbError(e, 'change_request_pending_exists'));
    }
  },

  async findByIdInTx(tx, id) {
    try {
      return await readOne(tx, id, true);
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findById(ctx, id) {
    try {
      return await runInTenant(ctx, (tx) => readOne(tx, id, false));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findListRowById(ctx, id) {
    try {
      return await runInTenant(ctx, async (tx) => {
        const rows = await joinedSelect(tx).where(eq(memberChangeRequests.id, id)).limit(1);
        const j = rows[0];
        if (!j) return err({ code: 'repo.not_found' });
        const fields = await loadFields(tx, [j.request.id]);
        return ok(toListRow(j, fields.get(j.request.id) ?? []));
      });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findPendingBySubmitterInTx(tx, userId) {
    try {
      const rows = await tx
        .select()
        .from(memberChangeRequests)
        .where(
          and(eq(memberChangeRequests.submittedByUserId, userId), eq(memberChangeRequests.state, 'pending')),
        )
        .limit(1)
        .for('update');
      const row = rows[0];
      if (!row) return ok(null);
      const fields = await loadFields(tx, [row.id]);
      return ok(rowToDomain(row, fields.get(row.id) ?? []));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async withdrawInTx(tx, id, input) {
    try {
      const [row] = await tx
        .update(memberChangeRequests)
        .set({
          state: 'withdrawn',
          withdrawnReason: input.reason,
          withdrawnAt: input.withdrawnAt,
          replacedByRequestId: input.replacedByRequestId ?? null,
          updatedAt: input.withdrawnAt,
        })
        .where(and(eq(memberChangeRequests.id, id), eq(memberChangeRequests.state, 'pending')))
        .returning();
      if (!row) return err({ code: 'repo.not_found' });
      const fields = await loadFields(tx, [row.id]);
      return ok(rowToDomain(row, fields.get(row.id) ?? []));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async decideInTx(tx, id, decision: ChangeRequestDecision) {
    try {
      const [row] = await tx
        .update(memberChangeRequests)
        .set({
          state: 'decided',
          outcome: decision.outcome,
          decidedAt: decision.decidedAt,
          decidedByUserId: decision.decidedByUserId,
          decisionReason: decision.reason,
          decisionNote: decision.note,
          updatedAt: decision.decidedAt,
        })
        .where(and(eq(memberChangeRequests.id, id), eq(memberChangeRequests.state, 'pending')))
        .returning();
      if (!row) return err({ code: 'repo.not_found' });
      for (const f of decision.fields) {
        await tx
          .update(memberChangeRequestFields)
          .set({ outcome: f.outcome, appliedAt: f.appliedAt })
          .where(
            and(eq(memberChangeRequestFields.requestId, row.id), eq(memberChangeRequestFields.fieldKey, f.key)),
          );
      }
      const fields = await loadFields(tx, [row.id]);
      return ok(rowToDomain(row, fields.get(row.id) ?? []));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async acknowledgeInTx(tx, id, at) {
    try {
      // `COALESCE(existing, at)` keeps the FIRST dismissal — idempotent. The
      // Date is passed as an ISO string + explicit cast: a raw `sql` param has
      // no column mapping, so postgres-js would try to serialise the Date as
      // a string buffer and throw.
      const [row] = await tx
        .update(memberChangeRequests)
        .set({
          outcomeAcknowledgedAt: sql`COALESCE(${memberChangeRequests.outcomeAcknowledgedAt}, ${at.toISOString()}::timestamptz)`,
          updatedAt: at,
        })
        .where(eq(memberChangeRequests.id, id))
        .returning();
      if (!row) return err({ code: 'repo.not_found' });
      const fields = await loadFields(tx, [row.id]);
      return ok(rowToDomain(row, fields.get(row.id) ?? []));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async countSubmittedSince(tx, userId, since) {
    try {
      const [row] = await tx
        .select({
          count: sql<number>`count(*)::int`,
          oldest: sql<Date | null>`min(${memberChangeRequests.submittedAt})`,
        })
        .from(memberChangeRequests)
        .where(
          and(eq(memberChangeRequests.submittedByUserId, userId), gt(memberChangeRequests.submittedAt, since)),
        );
      const oldestRaw = row?.oldest ?? null;
      return ok({
        count: row?.count ?? 0,
        oldestSubmittedAt: oldestRaw === null ? null : new Date(oldestRaw),
      });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async listQueue(ctx, filter: ChangeRequestListFilter, page) {
    const state = filter.state ?? 'pending';
    const where = and(
      eq(memberChangeRequests.state, state),
      filter.outcome ? eq(memberChangeRequests.outcome, filter.outcome) : undefined,
      filter.memberId ? eq(memberChangeRequests.memberId, filter.memberId) : undefined,
      filter.submitterUserId ? eq(memberChangeRequests.submittedByUserId, filter.submitterUserId) : undefined,
      filter.from ? gte(memberChangeRequests.submittedAt, filter.from) : undefined,
      filter.to ? lte(memberChangeRequests.submittedAt, filter.to) : undefined,
    );
    // FR-027: pending = oldest waiting on top; history = newest first.
    return runList(ctx, where, state === 'pending', page);
  },

  async listByMember(ctx, memberId, page) {
    return runList(ctx, and(eq(memberChangeRequests.memberId, memberId)), false, page);
  },

  async listVisibleToUser(ctx, userId, memberId, page) {
    // FR-029 in SQL: the caller's own requests + the member's company-level
    // ones; another contact's own-field request never leaves the server.
    const where = and(
      eq(memberChangeRequests.memberId, memberId),
      or(
        eq(memberChangeRequests.submittedByUserId, userId),
        inArray(memberChangeRequests.scope, ['company', 'mixed']),
      ),
      page.state ? eq(memberChangeRequests.state, page.state) : undefined,
    );
    return runList(ctx, where, false, page);
  },

  async pendingStats(ctx): Promise<Result<PendingStats, RepoError>> {
    try {
      return await runInTenant(ctx, async (tx) => {
        const [row] = await tx
          .select({
            count: sql<number>`count(*)::int`,
            oldest: sql<Date | null>`min(${memberChangeRequests.submittedAt})`,
          })
          .from(memberChangeRequests)
          .where(eq(memberChangeRequests.state, 'pending'));
        const oldestRaw = row?.oldest ?? null;
        return ok({
          count: row?.count ?? 0,
          oldestSubmittedAt: oldestRaw === null ? null : new Date(oldestRaw),
        });
      });
    } catch (e) {
      return err(unexpected(e));
    }
  },
};
