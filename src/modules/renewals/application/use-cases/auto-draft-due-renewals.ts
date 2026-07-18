/**
 * 107-auto-invoice Task 7 — `autoDraftDueRenewals`.
 *
 * The daily auto-draft cron worker body (invoked per tenant by Task 8's
 * coordinator/worker routes). Pre-fills a `status='draft',
 * origin='auto_renewal'` membership invoice for every enrolled member
 * whose current `upcoming|reminded` cycle has entered its billing-cycle
 * lead window — no §87 number, no PDF, no email (design §5.2/§5.9). A
 * treasurer later works the `origin='auto_renewal'` review queue and
 * decides Issue+Send / Issue silently / Discard (later tasks).
 *
 * This is a 1:1 clone of `enterAwaitingPaymentOnExpiry`'s batch-loop +
 * per-cycle `processOne` TOCTOU shape (advisory lock → tx-bound re-read
 * → re-validate → mutate → `emitInTx` audit in the SAME tx → outcome
 * counters with an exhaustive switch), with the mutation swapped from a
 * status transition to an F4 invoice-draft creation.
 *
 * Three-key dark-ship (design §5.7, all default-off):
 *   1. `FEATURE_AUTO_INVOICE` env flag — checked by Task 8's cron route,
 *      NOT here (this use-case has no env import per Constitution
 *      Principle III).
 *   2. `tenant_invoice_settings.auto_invoice_enabled` — checked HERE,
 *      first thing, via `deps.autoInvoiceSettings`. A tenant with no
 *      settings row, or `enabled=false`, short-circuits to an all-zero
 *      result WITHOUT calling the eligibility query — "no behaviour in
 *      prod until all three keys are set" applies at the use-case
 *      layer too, not only the route layer.
 *   3. `members.auto_invoice_enrolled_at IS NOT NULL` — enforced inside
 *      `listCyclesEligibleForAutoDraft`'s own eligibility predicate
 *      (Task 6); not re-checked here.
 *
 * `leadDaysRolling` / `leadDaysCalendar` / `pageSize` also come from the
 * SAME tenant-settings read (Task 1's cadence columns) — the cron
 * cannot even call `listCyclesEligibleForAutoDraft` without them.
 *
 * KEY tax-consistency constraint (design 2026-07-08 rev 3 §3, the
 * rolling-anchor model): a member auto-drafted here and a member who
 * self-confirms via `confirmRenewal` are two paths to the SAME
 * renewal — the resulting §86/4 must be IDENTICAL. `planYear` and the
 * `membershipCoverage` window are therefore derived EXACTLY the way
 * `confirm-renewal.ts` derives them for the renewal it bills
 * (`planYear = deriveFiscalYear(cycle.periodFrom)`,
 * `membershipCoverage = { kind:'window', fromIso: cycle.periodTo,
 * toIso: addMonthsUtc(cycle.periodTo, cycle.frozenPlanTermMonths) }`) —
 * see `confirm-renewal.ts:492` and `:513-522`. The auto-invoice DESIGN
 * DOC's §5.2 prose (`planYear = deriveFiscalYear(cycle.periodTo)`)
 * reads `periodTo`, not `periodFrom` — that wording predates the 070
 * (FR-022 / L2 security) fix in `confirm-renewal.ts`, which explicitly
 * corrected an earlier period-END-based derivation for being
 * "off-by-one for cycles whose period crosses a calendar-year edge".
 * This use-case follows the REVIEWED, SHIPPED `confirm-renewal.ts`
 * behaviour (`periodFrom`), not the design doc's un-updated prose —
 * see the task report for the full recon.
 *
 * Outcome taxonomy: `drafted | skipped_existing | skipped_opt_out |
 * skipped_terminated | draft_failed` (an internal 5th variant folded
 * into the `errors` counter — an F4 `draft_failed` Result is NOT a
 * thrown exception, but it belongs in the same SRE-alert bucket as a
 * genuine throw). Invariant (pinned by the exhaustive switch): `drafted
 * + skippedExisting + skippedOptOut + skippedTerminated + errors ===
 * cyclesProcessed`.
 *
 * `skippedOptOut` mapping note: the top-of-`processOne` re-validate
 * (cycle status no longer `upcoming|reminded` since the list query —
 * most commonly because the member already self-renewed via
 * `confirmRenewal`'s lazy self-transition, or an admin cancelled the
 * cycle) has no dedicated "race" bucket in this use-case's declared
 * output shape (unlike `enterAwaitingPaymentOnExpiry`'s `raceSkipped`).
 * It is folded into `skippedOptOut` ("no longer a candidate for
 * auto-draft this run") rather than `skippedExisting` (reserved for the
 * CONFIRMED per-plan_year dedup re-check, step 2 below) or
 * `skippedTerminated` (reserved for the membership-access re-assert,
 * step 3 below) — each of the three named skip buckets therefore has
 * exactly one, non-overlapping trigger condition.
 *
 * RBAC: cron-only (`actorRole='cron'`, `actorUserId=null` on the
 * audit). The F4 draft's `draft_by_user_id` FK needs a REAL uuid (no
 * human actor exists for a cron draft) — `SYSTEM_ACTOR_AUTO_INVOICE_CRON`
 * below, seeded by migration 0261 (mirrors F5's `SYSTEM_ACTOR_STRIPE_
 * WEBHOOK` / migration 0041 pattern exactly).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import { omitUndefined } from '@/lib/object-helpers';
import { asMemberId } from '@/modules/members';
import { asInvoiceId } from '@/modules/invoicing';
import { parseInput } from './_lib/parse-input';
import { loadClassificationCounts } from './_lib/classification-input';
import { classifyMembershipPayment } from '../../domain/classify-membership-payment';
import { deriveMembershipAccess, type RenewalCycle } from '../../domain/renewal-cycle';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export const autoDraftDueRenewalsInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
});

export type AutoDraftDueRenewalsInput = z.infer<
  typeof autoDraftDueRenewalsInputSchema
>;

export interface AutoDraftDueRenewalsOutput {
  readonly drafted: number;
  readonly skippedExisting: number;
  readonly skippedOptOut: number;
  readonly skippedTerminated: number;
  readonly errors: number;
  readonly cyclesProcessed: number;
}

export type AutoDraftDueRenewalsError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export type AutoDraftDueRenewalsDeps = Pick<
  RenewalsDeps,
  | 'tenant'
  | 'cyclesRepo'
  | 'auditEmitter'
  | 'clock'
  | 'f4InvoicingBridge'
  | 'memberRenewalFlagsRepo'
  | 'autoInvoiceSettings'
>;

/**
 * Reserved system-actor UUID for auto-drafted membership invoices — the
 * daily cron has no human actor, but `invoices.draft_by_user_id` is a
 * `uuid NOT NULL REFERENCES users(id)` FK (migration 0019), so a bare
 * `'system:...'` string sentinel (the audit-only convention used
 * elsewhere, e.g. `render-receipt-pdf.ts`'s `SYSTEM_ACTOR_ID`) cannot
 * be written here. Seeded by migration 0261, mirroring F5's
 * `SYSTEM_ACTOR_STRIPE_WEBHOOK` (migration 0041) — next id in the same
 * reserved `...f500x` namespace.
 */
