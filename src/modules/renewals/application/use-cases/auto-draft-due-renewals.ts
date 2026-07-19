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
 * `processOne`'s batch-loop + outcome-counter shape is a 1:1 clone of
 * `enterAwaitingPaymentOnExpiry` (advisory lock → tx-bound re-read →
 * re-validate → outcome counters with an exhaustive switch). The
 * MUTATION shape, however, follows `confirm-renewal.ts`'s **split-tx**
 * precedent, NOT a single held tx (Review I2 fix): F4's
 * `draftInvoiceForRenewal` opens and commits its OWN separate
 * transaction/connection, so the per-cycle advisory lock (transaction-
 * scoped, `pg_advisory_xact_lock`) must never be held across that call —
 * doing so would keep the lock (and an idle-in-transaction F8 connection)
 * open for the full duration of a cross-module commit, exactly the
 * pattern `confirm-renewal.ts:179-550` was built to avoid. The shape is:
 *   - **tx1** — acquire lock, re-read, precise dedup + membership-access
 *     + classification checks, close (lock released).
 *   - **F4 call** — `draftInvoiceForRenewal`, standalone, no F8 tx/lock
 *     held.
 *   - **tx2** — fresh `runInTenant`, RE-acquires the lock, re-validates
 *     the cycle, stamps `auto_draft_invoice_id` + emits the audit.
 * See the KEY tax-consistency note below and the `ORPHANED_AFTER_COMMIT`
 * note further down for the M2 fix this restructure also resolves.
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
 * Outcome taxonomy: `drafted | skipped_existing | skipped_race_lost |
 * skipped_terminated | draft_failed` (an internal 5th variant folded
 * into the `errors` counter — an F4 `draft_failed` Result is NOT a
 * thrown exception, but it belongs in the same SRE-alert bucket as a
 * genuine throw). Invariant (pinned by the exhaustive switch): `drafted
 * + skippedExisting + skippedRaceLost + skippedTerminated + errors ===
 * cyclesProcessed`.
 *
 * `skippedRaceLost` (Review M1 rename — was `skippedOptOut`, a name that
 * falsely implied a real opt-out signal like `members.renewal_reminders_
 * opted_out`; it checks no such flag): fires on the top-of-`processOne`
 * re-validate when the cycle's status is no longer `upcoming|reminded`
 * since the eligibility-list query — a benign TOCTOU race, most commonly
 * because the member already self-renewed via `confirmRenewal`'s lazy
 * self-transition, or an admin cancelled/changed the cycle. This use-case's
 * declared output shape has no dedicated "race" bucket the way
 * `enterAwaitingPaymentOnExpiry` has `raceSkipped`, so it's folded here
 * rather than into `skippedExisting` (reserved for the CONFIRMED
 * per-plan_year dedup re-check, step 2 below) or `skippedTerminated`
 * (reserved for the membership-access re-assert, step 3 below) — each of
 * the three named skip buckets therefore has exactly one, non-overlapping
 * trigger condition. See `tests/integration/renewals/auto-draft-due-
 * renewals.test.ts`'s dedicated race-lost scenario for direct coverage of
 * this branch.
 *
 * RBAC: cron-only (`actorRole='cron'`, `actorUserId=null` on the
 * audit). The F4 draft's `draft_by_user_id` FK needs a REAL uuid (no
 * human actor exists for a cron draft) — `SYSTEM_ACTOR_AUTO_INVOICE_CRON`
 * below, seeded by migration 0261 (mirrors F5's `SYSTEM_ACTOR_STRIPE_
 * WEBHOOK` / migration 0041 pattern exactly).
 *
 * **Orphan window (Review M2, resolved by the I2 split-tx restructure
 * but not eliminated)**: the F4 draft commits BEFORE tx2 stamps +
 * audits it. If tx2 itself throws (a transient connection blip, a
 * constraint violation), the draft invoice permanently exists —
 * unstamped, unaudited — and the very next cron run's coarse Task-6
 * dedup will silently, permanently skip that member (`skipped_existing`)
 * without ever revisiting the orphan. This is NOT self-healing; it is
 * made *observable* (not fixed) by wrapping tx2 in its own try/catch
 * and logging a distinct, greppable `errorId:
 * 'F8.AUTO_DRAFT.ORPHANED_AFTER_COMMIT'` (with the `invoiceId`) on
 * failure — the outcome still counts as `drafted` (a real invoice DOES
 * exist; miscounting it as `errors` would be less truthful and would
 * double-count against the outer batch-loop catch, which this inner
 * catch deliberately shields tx2 failures from). Flagged for whoever
 * builds the Task 13 review-queue / reconciliation surface: confirm a
 * query exists that lists `origin='auto_renewal'` invoices with no
 * matching `renewal_cycles.auto_draft_invoice_id` back-reference before
 * this ships to a tenant with `auto_invoice_enabled=true`.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics, type AutoDraftSkipReason } from '@/lib/metrics';
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
  readonly skippedRaceLost: number;
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
 * `SYSTEM_ACTOR_STRIPE_WEBHOOK` (migration 0041) — the next FREE id in
 * the reserved `...f500x` namespace. **Review C1 fix**: `...f5002` was
 * already claimed by migration 0181 (F7 Resend-webhook actor,
 * `SYSTEM_ACTOR_RESEND_WEBHOOK` in `mark-invitation-bounced.ts`) — using
 * `...f5003` instead, confirmed unused via a full-repo grep before this
 * fix landed.
 *
 * **Task 11 reuse**: exported (was file-private) so `prune-auto-drafts.ts`
 * can pass the SAME actor identity to `discardAutoDraftForRenewal` —
 * both use-cases act as the one "auto-invoice cron" system identity over
 * the draft's whole lifecycle (create here, discard there), so a reader
 * of `invoices`/`audit_log` sees a single consistent actor rather than
 * two near-identical UUIDs for what is conceptually one automated actor.
 */
export const SYSTEM_ACTOR_AUTO_INVOICE_CRON =
  '00000000-0000-0000-0000-0000000f5003' as const;

const ZERO_OUTPUT: AutoDraftDueRenewalsOutput = {
  drafted: 0,
  skippedExisting: 0,
  skippedRaceLost: 0,
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
  let skippedRaceLost = 0;
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
      // `drafted + skippedExisting + skippedRaceLost + skippedTerminated
      // + errors === cyclesProcessed`.
      switch (outcome) {
        case 'drafted':
          drafted += 1;
          renewalsMetrics.autoDraftCreated(input.tenantId);
          break;
        case 'skipped_existing':
          skippedExisting += 1;
          renewalsMetrics.autoDraftSkipped(
            input.tenantId,
            AUTO_DRAFT_SKIP_REASON_LABEL.skipped_existing,
          );
          break;
        case 'skipped_race_lost':
          skippedRaceLost += 1;
          renewalsMetrics.autoDraftSkipped(
            input.tenantId,
            AUTO_DRAFT_SKIP_REASON_LABEL.skipped_race_lost,
          );
          break;
        case 'skipped_terminated':
          skippedTerminated += 1;
          // Label is `membership_not_full`, NOT `terminated` — this bucket
          // counts suspended (incl. merely-unpaid) members too. See
          // AUTO_DRAFT_SKIP_REASON_LABEL for the full rationale.
          renewalsMetrics.autoDraftSkipped(
            input.tenantId,
            AUTO_DRAFT_SKIP_REASON_LABEL.skipped_terminated,
          );
          break;
        case 'draft_failed':
          // A typed F4 Result failure, not a thrown exception — same
          // SRE-alert bucket as a genuine throw (see module docstring).
          errors += 1;
          renewalsMetrics.autoDraftErrors(input.tenantId);
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
      // Same counter as the typed `draft_failed` arm above — a thrown
      // cycle and a returned failure share one SRE response (a renewal
      // did not get drafted today), so they share one series.
      renewalsMetrics.autoDraftErrors(input.tenantId);
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
    skippedRaceLost,
    skippedTerminated,
    errors,
    cyclesProcessed: page.cycles.length,
  });
}

