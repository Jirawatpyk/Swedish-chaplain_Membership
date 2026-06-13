/**
 * F8-completion Slice 3 · Task 3.1 — `adminRenewLapsedMember`.
 *
 * The admin "renew / reactivate a lapsed member" action — the REACHABLE
 * lapsed-comeback path. An admin creates a fresh `awaiting_payment`
 * renewal cycle for a lapsed member (one with no active cycle) + issues a
 * §86/4 renewal invoice the member then pays. Once paid, the F4→F8
 * on-paid callbacks close the loop automatically: callback[0] flips the
 * fresh cycle `→completed` and callback[2] creates the next `upcoming`
 * cycle — the member is active again.
 *
 * This is the common-case reachable path only. The `pending_admin_reactivation`
 * money-hold reactivate/reject routes are DEFERRED post-launch (spec §C
 * + Resolved #6) and are NOT built here.
 *
 * Flow (mirrors `confirm-renewal`'s create→issue→link structure so the
 * issue↔link orphan window is no wider than the proven member path):
 *
 *   1. **tx1** (`runInTenant`): resolve the member's CURRENT `plan_id`
 *      (`memberPlanLookup.loadMemberPlanInTx`; null ⇒ `member_not_found`),
 *      then `createCycleInTx(..., startStatus:'awaiting_payment', source:
 *      'admin_lapsed_comeback')`. If the member already holds an active
 *      cycle, `createCycleInTx` no-ops (`skipped_active_exists`) ⇒
 *      `member_has_active_cycle` (the member is NOT lapsed — do not create
 *      a second cycle). If the plan is unresolvable, `createCycleInTx`
 *      throws ⇒ `plan_not_found`. The fresh cycle is `awaiting_payment`,
 *      frozen at the member's current plan price, with a
 *      `renewal_cycle_created` audit emitted in the SAME tx.
 *
 *   2. **issue (OUTSIDE tx1)**: `f4InvoicingBridge.issueInvoiceForRenewal`
 *      with `frozenPlanPriceThb` = the new cycle's frozen price (server-
 *      sourced; NEVER a request body — a §86/4 is a tax document). F4 owns
 *      its own tx for §87 numbering + PDF render. Map failures to
 *      `invoice_issue_failed`. If the issue fails, the fresh cycle is left
 *      `awaiting_payment` with no linked invoice — the SAME recoverable
 *      state as a member who abandons their pay page (admin retries).
 *
 *   3. **tx2** (`runInTenant`): acquire the per-cycle advisory lock +
 *      `linkInvoice` (mirrors confirm-renewal Step-4). The lock + the
 *      adapter's `WHERE (linked_invoice_id IS NULL OR = $1)` guard close
 *      the orphan race. Emit `renewal_invoice_created`.
 *
 * RBAC: admin-only (`action='write'` at the route — manager 403). The
 * use-case input carries `actorRole:'admin'`; the route enforces the role
 * via `requireRenewalAdminContext(request, 'write')`.
 *
 * Coverage policy: Constitution Principle II — 100% branch coverage
 * (security + tax-sensitive mutating path: an admin issues a tax document
 * the member then pays).
 *
 * Pure Application — orchestrates Domain via port interfaces only
 * (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalResult,
} from '../ports/f4-invoicing-bridge';
import type { PlanLookupForRenewalPort } from '../ports/plan-lookup-for-renewal';
import type { MemberPlanLookupPort } from '../ports/member-plan-lookup-port';
import {
  createCycleInTx,
  type CreateCycleInTxDeps,
} from './create-cycle-in-tx';
import { type CycleId, type RenewalCycle } from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  InvoiceLinkConflictError,
} from '../ports/renewal-cycle-repo';

export const adminRenewLapsedMemberInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  /** Calendar year (e.g. 2026) the renewal invoice covers. */
  planYear: z.number().int().min(2000).max(2100),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type AdminRenewLapsedMemberInput = z.infer<
  typeof adminRenewLapsedMemberInputSchema
>;