const SYSTEM_ACTOR_AUTO_INVOICE_CRON =
  '00000000-0000-0000-0000-0000000f5002' as const;

const ZERO_OUTPUT: AutoDraftDueRenewalsOutput = {
  drafted: 0,
  skippedExisting: 0,
  skippedOptOut: 0,
  skippedTerminated: 0,
  errors: 0,
  cyclesProcessed: 0,
};

export async function autoDraftDueRenewals(
  deps: AutoDraftDueRenewalsDeps,
  rawInput: AutoDraftDueRenewalsInput,
): Promise<Result<AutoDraftDueRenewalsOutput, AutoDraftDueRenewalsError>> {
  const inputResult = parseInput(autoDraftDueRenewalsInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  // Three-key gate, key #2 — tenant-level `auto_invoice_enabled` +
  // the lead-day/page-size cadence config. A tenant with no settings
  // row, or the flag off, does nothing this run (dark-ship default).
  const settings = await deps.autoInvoiceSettings.getAutoInvoiceSettings(
    input.tenantId,
  );
  if (!settings || !settings.enabled) {
    logger.info(
      {
        tenantId: input.tenantId,
        hasSettingsRow: settings !== null,
        enabled: settings?.enabled ?? false,
      },
      '[auto-draft-due-renewals] tenant not enabled for auto-invoice — skipping run',
    );
    return ok(ZERO_OUTPUT);
  }

  const now = deps.clock.now();
  const page = await deps.cyclesRepo.listCyclesEligibleForAutoDraft(
    input.tenantId,
    {
      nowIso: now.toISOString(),
      leadDaysRolling: settings.leadDaysRolling,
      leadDaysCalendar: settings.leadDaysCalendar,
      pageSize: settings.pageSize,
    },
  );

  let drafted = 0;
  let skippedExisting = 0;
  let skippedOptOut = 0;
  let skippedTerminated = 0;
  let errors = 0;

  for (const cycle of page.cycles) {
    try {
      const outcome = await processOne(
        deps,
        cycle,
        input.tenantId,
        input.correlationId,
      );
      // Exhaustive switch + `_exhaustive: never` pin (F8-canonical
      // pattern, same as `enterAwaitingPaymentOnExpiry`). A future 6th
      // ProcessOneOutcome variant MUST add a counter line here — the
      // pin breaks the build until it does, protecting the invariant
      // `drafted + skippedExisting + skippedOptOut + skippedTerminated
      // + errors === cyclesProcessed`.
      switch (outcome) {
        case 'drafted':
          drafted += 1;
          break;
        case 'skipped_existing':
          skippedExisting += 1;
          break;
        case 'skipped_opt_out':
          skippedOptOut += 1;
          break;
        case 'skipped_terminated':
          skippedTerminated += 1;
          break;
        case 'draft_failed':
          // A typed F4 Result failure, not a thrown exception — same
          // SRE-alert bucket as a genuine throw (see module docstring).
          errors += 1;
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
    } catch (e) {
      // Per-cycle fault isolation — one bad cycle must not abort the
      // whole cron run. Pass the Error OBJECT (not `e.message`) so
      // pino's err-serialiser captures the stack trace.
      errors += 1;
      logger.error(
        {
          errorId: 'F8.AUTO_DRAFT.CYCLE_FAILED',
          tenantId: input.tenantId,
          cycleId: cycle.cycleId,
          err: e instanceof Error ? e : new Error(String(e)),
        },
        '[auto-draft-due-renewals] cycle draft threw — counted in errors; cron continues',
      );
    }
  }

  return ok({
    drafted,
    skippedExisting,
    skippedOptOut,
    skippedTerminated,
    errors,
    cyclesProcessed: page.cycles.length,
  });
}

type ProcessOneOutcome =
  | 'drafted'
  | 'skipped_existing'
  | 'skipped_opt_out'
  | 'skipped_terminated'
  | 'draft_failed';

async function processOne(
  deps: AutoDraftDueRenewalsDeps,
  cycle: RenewalCycle,
  tenantId: string,
  correlationId: string,
): Promise<ProcessOneOutcome> {
  const cycleId = cycle.cycleId;

  // Single tx — advisory lock + tx-bound re-read + draft creation +
  // audit emit (Constitution Principle VIII state↔audit atomicity).
  return runInTenant(deps.tenant, async (tx) => {
    await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, cycleId);
    const reread = await deps.cyclesRepo.findByIdInTx(tx, tenantId, cycleId);
    // Race-loss: the cycle is no longer `upcoming|reminded` — most
    // commonly a concurrent member self-renew (`confirmRenewal`'s lazy
    // self-transition) or an admin cancel/plan-change since the list
    // query snapshot. See module docstring for the `skippedOptOut`
    // bucket-mapping rationale.
    if (
      !reread ||
      (reread.status !== 'upcoming' && reread.status !== 'reminded')
    ) {
      return 'skipped_opt_out';
    }

    // Step 1 — derive planYear EXACTLY as confirm-renewal.ts does
    // (periodFrom-based; see module docstring KEY constraint).
    const planYear = deriveFiscalYear(reread.periodFrom);

    // Step 2 — precise per-plan_year dedup re-check under the lock.
    const hasLiveInvoice =
      await deps.cyclesRepo.hasLiveMembershipInvoiceForPlanYearInTx(
        tx,
        tenantId,
        reread.memberId,
        planYear,
      );
    if (hasLiveInvoice) {
      return 'skipped_existing';
    }

    // Step 3 — membership-access re-assert. Reuses the SAME predicate
    // `checkPortalAccess`/`lapsed-portal-scope.ts` uses
    // (`deriveMembershipAccess` over `findLatestCycleForMember`), just
    // threaded on this tx instead of opening a fresh connection.
    const latestCycle = await deps.cyclesRepo.findLatestCycleForMemberInTx(
      tx,
      tenantId,
      reread.memberId,
    );
    const access = deriveMembershipAccess(latestCycle, deps.clock.now());
    if (access.access !== 'full') {
      return 'skipped_terminated';
    }

    // Step 4 — coverage-omit gate, mirroring confirm-renewal.ts's
    // classifyMembershipPayment → omitMembershipCoverage exactly (same
    // shared classifier every settlement site consumes). In practice a
    // cycle reaching this point is always a genuine renewal (a
    // brand-new member's FIRST cycle is born `awaiting_payment`, never
    // `upcoming`/`reminded` — see design §5.3), but the gate is kept
    // for parity + to defensively cover the GDPR-erased edge case
    // confirm-renewal.ts also guards (FIX-7(d)).
    const guards = await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
      tx,
      tenantId,
      reread.memberId,
    );
    const { cycleCountForMember, settledCycleCountForMember } =
      await loadClassificationCounts(
        deps,
        tx,
        tenantId,
        reread.memberId,
        reread.cycleId,
      );
    // `reread.status` is narrowed to `'upcoming' | 'reminded'` at this
    // point (the top-of-function guard above already returned early on
    // anything else) — unlike confirm-renewal.ts's SAME classification
    // call, this use-case never flips the cycle to `awaiting_payment`
    // before classifying, so the `awaiting_payment` arm can never fire
    // here. `classifyMembershipPayment`'s domain doc comment: "'reminded'
    // is a declared-but-never-written status ... callers ... treat it as
    // 'upcoming'" — both narrowed statuses map to the same `'upcoming'`
    // openCycle shape the classifier accepts.
    const classification = classifyMembershipPayment({
      cycleCountForMember,
      settledCycleCountForMember,
      openCycle: { status: 'upcoming', anchoredAt: reread.anchoredAt },
      memberErased: guards?.erased === true,
    });
    const omitMembershipCoverage = classification.kind !== 'renewal';

    // Coverage window — periodTo-anchored, UNSLICED (full ISO), byte-
    // for-byte matching confirm-renewal.ts:513-522's `fromIso`/`toIso`
    // (tax-document consistency across both renewal paths).
    const coverageFromIso = reread.periodTo;
    const coverageToIso = addMonthsUtc(
      reread.periodTo,
      reread.frozenPlanTermMonths,
    );
    const membershipCoverage = omitMembershipCoverage
      ? undefined
      : ({ kind: 'window' as const, fromIso: coverageFromIso, toIso: coverageToIso });

    // Step 5 — draft the invoice (create-half only; no number, no PDF,
    // no email — `draftInvoiceForRenewal` unconditionally stamps
    // `origin='auto_renewal'` + `autoEmailOnIssue=false`).
    const draftResult = await deps.f4InvoicingBridge.draftInvoiceForRenewal({
      tenantId,
      memberId: reread.memberId,
      planId: reread.planIdAtCycleStart,
      planYear,
      frozenPlanPriceThb: reread.frozenPlanPriceThb,
      ...omitUndefined({ membershipCoverage }),
      actorUserId: SYSTEM_ACTOR_AUTO_INVOICE_CRON,
      requestId: null,
    });

    if (draftResult.status !== 'drafted') {
      logger.warn(
        {
          tenantId,
          cycleId,
          memberId: reread.memberId,
          errorCode: draftResult.errorCode,
          detail: draftResult.detail,
        },
        '[auto-draft-due-renewals] draftInvoiceForRenewal failed — counted in errors',
      );
      return 'draft_failed';
    }

    const invoiceId = asInvoiceId(draftResult.invoiceId);
    await deps.cyclesRepo.stampAutoDraftInvoiceIdInTx(
      tx,
      tenantId,
      cycleId,
      invoiceId,
    );

    // Audit emit inside the same tx — Principle VIII reverse-direction:
    // an emit failure throws so the draft-stamp rolls back (the F4
    // invoice row itself lives in F4's OWN committed tx from Step 5 —
    // an audit-emit failure here does not un-draft the invoice, only
    // rolls back this tx's `auto_draft_invoice_id` stamp; the invoice
    // remains a valid, if unstamped, draft. Same trade-off as every
    // other F8→F4 3-tx composition).
    await deps.auditEmitter.emitInTx(
      tx,
      {
        type: 'renewal_auto_drafted' as const,
        payload: {
          cycle_id: cycleId,
          member_id: asMemberId(reread.memberId),
          plan_year: planYear,
          frozen_price_thb: reread.frozenPlanPriceThb,
          coverage_from: coverageFromIso.slice(0, 10),
          coverage_to: coverageToIso.slice(0, 10),
        },
      },
      {
        tenantId,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
      },
    );

    return 'drafted';
  });
}
