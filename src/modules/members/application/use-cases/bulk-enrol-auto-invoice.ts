/**
 * `bulk-enrol-auto-invoice` use case (107-auto-invoice Task 15).
 *
 * Enrols ≤100 members into proactive renewal auto-invoicing by stamping
 * `members.auto_invoice_enrolled_at`.
 *
 * WHY THIS EXISTS: auto-invoicing is gated by THREE independent keys,
 * all default-off —
 *   1. `FEATURE_AUTO_INVOICE` (env kill-switch),
 *   2. `tenant_invoice_settings.auto_invoice_enabled` (per-tenant),
 *   3. `members.auto_invoice_enrolled_at` (per-member).
 * This use case is the ONLY write path for key #3. The Task 6 eligibility
 * query (`listCyclesEligibleForAutoDraft`) already filters on
 * `auto_invoice_enrolled_at IS NOT NULL`, so before this landed the cron
 * could select nobody and the whole feature was unreachable.
 *
 * --- Skip semantics (the one real judgement call here) --------------------
 *
 * `deriveMembershipAccess` classifies a member into THREE states —
 * `full` / `suspended` / `terminated` — but only `terminated` is a skip
 * here. A `suspended` member (unpaid, or pending admin reactivation) is
 * still enrolled, deliberately:
 *
 *   - Enrolment is a stored PREFERENCE, not an action taken against the
 *     member. Nothing is billed at enrolment time.
 *   - `autoDraftDueRenewals` (Task 7) RE-ASSERTS membership access
 *     per-member, under the cycle lock, immediately before it drafts
 *     anything (`access !== 'full'` → `skippedTerminated`). So enrolling
 *     a suspended member cannot cause an invoice to be drafted while
 *     they remain suspended — the gate that matters runs later.
 *   - Suspended is the NORMAL state near renewal season (it covers
 *     `awaiting_payment`). Skipping it would mean a bulk enrol across the
 *     directory silently drops a large fraction of the roster, with no
 *     signal to the admin beyond a count, and they would have to
 *     remember to re-run later.
 *
 * `terminated` IS skipped because it means the membership has actually
 * ended (grace-expired lapse, or a cancelled cycle past its coverage) —
 * enrolling an ex-member into automated billing is the one outcome with
 * real blast radius.
 *
 * --- Transaction + guard ordering ----------------------------------------
 *
 * `return err(...)` inside a `runInTenant` callback does NOT roll the
 * transaction back — the callback returns normally and the tx COMMITS.
 * Every refusal path therefore either sits ABOVE the first write, or
 * THROWS (which does roll back). Concretely:
 *
 *   - Input validation + cap: before the tx opens.
 *   - Membership-access classification: before the tx opens (it is a
 *     read-only pre-pass; the bridge opens its own connection and so
 *     could not join this tx anyway).
 *   - Unknown member id: `throw`s `BulkEnrolNotFoundError` inside the tx,
 *     so a partially-enrolled batch is rolled back — all-or-nothing,
 *     matching `bulkAction`'s contract.
 *
 * Because the access pre-pass runs outside the tx there is a narrow
 * TOCTOU window: a member could be terminated between classification and
 * the UPDATE, and would be enrolled anyway. That is acceptable and NOT
 * worth a lock — the enrolment flag is inert on its own, and Task 7's
 * per-member re-assert (above) is the authoritative gate before any
 * money-side effect.
 *
 * Rate limiting is NOT enforced here — it is a transport concern owned by
 * the route handler, same single-enforcement-point rule as `bulkAction`
 * (round-2 review C-1).
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { asMemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { MembershipAccessPort } from '../ports/membership-access-port';
import { BULK_CAP } from './bulk-action';

// --- Input schema ------------------------------------------------------------
//
// Mirrors `bulkActionSchema`'s shape (same cap, same uniqueness rule) so
// the route can dispatch on `action` without a second body convention.
export const bulkEnrolAutoInvoiceSchema = z
  .object({
    action: z.literal('enrol_auto_invoice'),
    member_ids: z
      .array(z.string().uuid())
      .min(1, 'At least one member_id is required')
      .max(BULK_CAP, `Cannot exceed ${BULK_CAP} members per batch`),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Same rationale as bulkAction (staff-review SW-2): duplicate ids
    // would inflate the audit trail and corrupt the bucket counts (the
    // same member landing in both `enrolled` and `skippedAlready`).
    const unique = new Set(data.member_ids);
    if (unique.size !== data.member_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['member_ids'],
        message: 'member_ids must be unique',
      });
    }
  });

export type BulkEnrolAutoInvoiceInput = z.infer<typeof bulkEnrolAutoInvoiceSchema>;

// --- Errors ------------------------------------------------------------------

export type BulkEnrolAutoInvoiceError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'bulk_cap_exceeded'; count: number }
  | { type: 'not_found'; memberId: string }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------

export type BulkEnrolAutoInvoiceDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
  clock: ClockPort;
  membershipAccess: MembershipAccessPort;
};

export type BulkEnrolAutoInvoiceMeta = {
  actorUserId: string;
  requestId: string;
};

export type BulkEnrolAutoInvoiceOutput = {
  enrolled: number;
  skippedAlready: number;
  skippedTerminated: number;
};

// --- Implementation ----------------------------------------------------------

export async function bulkEnrolAutoInvoice(
  input: unknown,
  meta: BulkEnrolAutoInvoiceMeta,
  deps: BulkEnrolAutoInvoiceDeps,
): Promise<Result<BulkEnrolAutoInvoiceOutput, BulkEnrolAutoInvoiceError>> {
  // 1. Validate input shape.
  const parsed = bulkEnrolAutoInvoiceSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const data = parsed.data;

  // 2. Server-side cap (defence-in-depth — zod already caps).
  if (data.member_ids.length > BULK_CAP) {
    return err({ type: 'bulk_cap_exceeded', count: data.member_ids.length });
  }

  // 3. Membership-access pre-pass — ABOVE the first write (see header).
  //    One batched query for the whole request. Fails CLOSED: an infra
  //    failure aborts the entire request rather than silently enrolling
  //    members whose access could not be verified.
  //
  //    Cross-reference: `autoDraftDueRenewals` (Task 7) applies the SAME
  //    `deriveMembershipAccess` predicate to the same member, but asks a
  //    DIFFERENT question and so uses a different threshold — it refuses to
  //    DRAFT unless access is exactly `full` (`access !== 'full'` →
  //    `skippedTerminated`), whereas this use case only refuses to ENROL a
  //    `terminated` member. Same predicate, different question: enrolling is
  //    a reversible-in-principle preference with no side effect; drafting
  //    mints a document. The asymmetry is deliberate — see the skip-semantics
  //    section of this file's header. Do not "align" them without reading it.
  const accessResult = await deps.membershipAccess.getMembershipAccessMany(
    deps.tenant,
    data.member_ids,
  );
  if (!accessResult.ok) {
    logger.error(
      { requestId: meta.requestId, memberCount: data.member_ids.length },
      'bulk-enrol-auto-invoice: membership access lookup failed — refusing to enrol',
    );
    return err({
      type: 'server_error',
      message: 'membership access lookup failed',
    });
  }
  const accessByMember = accessResult.value;

  const now = deps.clock.now();
  try {
    const result = await runInTenant(deps.tenant, async (tx) => {
      const memberIds = data.member_ids.map(asMemberId);

      // 4. Batched locking read. `FOR UPDATE` pins every row for the rest
      //    of the tx, so the `auto_invoice_enrolled_at` value we partition
      //    on cannot change under us between here and the UPDATE.
      const lookupResult = await deps.memberRepo.findManyByIdsInTx(
        tx,
        deps.tenant.slug,
        memberIds,
      );
      if (!lookupResult.ok) {
        logger.error(
          { err: lookupResult.error, requestId: meta.requestId },
          'bulk-enrol-auto-invoice: findManyByIdsInTx unexpected error',
        );
        throw new Error(`lookup_failed:${lookupResult.error.code}`);
      }
      const membersMap = lookupResult.value;

      // 5. Every requested id must exist IN THIS TENANT. A foreign-tenant
      //    id is invisible under RLS and so lands here as a plain miss —
      //    which is the intended behaviour (no cross-tenant existence
      //    oracle). Throwing rolls the whole batch back.
      for (const id of memberIds) {
        if (!membersMap.has(id)) throw new BulkEnrolNotFoundError(id);
      }

      // 6. Partition into buckets. All three branches are decided from
      //    locked rows + the pre-pass map, with no writes yet.
      const toEnrol: typeof memberIds = [];
      let skippedAlready = 0;
      let skippedTerminated = 0;

      for (const memberId of memberIds) {
        const current = membersMap.get(memberId)!;
        // Missing from the map is impossible (the bridge classifies every
        // requested id), but treat an absent entry as non-full so an
        // unexpected gap fails CLOSED rather than enrolling silently.
        const access = accessByMember.get(memberId)?.access ?? 'terminated';

        if (access === 'terminated') {
          skippedTerminated++;
          continue;
        }
        if (current.autoInvoiceEnrolledAt != null) {
          skippedAlready++;
          continue;
        }
        toEnrol.push(memberId);
      }

      // 7. Single batched UPDATE. RETURNING is authoritative — the repo
      //    also filters `auto_invoice_enrolled_at IS NULL`, so anything
      //    that slipped past the partition is simply not written.
      const enrolledIds =
        toEnrol.length === 0
          ? []
          : await (async () => {
              const persistResult = await deps.memberRepo.enrolAutoInvoiceInTx(
                tx,
                deps.tenant.slug,
                toEnrol,
                now,
              );
              if (!persistResult.ok) {
                throw new Error(`persist:${persistResult.error.code}`);
              }
              // Task 15 review (Minor) — the three buckets must always sum to
              // `member_ids.length`. That holds only if the UPDATE wrote
              // exactly the rows we partitioned into `toEnrol`. It cannot
              // currently diverge (the rows are pinned `FOR UPDATE` from the
              // lookup above, and the repo's `IS NULL` filter can only match
              // what we already checked), but if it ever did, the counts would
              // silently stop summing and an admin would be told members were
              // enrolled that were not. Fail the batch loudly instead.
              if (persistResult.value.length !== toEnrol.length) {
                throw new Error(
                  `enrol_count_mismatch:expected=${toEnrol.length}:actual=${persistResult.value.length}`,
                );
              }
              return persistResult.value;
            })();

      // 8. One audit row per ACTUALLY-enrolled member, in the same tx as
      //    the write (Constitution Principle VIII state↔audit atomicity).
      //    Singular per-member event with `action` + `bulk_request_id` in
      //    the payload — the convention `bulkAction` uses for
      //    `member_archived` / `member_plan_changed`, which keeps a
      //    member's own timeline complete while still letting a bulk run
      //    be reconstructed by grouping on `bulk_request_id`.
      for (const memberId of enrolledIds) {
        const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'member_auto_invoice_enrolled',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `enrolled member ${memberId} in auto-invoicing`,
          payload: {
            member_id: memberId,
            action: 'enrol_auto_invoice',
            bulk_request_id: meta.requestId,
            enrolled_at: now.toISOString(),
          },
        });
        if (!auditResult.ok) throw new Error('audit_failed');
      }

      return {
        enrolled: enrolledIds.length,
        skippedAlready,
        skippedTerminated,
      };
    });

    return ok(result);
  } catch (e) {
    if (e instanceof BulkEnrolNotFoundError) {
      return err({ type: 'not_found', memberId: e.memberId });
    }
    // Log the rich cause server-side BEFORE sanitizing the wire response
    // (bulk-action M2) — otherwise an FK violation / `audit_failed` /
    // deadlock collapses to a generic message with no forensic trace.
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        requestId: meta.requestId,
        action: 'enrol_auto_invoice',
      },
      'bulk-enrol-auto-invoice: transaction rolled back',
    );
    return err({
      type: 'server_error',
      message: 'bulk enrolment failed',
    });
  }
}

// --- Internal error classes --------------------------------------------------

class BulkEnrolNotFoundError extends Error {
  constructor(public readonly memberId: string) {
    super(`Member not found: ${memberId}`);
  }
}
