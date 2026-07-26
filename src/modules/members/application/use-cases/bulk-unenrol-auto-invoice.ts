/**
 * `bulk-unenrol-auto-invoice` use case (107-auto-invoice Task 18).
 *
 * Clears `members.auto_invoice_enrolled_at` for ≤100 members — the way
 * back out of Task 15's `bulkEnrolAutoInvoice`.
 *
 * WHY THIS EXISTS: Task 15 shipped enrolment as a ONE-WAY DOOR. A member
 * could be opted into automatic invoice drafting from the UI, but the only
 * way back was prod SQL, so "a member asks us to stop auto-billing them"
 * had no answer in the product. Not a launch blocker on its own — a
 * mis-enrolled member only ever produces a DRAFT a treasurer can Discard —
 * but an operator-facing preference with no off switch is a defect.
 *
 * --- Skip semantics: there is no membership-state gate ------------------
 *
 * This is the one place this use case deliberately DIVERGES from its enrol
 * counterpart, and the divergence is the point — do not "align" them.
 *
 * `bulkEnrolAutoInvoice` runs a `membershipAccess` pre-pass and skips
 * `terminated` members, because enrolling an ex-member into automated
 * billing is an outcome with real blast radius. Un-enrolment has no such
 * hazard: it can only ever REDUCE what the system does to a member. So it
 * skips nobody on membership grounds — terminated, archived, and
 * suspended members are all un-enrolled like anyone else.
 *
 * Refusing to un-enrol a terminated member would be the system arguing
 * with an operator who is trying to stop billing someone, which is exactly
 * backwards: the members most likely to need un-enrolling are the ones
 * whose membership has ended. A state gate here would make the off switch
 * fail precisely when it matters most.
 *
 * The ONLY skip bucket is therefore `skippedNotEnrolled` — a member whose
 * `auto_invoice_enrolled_at` is already NULL. That is an idempotent no-op,
 * not a refusal.
 *
 * Consequently this use case needs NO `membershipAccess` dep, no clock
 * (there is no timestamp to write — un-enrolment nulls a column), and no
 * pre-pass at all. Its deps are strictly smaller than enrol's.
 *
 * --- Existing drafts are NOT discarded ----------------------------------
 *
 * Un-enrolling stops FUTURE drafting. An auto-draft already sitting in the
 * treasurer's review queue is a human's work item and is left alone — the
 * treasurer Discards it (Task 14) if they want it gone, and Task 11's
 * prune sweeps it if abandoned. The confirm dialog says this explicitly:
 * an operator who un-enrols expecting the queue to clear, and finds a
 * draft there next week, has been misled by the product.
 *
 * --- Transaction + guard ordering ---------------------------------------
 *
 * `return err(...)` inside a `runInTenant` callback does NOT roll the
 * transaction back — the callback returns normally and the tx COMMITS.
 * Every refusal path therefore sits ABOVE the first write, or THROWS
 * (which does roll back):
 *
 *   - Input validation + cap: before the tx opens.
 *   - Unknown member id: `throw`s `BulkUnenrolNotFoundError` inside the
 *     tx, so a partially-un-enrolled batch is rolled back — all-or-nothing,
 *     matching `bulkAction` / `bulkEnrolAutoInvoice`.
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
import { BULK_CAP } from './bulk-action';

// --- Input schema ------------------------------------------------------------
//
// Mirrors `bulkEnrolAutoInvoiceSchema` exactly apart from the action
// literal, so the route can dispatch on `action` without a second body
// convention.
export const bulkUnenrolAutoInvoiceSchema = z
  .object({
    action: z.literal('unenrol_auto_invoice'),
    member_ids: z
      .array(z.string().uuid())
      .min(1, 'At least one member_id is required')
      .max(BULK_CAP, `Cannot exceed ${BULK_CAP} members per batch`),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Same rationale as bulkAction (staff-review SW-2): duplicate ids would
    // inflate the audit trail and corrupt the bucket counts (the same
    // member landing in both `unenrolled` and `skippedNotEnrolled`).
    const unique = new Set(data.member_ids);
    if (unique.size !== data.member_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['member_ids'],
        message: 'member_ids must be unique',
      });
    }
  });

export type BulkUnenrolAutoInvoiceInput = z.infer<
  typeof bulkUnenrolAutoInvoiceSchema
>;

// --- Errors ------------------------------------------------------------------

export type BulkUnenrolAutoInvoiceError =
  | {
      type: 'invalid_body';
      issues: ReadonlyArray<{ path: string; message: string }>;
    }
  | { type: 'bulk_cap_exceeded'; count: number }
  | { type: 'not_found'; memberId: string }
  | { type: 'server_error'; message: string };

// --- Deps --------------------------------------------------------------------

export type BulkUnenrolAutoInvoiceDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  audit: AuditPort;
};

export type BulkUnenrolAutoInvoiceMeta = {
  actorUserId: string;
  requestId: string;
};

export type BulkUnenrolAutoInvoiceOutput = {
  unenrolled: number;
  skippedNotEnrolled: number;
};

// --- Implementation ----------------------------------------------------------

export async function bulkUnenrolAutoInvoice(
  input: unknown,
  meta: BulkUnenrolAutoInvoiceMeta,
  deps: BulkUnenrolAutoInvoiceDeps,
): Promise<Result<BulkUnenrolAutoInvoiceOutput, BulkUnenrolAutoInvoiceError>> {
  // 1. Validate input shape.
  const parsed = bulkUnenrolAutoInvoiceSchema.safeParse(input);
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

  // NOTE: no membership-access pre-pass here, unlike the enrol counterpart.
  // That is deliberate, not an omission — see the skip-semantics section of
  // this file's header before adding one.

  try {
    const result = await runInTenant(deps.tenant, async (tx) => {
      const memberIds = data.member_ids.map(asMemberId);

      // 3. Batched locking read. `FOR UPDATE` pins every row for the rest
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
          'bulk-unenrol-auto-invoice: findManyByIdsInTx unexpected error',
        );
        throw new Error(`lookup_failed:${lookupResult.error.code}`);
      }
      const membersMap = lookupResult.value;

      // 4. Every requested id must exist IN THIS TENANT. A foreign-tenant
      //    id is invisible under RLS and so lands here as a plain miss —
      //    which is the intended behaviour (no cross-tenant existence
      //    oracle). Throwing rolls the whole batch back.
      for (const id of memberIds) {
        if (!membersMap.has(id)) throw new BulkUnenrolNotFoundError(id);
      }

      // 5. Partition. Two buckets only — the sole question is whether the
      //    member is currently enrolled. Decided from locked rows, no
      //    writes yet.
      const toUnenrol: typeof memberIds = [];
      let skippedNotEnrolled = 0;

      for (const memberId of memberIds) {
        const current = membersMap.get(memberId)!;
        if (current.autoInvoiceEnrolledAt == null) {
          skippedNotEnrolled++;
          continue;
        }
        toUnenrol.push(memberId);
      }

      // 6. Single batched UPDATE. RETURNING is authoritative — the repo
      //    also filters `auto_invoice_enrolled_at IS NOT NULL`, so anything
      //    that slipped past the partition is simply not written.
      const unenrolledIds =
        toUnenrol.length === 0
          ? []
          : await (async () => {
              const persistResult =
                await deps.memberRepo.unenrolAutoInvoiceInTx(
                  tx,
                  deps.tenant.slug,
                  toUnenrol,
                );
              if (!persistResult.ok) {
                throw new Error(`persist:${persistResult.error.code}`);
              }
              // Same invariant the enrol use case pins: the two buckets must
              // always sum to `member_ids.length`, which holds only if the
              // UPDATE wrote exactly the rows we partitioned. It cannot
              // currently diverge (rows pinned `FOR UPDATE` since the lookup,
              // and the repo's `IS NOT NULL` filter can only match what we
              // already checked), but if it ever did, an admin would be told
              // members were un-enrolled that were not — and would believe
              // billing had been stopped for someone it had not. Fail loudly.
              if (persistResult.value.length !== toUnenrol.length) {
                throw new Error(
                  `unenrol_count_mismatch:expected=${toUnenrol.length}:actual=${persistResult.value.length}`,
                );
              }
              return persistResult.value;
            })();

      // 7. One audit row per ACTUALLY un-enrolled member, in the same tx as
      //    the write (Constitution Principle VIII state↔audit atomicity).
      //    This is the ONLY record that the un-enrolment happened — the
      //    write itself nulls the column and so destroys its own evidence,
      //    which is why the audit row cannot be best-effort here.
      for (const memberId of unenrolledIds) {
        const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'member_auto_invoice_unenrolled',
          actorUserId: meta.actorUserId,
          requestId: meta.requestId,
          summary: `un-enrolled member ${memberId} from auto-invoicing`,
          payload: {
            member_id: memberId,
            action: 'unenrol_auto_invoice',
            bulk_request_id: meta.requestId,
          },
        });
        if (!auditResult.ok) throw new Error('audit_failed');
      }

      return { unenrolled: unenrolledIds.length, skippedNotEnrolled };
    });

    return ok(result);
  } catch (e) {
    if (e instanceof BulkUnenrolNotFoundError) {
      return err({ type: 'not_found', memberId: e.memberId });
    }
    // Log the rich cause server-side BEFORE sanitizing the wire response
    // (bulk-action M2) — otherwise an FK violation / `audit_failed` /
    // deadlock collapses to a generic message with no forensic trace.
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        requestId: meta.requestId,
        action: 'unenrol_auto_invoice',
      },
      'bulk-unenrol-auto-invoice: transaction rolled back',
    );
    return err({
      type: 'server_error',
      message: 'bulk un-enrolment failed',
    });
  }
}

// --- Internal error classes --------------------------------------------------

class BulkUnenrolNotFoundError extends Error {
  constructor(public readonly memberId: string) {
    super(`Member not found: ${memberId}`);
  }
}