/**
 * Task 16 review (M-1): the skip arm is `Tx1SkipOutcome` BY REFERENCE, not a
 * hand-copied duplicate of its members. Previously the two unions were
 * maintained independently, so a contributor adding a skip bucket was forced
 * by the switch's `_exhaustive: never` pin to COUNT it, but nothing forced
 * them to LABEL it — `AUTO_DRAFT_SKIP_REASON_LABEL` would still have
 * type-checked against the old, narrower union. Deriving it here ties the two
 * together: a new skip outcome now breaks the label record as well as the
 * switch, which is what the Task 16 report claimed was already true.
 */
type ProcessOneOutcome = 'drafted' | Tx1SkipOutcome | 'draft_failed';

/** tx1's early-exit channel — the 3 skip outcomes decidable BEFORE the F4 call. */
export type Tx1SkipOutcome =
  | 'skipped_existing'
  | 'skipped_race_lost'
  | 'skipped_terminated';

/**
 * 107-auto-invoice Task 16 — internal skip bucket → metric `reason` label.
 *
 * Two of the three map across essentially unchanged. The third does not,
 * and the divergence is deliberate:
 *
 *     skipped_terminated  →  membership_not_full
 *
 * **Why the names differ — do not "align" them.** The internal bucket is
 * populated at step 3 of `processOne` from
 * `deriveMembershipAccess(latestCycle, now).access !== 'full'`, and
 * `access` is a THREE-value union: `'full' | 'suspended' | 'terminated'`
 * (see `src/modules/renewals/domain/renewal-cycle.ts`). The `!== 'full'`
 * test therefore admits SUSPENDED members as well as terminated ones —
 * and `suspended` covers `reason: 'unpaid'`, which is the ordinary,
 * expected state of any member carrying an outstanding invoice during
 * renewal season, plus `reason: 'pending_review'`.
 *
 * Inside this use-case the name is harmless shorthand for "not billable
 * right now" and it has its own review history; renaming shipped internals
 * is churn. But a METRIC LABEL is a contract with a human reading a
 * dashboard during an incident. A series called `terminated` that is
 * mostly composed of members who simply have not paid yet would misinform
 * that person permanently, and — because the number would look plausible —
 * undetectably. `membership_not_full` says exactly what the bucket counts
 * and nothing more.
 *
 * The mapping is pinned by
 * `tests/unit/lib/metrics-auto-invoice.test.ts` (including an explicit
 * "no label contains the word terminated" assertion), so an attempt to
 * collapse the two names fails loudly rather than silently reintroducing
 * the lie.
 *
 * Typed as an EXHAUSTIVE `Record<Tx1SkipOutcome, …>`: adding a fourth skip
 * outcome breaks the build here until it is given a deliberate label.
 */
