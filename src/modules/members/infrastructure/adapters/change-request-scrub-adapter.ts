/**
 * F114 T078 — `ChangeRequestScrubPort` over Drizzle (FR-030; research R10).
 *
 * Runs INSIDE `eraseMember`'s atomic scrub tx (the caller's `runInTenant`
 * tx — never the global `db`; RLS + the GUC confine every statement to the
 * erased member's tenant). The id read is `SELECT … FOR UPDATE`: the
 * REQUEST rows are the first lock this adapter takes, before any field row,
 * because `decideInTx` locks the request row first and writes the field
 * rows LAST — a scrub that updated field rows before holding the request
 * row was an AB-BA with decide on (field rows ↔ request row) (the seam
 * review of PR-2, #1). Every F114 writer now serialises on the request row.
 * Three statements, each idempotent (a re-drive rewrites the same sentinels
 * and closes nothing new):
 *
 *   1. every field row of the member's requests: `seen_value` /
 *      `proposed_value` → the `[erased]` sentinel (a JSON string — for an
 *      address group too: the DB → Domain seam accepts the sentinel for any
 *      key, so a scrubbed request still reads back through the repo instead
 *      of becoming a corrupt row that 500s the queue);
 *   2. every request of the member: `decision_reason` / `decision_note` →
 *      the sentinel WHEN SET (never NULL — `reason_iff_rejected_ck` keeps a
 *      rejected request's reason NOT NULL), `updated_at` stamped;
 *   3. every PENDING request → `withdrawn / erasure` with `withdrawn_at`
 *      (a decided request keeps its state + outcome — a decision is final,
 *      and the existence + outcome of every request stay countable, FR-030).
 *
 * Returns the closed requests' `(id, contact_id, scope)` so the use case can
 * write one `member_change_request_withdrawn` audit row per closure — the
 * adapter writes no audit itself (the use case owns attribution).
 *
 * The column lists below are EXPORTED and each `.set({...})` is typed
 * against its own list (`satisfies Cols<…>` — a missing or extra key fails
 * this file's typecheck), so the column-coverage guard
 * (scrub-change-requests-pii-column-coverage.test.ts) reads the adapter's
 * own truth, not a hand-copied constant (review round 1, P-6 / SEC-S2).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { err, ok } from '@/lib/result';
import type { ChangeRequestScrubPort, ClosedChangeRequest } from '../../application/ports/change-request-scrub-port';
import type { ChangeRequestId, ChangeRequestScope } from '../../domain/change-request/change-request';
import type { ContactId } from '../../domain/contact';
import { ERASED_SENTINEL } from '../../domain/erasure-sentinels';
import { memberChangeRequestFields, memberChangeRequests } from '../db/schema-change-requests';

type Cols<T extends readonly string[]> = Record<T[number], unknown>;

/** `member_change_request_fields` — the two value columns (statement 1). */
export const FIELD_SCRUBBED_COLUMNS = ['seenValue', 'proposedValue'] as const;
const REASON_COLUMNS = ['decisionReason', 'decisionNote', 'updatedAt'] as const;
const CLOSE_COLUMNS = ['state', 'withdrawnReason', 'withdrawnAt', 'updatedAt'] as const;
/** `member_change_requests` — every column statements 2 + 3 rewrite. */
export const REQUEST_SCRUBBED_COLUMNS: ReadonlyArray<(typeof REASON_COLUMNS)[number] | (typeof CLOSE_COLUMNS)[number]> = [
  ...new Set<(typeof REASON_COLUMNS)[number] | (typeof CLOSE_COLUMNS)[number]>([...REASON_COLUMNS, ...CLOSE_COLUMNS]),
];

export const changeRequestScrubAdapter: ChangeRequestScrubPort = {
  async scrubForMemberInTx(txUnknown, memberId, at) {
    const tx = txUnknown as TenantTx;
    try {
      const ids = (
        await tx.select({ id: memberChangeRequests.id }).from(memberChangeRequests).where(eq(memberChangeRequests.memberId, memberId)).for('update')
      ).map((r) => r.id);
      if (ids.length === 0) return ok({ scrubbedRequestIds: [], closedRequests: [] });

      // 1. the values (jsonb string sentinel)
      await tx
        .update(memberChangeRequestFields)
        .set({ seenValue: ERASED_SENTINEL, proposedValue: ERASED_SENTINEL } satisfies Cols<typeof FIELD_SCRUBBED_COLUMNS>)
        .where(inArray(memberChangeRequestFields.requestId, ids));

      // 2. the reviewer's free text — sentinel when set, NULL stays NULL
      await tx
        .update(memberChangeRequests)
        .set({
          decisionReason: sql`CASE WHEN ${memberChangeRequests.decisionReason} IS NULL THEN NULL ELSE ${ERASED_SENTINEL} END`,
          decisionNote: sql`CASE WHEN ${memberChangeRequests.decisionNote} IS NULL THEN NULL ELSE ${ERASED_SENTINEL} END`,
          updatedAt: at,
        } satisfies Cols<typeof REASON_COLUMNS>)
        .where(inArray(memberChangeRequests.id, ids));

      // 3. close what is still pending
      const closed = await tx
        .update(memberChangeRequests)
        .set({ state: 'withdrawn', withdrawnReason: 'erasure', withdrawnAt: at, updatedAt: at } satisfies Cols<typeof CLOSE_COLUMNS>)
        .where(and(inArray(memberChangeRequests.id, ids), eq(memberChangeRequests.state, 'pending')))
        .returning({ id: memberChangeRequests.id, contactId: memberChangeRequests.submittedByContactId, scope: memberChangeRequests.scope });

      const closedRequests: ClosedChangeRequest[] = closed.map((c) => ({
        id: c.id as ChangeRequestId,
        contactId: c.contactId as ContactId,
        scope: c.scope as ChangeRequestScope,
      }));
      return ok({ scrubbedRequestIds: ids as ChangeRequestId[], closedRequests });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  // the post-member-lock rescan (see the port) — a plain read on the same tx
  async listRequestIdsInTx(txUnknown, memberId) {
    const tx = txUnknown as TenantTx;
    try {
      const rows = await tx.select({ id: memberChangeRequests.id }).from(memberChangeRequests).where(eq(memberChangeRequests.memberId, memberId));
      return ok(rows.map((r) => r.id as ChangeRequestId));
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },
};