export interface AdminRenewLapsedMemberOutput {
  readonly cycleId: string;
  readonly invoiceId: string;
  readonly cycleStatus: 'awaiting_payment';
}

export type AdminRenewLapsedMemberError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' }
  | { readonly kind: 'member_has_active_cycle' }
  | { readonly kind: 'plan_not_found' }
  | {
      readonly kind: 'invoice_issue_failed';
      readonly stage: 'create' | 'issue';
      readonly errorCode: string;
      readonly detail: string;
    }
  | { readonly kind: 'server_error'; readonly message: string };

export interface AdminRenewLapsedMemberDeps
  extends Pick<RenewalsDeps, 'tenant' | 'cyclesRepo' | 'auditEmitter' | 'clock'> {
  readonly f4InvoicingBridge: F4InvoicingForRenewalBridge;
  readonly planLookupForRenewal: PlanLookupForRenewalPort;
  readonly memberPlanLookup: MemberPlanLookupPort;
  /** Cycle-id generator (production: `() => asCycleId(randomUUID())`). */
  readonly cycleIdFactory: CreateCycleInTxDeps['idFactory'];
}

export async function adminRenewLapsedMember(
  deps: AdminRenewLapsedMemberDeps,
  rawInput: AdminRenewLapsedMemberInput,
): Promise<Result<AdminRenewLapsedMemberOutput, AdminRenewLapsedMemberError>> {
  const parsed = adminRenewLapsedMemberInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;

  // ---- Step 1 (tx1): resolve member plan + create the fresh cycle.
  const createDeps: CreateCycleInTxDeps = {
    cyclesRepo: deps.cyclesRepo,
    planLookup: deps.planLookupForRenewal,
    auditEmitter: deps.auditEmitter,
    idFactory: deps.cycleIdFactory,
  };

  let stateResult: Result<
    { cycle: RenewalCycle },
    AdminRenewLapsedMemberError
  >;
  try {
    stateResult = await runInTenant(deps.tenant, async (tx) => {
      // Resolve the member's CURRENT plan_id server-side. The frozen
      // §86/4 price derives from THIS plan, never a request body.
      const member = await deps.memberPlanLookup.loadMemberPlanInTx(
        tx,
        input.tenantId,
        input.memberId,
      );
      if (!member) {
        return err({ kind: 'member_not_found' as const });
      }

      // createCycleInTx no-ops if an active cycle exists (the member is
      // NOT lapsed) ⇒ member_has_active_cycle. It THROWS on an
      // unresolvable plan ⇒ caught below as plan_not_found.
      const outcome = await createCycleInTx(createDeps, tx, {
        tenantId: input.tenantId,
        memberId: input.memberId,
        periodFrom: deps.clock.now().toISOString(),
        planId: member.planId,
        source: 'admin_lapsed_comeback',
        startStatus: 'awaiting_payment',
        actorUserId: input.actorUserId,
        actorRole: 'admin',
        correlationId: input.correlationId,
      });
      if (outcome.kind === 'skipped_active_exists') {
        return err({ kind: 'member_has_active_cycle' as const });
      }
      return ok({ cycle: outcome.cycle });
    });
  } catch (e) {
    // createCycleInTx throws ONLY when the plan is unresolvable (it
    // refuses to create a cycle without a frozen price). Any other throw
    // is a genuine infrastructure error.
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('not resolvable')) {
      return err({ kind: 'plan_not_found' });
    }
    logger.error(
      {
        err: e instanceof Error ? e : new Error(message),
        tenantId: input.tenantId,
        memberId: input.memberId,
        correlationId: input.correlationId,
      },
      '[admin-renew-lapsed-member] cycle-creation tx failed',
    );
    return err({ kind: 'server_error', message });
  }
  if (!stateResult.ok) return err(stateResult.error);
  const cycle = stateResult.value.cycle;
  const cycleId: CycleId = cycle.cycleId;

  // ---- Step 2: F4 invoice issuance OUTSIDE the F8 tx (F4 owns its own
  // tx for §87 numbering + PDF render). FR-022 — bill the cycle's FROZEN
  // VAT-exclusive price (server-sourced from the just-created cycle row),
  // NEVER a request body, because a renewal §86/4 is a price-tampering
  // surface on a tax document.
  const invoiceResult = await deps.f4InvoicingBridge.issueInvoiceForRenewal({
    tenantId: input.tenantId,
    memberId: input.memberId,
    planId: cycle.planIdAtCycleStart,
    planYear: input.planYear,
    frozenPlanPriceThb: cycle.frozenPlanPriceThb,
    autoEmailOnIssue: true,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    requestId: input.requestId ?? null,
  });
  if (invoiceResult.status !== 'issued') {
    // The fresh cycle is left `awaiting_payment` with no linked invoice —
    // the SAME recoverable state as a member who abandons their pay page.
    // The admin can retry; createCycleInTx is idempotent on retry (the
    // member now has an active cycle, so a retry returns
    // member_has_active_cycle rather than creating a duplicate). Logged so
    // support sees the orphaned-cycle state.
    logger.warn(
      {
        tenantId: input.tenantId,
        memberId: input.memberId,
        cycleId,
        stage: invoiceResult.status,
        errorCode: invoiceResult.errorCode,
        correlationId: input.correlationId,
      },
      '[admin-renew-lapsed-member] §86/4 issuance failed — fresh awaiting_payment cycle left unlinked (recoverable)',
    );
    return mapInvoiceError(invoiceResult);
  }

  // ---- Step 3 (tx2): link invoice + emit audit atomically under the
  // per-cycle advisory lock (mirror confirm-renewal Step-4 — the lock +
  // the adapter's `WHERE (linked_invoice_id IS NULL OR = $1)` guard close
  // the orphan-invoice race).
  return runInTenant(deps.tenant, async (tx) => {
    await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);
    try {
      await deps.cyclesRepo.linkInvoice(
        tx,
        input.tenantId,
        cycleId,
        invoiceResult.invoiceId,
      );
    } catch (e) {
      if (e instanceof CycleNotFoundError) {
        logger.error(
          { cycleId, invoiceId: invoiceResult.invoiceId },
          '[admin-renew-lapsed-member] cycle gone between create + linkInvoice — orphan invoice in F4 (void via admin)',
        );
        return err({
          kind: 'server_error',
          message: 'cycle vanished after invoice issued — see runbook',
        });
      }
      if (e instanceof InvoiceLinkConflictError) {
        logger.error(
          {
            cycleId,
            attemptedInvoiceId: e.attemptedInvoiceId,
            existingInvoiceId: e.existingInvoiceId,
          },
          '[admin-renew-lapsed-member] concurrent link won the race — our invoice orphaned in F4 (void via admin)',
        );
        return err({
          kind: 'server_error',
          message:
            'concurrent link won the race — our invoice orphaned, void via F4 admin',
        });
      }
      throw e;
    }

    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_invoice_created' as const,
          payload: {
            cycle_id: cycle.cycleId,
            member_id: cycle.memberId,
            invoice_id: invoiceResult.invoiceId,
            invoice_number: invoiceResult.invoiceNumber,
            total_satang: invoiceResult.totalSatang.toString(),
            plan_changed: false,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e.message : String(e), cycleId },
        '[admin-renew-lapsed-member] audit emit failed inside tx — rolling back link',
      );
      throw e;
    }

    return ok({
      cycleId: cycle.cycleId,
      invoiceId: invoiceResult.invoiceId,
      cycleStatus: 'awaiting_payment' as const,
    });
  });
}

function mapInvoiceError(
  result: Exclude<IssueInvoiceForRenewalResult, { status: 'issued' }>,
): Result<never, AdminRenewLapsedMemberError> {
  return err({
    kind: 'invoice_issue_failed',
    stage: result.status === 'create_failed' ? 'create' : 'issue',
    errorCode: result.errorCode,
    detail: result.detail,
  });
}