export const AUTO_DRAFT_SKIP_REASON_LABEL: Readonly<
  Record<Tx1SkipOutcome, AutoDraftSkipReason>
> = {
  skipped_existing: 'existing_invoice',
  skipped_race_lost: 'race_lost',
  skipped_terminated: 'membership_not_full',
};

/** Everything tx2 + the F4 call need, resolved inside tx1 (then tx1 closes). */
interface ReadyToDraft {
  readonly reread: RenewalCycle;
  readonly planYear: number;
  readonly coverageFromIso: string;
  readonly coverageToIso: string;
  readonly membershipCoverage:
    | { readonly kind: 'window'; readonly fromIso: string; readonly toIso: string }
    | undefined;
}

async function processOne(
  deps: AutoDraftDueRenewalsDeps,
  cycle: RenewalCycle,
  tenantId: string,
  correlationId: string,
): Promise<ProcessOneOutcome> {
  const cycleId = cycle.cycleId;

  // --- tx1: lock + re-read + all pre-F4 checks (Review I2 split-tx fix) ---
  // Closes (releasing the advisory lock) BEFORE the F4 call below — never
  // hold an F8 lock/open-tx spanning a cross-module commit. Mirrors
  // confirm-renewal.ts:179-547's `stateResult` tx exactly.
  const tx1Result = await runInTenant(deps.tenant, async (tx) => {
    await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, cycleId);
    const reread = await deps.cyclesRepo.findByIdInTx(tx, tenantId, cycleId);
    // Race-loss: the cycle is no longer `upcoming|reminded` — most
    // commonly a concurrent member self-renew (`confirmRenewal`'s lazy
    // self-transition) or an admin cancel/plan-change since the list
    // query snapshot. See module docstring for the `skippedRaceLost`
    // bucket-mapping rationale.
    if (
      !reread ||
      (reread.status !== 'upcoming' && reread.status !== 'reminded')
    ) {
      return err<Tx1SkipOutcome>('skipped_race_lost');
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
      return err<Tx1SkipOutcome>('skipped_existing');
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
      return err<Tx1SkipOutcome>('skipped_terminated');
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

    return ok<ReadyToDraft>({
      reread,
      planYear,
      coverageFromIso,
      coverageToIso,
      membershipCoverage,
    });
  });

  if (!tx1Result.ok) {
    return tx1Result.error;
  }
  const { reread, planYear, coverageFromIso, coverageToIso, membershipCoverage } =
    tx1Result.value;

  // --- F4 call: STANDALONE, no F8 tx/lock open (Review I2 fix) ------------
  // The per-cycle lock is deliberately released here (tx1 already closed
  // above) — mirrors confirm-renewal.ts's split-tx shape: never hold an F8
  // lock across F4's own commit. This DOES widen a window where a
  // concurrent `confirmRenewal` (which takes the SAME per-cycle lock as
  // its first action) can pass its own dedup and create a second live
  // invoice for this (member, planYear) before our draft commits.
  // Accepted (re-review, not fixed here): worst case is one ISSUED
  // invoice + one stale DRAFT, never a duplicate §86/4 — Task 9's
  // content-guard refuses to issue the stale draft, and Task 11's
  // prune-auto-drafts sweeps it. Double-DRAFT is explicitly "harmless"
  // per design §5.4; the content-guard is the double-BILL barrier.
  // Create-half only — no number, no PDF, no email — `draftInvoiceForRenewal`
  // unconditionally stamps `origin='auto_renewal'` + `autoEmailOnIssue=false`.
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

  // --- tx2: FRESH tx, RE-acquires the lock, stamp + audit -----------------
  // Mirrors confirm-renewal.ts:544-621's link+audit tx2. Wrapped in its own
  // try/catch (Review M2 fix) — a failure here happens AFTER the F4 draft
  // already committed, so it must NOT propagate to the outer batch-loop
  // catch (which would miscount a real, existing invoice as `errors`). See
  // the module docstring's "Orphan window" note for the full rationale.
  try {
    await runInTenant(deps.tenant, async (tx) => {
      await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, cycleId);
      const reread2 = await deps.cyclesRepo.findByIdInTx(tx, tenantId, cycleId);
      if (!reread2) {
        // Extremely unlikely (cycles are never hard-deleted in the normal
        // flow) — but the draft invoice already exists regardless. Throw
        // so the catch below logs the orphan; do not silently no-op.
        throw new Error(
          `cycle ${cycleId} not found on tx2 re-validate — invoice ${invoiceId} already drafted by F4`,
        );
      }
      // Re-validate — log (not skip) if the status drifted since tx1: the
      // stamp + audit are still valid forensic linkage for an invoice that
      // was already, validly, created against THIS cycle. Skipping the
      // stamp here would only worsen the orphan problem, not prevent it.
      if (reread2.status !== 'upcoming' && reread2.status !== 'reminded') {
        logger.warn(
          {
            tenantId,
            cycleId,
            invoiceId,
            statusAtStamp: reread2.status,
          },
          '[auto-draft-due-renewals] cycle status drifted between tx1 and tx2 — stamping/auditing the already-drafted invoice anyway',
        );
      }

      await deps.cyclesRepo.stampAutoDraftInvoiceIdInTx(
        tx,
        tenantId,
        cycleId,
        invoiceId,
      );

      // Audit emit inside tx2 — Principle VIII reverse-direction: an emit
      // failure throws so the stamp rolls back too (both-or-neither within
      // tx2); the F4 invoice itself is unaffected either way (F4's own tx
      // already committed) — see the orphan-window note above.
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
    });
  } catch (e) {
    // Review M2 fix — distinct, greppable, alertable log. Does NOT fix the
    // orphan (see module docstring), only makes it observable. Deliberately
    // swallowed here (not re-thrown) — the outer batch-loop catch must not
    // also count this cycle as `errors`; a real invoice DOES exist.
    logger.error(
      {
        errorId: 'F8.AUTO_DRAFT.ORPHANED_AFTER_COMMIT',
        tenantId,
        cycleId,
        invoiceId,
        err: e instanceof Error ? e : new Error(String(e)),
      },
      '[auto-draft-due-renewals] tx2 (stamp/audit) failed AFTER the F4 draft already committed — invoice exists but is unstamped/unaudited; needs manual reconciliation',
    );
  }

  return 'drafted';
}
