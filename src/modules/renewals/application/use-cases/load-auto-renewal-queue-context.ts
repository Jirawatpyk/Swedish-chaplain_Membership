/**
 * 107-auto-invoice Task 13 — `loadAutoRenewalQueueContext`.
 *
 * READ-ONLY enrichment for the admin `/admin/invoices` review-queue view
 * (`origin='auto_renewal' AND status='draft'`). For each queued draft it
 * resolves the per-row context a treasurer needs before clicking Issue
 * (Task 14 wires the actions; this is display-only). Every signal is
 * designed to answer "what will actually happen if this row is clicked
 * right now" — not merely "does something look unusual" — per the Task 13
 * review round that found the first cut's bill-year note fired on 100% of
 * rows and its would-be-refused prediction missed two of the (then-)three
 * refusal reasons — the predictor now models all FOUR (see the enumeration
 * below; `member_erased` was the fourth, added later).
 *
 *   1. **Price** — does the cycle's frozen §86/4 price still match the
 *      CURRENT active plan-catalogue price for (planId, planYear)?
 *      Compared in exact satang (never float) via `parseThbDecimalToSatang`.
 *      Split into TWO independent booleans (review A3) so "confirmed
 *      different" is never conflated with "couldn't check":
 *        - `priceChanged`      — both prices resolved AND they differ.
 *        - `priceUnverifiable` — the cycle or an exact-year ACTIVE
 *          catalogue row could not be resolved at all
 *          (`loadPlanFrozenFields(mode:'offer')` returning anything but
 *          `'found'`, or an orphaned draft with no stamped cycle — Task 7's
 *          "orphaned after commit" window). These two are mutually
 *          exclusive by construction.
 *   2. **Bill-year staleness** — review A1: the FIRST cut compared the
 *      printed `plan_year` against the coverage window's year, but that
 *      predicate is ALWAYS true for a 12-month term (the only term length
 *      the sole adapter produces — `plan-lookup-for-renewal-drizzle.ts:86`
 *      hardcodes `termMonths: 12`), so it discriminated nothing and would
 *      have trained the treasurer to ignore it. Redefined to compare the
 *      STORED `plan_year` against `deriveFiscalYear(now)` — the fiscal
 *      year that would actually print if this draft were issued TODAY.
 *      This is `false` for the common case (a draft viewed within the same
 *      fiscal year it was drafted in) and only `true` once a draft has sat
 *      in the queue long enough for the calendar to roll into a new fiscal
 *      year — genuinely informative, not noise. Needs no cycle at all
 *      (`row.planYear` lives on the invoice), so it is computable even for
 *      an orphaned draft.
 *   3. **Would-be-refused** — review A2: simulates ALL FOUR of
 *      `issueAutoDraftedRenewal`'s refusal reasons, in the SAME order the
 *      real guard evaluates them, so at most one is reported (matching
 *      what the treasurer would actually see on click):
 *        a. `plan_year_drift`   — HARD REQ #1: `cycle.periodFrom`'s
 *           derived fiscal year no longer matches the invoice's stored
 *           `plan_year` (a `reanchorPeriodInTx` moved the cycle after the
 *           draft was created). Needs the stamped cycle to resolve.
 *        b. `member_terminated` — the membership-access re-assert: the
 *           member's CURRENT latest cycle resolves to `terminated`
 *           (lapsed, or cancelled past coverage end) — e.g. the draft has
 *           sat in the queue long enough for grace to expire, which the
 *           staleness signal already primes the treasurer to expect.
 *           Independent of whether THIS draft's own cycle resolved.
 *        c. `member_erased` — the GDPR Art.17 / PDPA §33 gate. NOT
 *           redundant with (b): erasure leaves `status` and the renewal
 *           cycle untouched and stamps only `erased_at`, so an erased
 *           member's unexpired cycle still resolves `full` and (b) never
 *           fires. The row is deliberately SHOWN with this refusal rather
 *           than filtered out of the queue — the draft still exists, and
 *           Discard (the correct remedy) is a per-row action, so hiding
 *           the row would strand it with no operator affordance.
 *        d. `duplicate_live_bill` — HARD REQ #2: another COMMITTED membership
 *           §86/4 (`issued`/`paid`/`partially_credited`) already COVERS the
 *           charged NEXT-term window `[periodTo, periodTo + term)` — the same
 *           coverage-overlap discriminator the real guard uses after
 *           membership-coverage-exclude-guard (mig 0281) replaced the
 *           plan_year-coarse `findLiveMembershipBill`
 *           (`findOverlappingMembershipCoverageBill`, `domain/membership-bill-coverage.ts`).
 *           Drafts do not block (they carry no committed coverage), so sibling
 *           `origin='auto_renewal' status='draft'` rows and this row's own
 *           draft (excluded by id) never self-refuse — the routine double-draft
 *           case design §5.4 calls harmless. Member-scoped, NOT
 *           (member, planYear)-scoped: the anchored plan_year pin lags a full
 *           term behind the coverage a §86/4 charges.
 *      This is a best-effort PREDICTION for display, not the authoritative
 *      guard — a TOCTOU gap between viewing the queue and a future Task-14
 *      Issue click is expected and is closed by the real guard re-checking
 *      under the per-cycle lock at issue time. NOT modelled: the shape
 *      checks that can never fire for a row this query itself selected
 *      (`not_auto_renewal` / `not_draft`), `member_mismatch` (an exotic
 *      data-integrity anomaly), and `cycle_not_found` at issue time for an
 *      orphaned draft (already surfaced distinctly via
 *      `priceUnverifiable` — out of this task's explicit review scope).
 *
 * Batched (no N+1): ONE query for the cycles (keyed by
 * `auto_draft_invoice_id`), ONE query for the members' latest cycles
 * (dedup'd `memberId`s), ONE query for the members' membership coverage
 * (dedup'd `memberId`s, keyed by member), ONE query for the erased-member ids
 * (dedup'd `memberId`s), and the plan-catalogue lookup is deduplicated by
 * (planId, planYear) — a page of drafts sharing the same plan/year (the common
 * case) pays for exactly one catalogue read per unique pair, not one per row.
 *
 * NEVER throws / NEVER returns `err` from a resolvable failure. Only a
 * malformed INPUT shape (never expected from the page's own typed
 * row-VM) produces `err`.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import { parseThbDecimalToSatang } from '@/lib/money';
import { parseInput, type InvalidInputError } from './_lib/parse-input';
import { findOverlappingMembershipCoverageBill } from '../../domain/membership-bill-coverage';
import { deriveMembershipAccess, type RenewalCycle } from '../../domain/renewal-cycle';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export const loadAutoRenewalQueueContextInputSchema = z.object({
  tenantId: z.string().min(1),
  rows: z.array(
    z.object({
      invoiceId: z.string().min(1),
      memberId: z.string().min(1),
      planId: z.string().min(1),
      planYear: z.number().int(),
    }),
  ),
});

export type LoadAutoRenewalQueueContextInput = z.infer<
  typeof loadAutoRenewalQueueContextInputSchema
>;

export type LoadAutoRenewalQueueContextError = InvalidInputError;

export type LoadAutoRenewalQueueContextDeps = Pick<
  RenewalsDeps,
  'cyclesRepo' | 'planLookupForRenewal' | 'clock' | 'memberRenewalFlagsRepo'
>;

/** Why `issueAutoDraftedRenewal` would refuse this draft right now — first-match-wins, mirrors the real guard's evaluation order. */
export type AutoRenewalRefusalReason =
  | { readonly kind: 'plan_year_drift' }
  | { readonly kind: 'member_terminated'; readonly reason: string }
  | { readonly kind: 'member_erased' }
  | { readonly kind: 'duplicate_live_bill'; readonly conflictingInvoiceId: string };

/** Per-row decision context, keyed by `invoiceId` in the returned map. */
export interface AutoRenewalQueueRowMeta {
  /** `null` when no cycle was found stamped with this draft (orphan window). */
  readonly cycleId: string | null;

  // --- price (review A3: "confirmed different" vs "couldn't check", never conflated) ---
  readonly frozenPriceThb: string | null;
  /** `null` when unresolved — see `priceUnverifiable`. */
  readonly currentCataloguePriceThb: string | null;
  /** TRUE only when BOTH prices resolved AND differ in exact satang. */
  readonly priceChanged: boolean;
  /** TRUE when the cycle or an exact-year active catalogue row could not be resolved. Mutually exclusive with `priceChanged`. */
  readonly priceUnverifiable: boolean;

  // --- bill-year staleness (review A1: redefined vs today's fiscal year) ---
  /** `deriveFiscalYear(now)` — the year that would print if issued today. */
  readonly currentFiscalYear: number;
  readonly billYearStale: boolean;

  // --- would-be-refused (review A2: 4 reasons, first-match-wins) ---
  readonly refusalReason: AutoRenewalRefusalReason | null;
}

export type LoadAutoRenewalQueueContextOutput = ReadonlyMap<
  string,
  AutoRenewalQueueRowMeta
>;

export async function loadAutoRenewalQueueContext(
  deps: LoadAutoRenewalQueueContextDeps,
  rawInput: LoadAutoRenewalQueueContextInput,
): Promise<
  Result<LoadAutoRenewalQueueContextOutput, LoadAutoRenewalQueueContextError>
> {
  const inputResult = parseInput(loadAutoRenewalQueueContextInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const out = new Map<string, AutoRenewalQueueRowMeta>();
  if (input.rows.length === 0) return ok(out);

  const now = deps.clock.now();
  const currentFiscalYear = deriveFiscalYear(now.toISOString());

  const cyclesByInvoiceId = await deps.cyclesRepo.findCyclesByAutoDraftInvoiceIds(
    input.tenantId,
    input.rows.map((r) => r.invoiceId),
  );

  // Dedup (planId, planYear) catalogue lookups — many queue rows share the
  // same plan + year.
  const catalogueCache = new Map<
    string,
    Awaited<ReturnType<typeof deps.planLookupForRenewal.loadPlanFrozenFields>>
  >();
  async function loadCatalogue(planId: string, planYear: number) {
    const key = `${planId}::${planYear}`;
    const cached = catalogueCache.get(key);
    if (cached) return cached;
    const result = await deps.planLookupForRenewal.loadPlanFrozenFields({
      tenantId: input.tenantId,
      planId,
      fiscalYear: planYear,
      mode: 'offer',
    });
    catalogueCache.set(key, result);
    return result;
  }

  // Batched "member's current latest cycle" scan for the member_terminated
  // refusal reason — independent of whether THIS draft's own stamped cycle
  // resolved (a member can be terminated regardless of the queue row's
  // orphan status).
  const memberIds = [...new Set(input.rows.map((r) => r.memberId))];
  const latestCycles = await deps.cyclesRepo.findLatestCyclesForMembers(
    input.tenantId,
    memberIds,
  );
  const latestCycleByMember = new Map<string, RenewalCycle>();
  for (const c of latestCycles) latestCycleByMember.set(c.memberId, c);

  // Batched erasure probe for the `member_erased` refusal reason. Erasure
  // leaves `status` and the cycle alone, so `deriveMembershipAccess` still
  // returns `full` for an erased member — the `member_terminated` prediction
  // above provably does NOT cover this, exactly as in the real guard.
  const erasedMemberIds =
    await deps.memberRenewalFlagsRepo.findErasedMemberIds(memberIds);

  // Batched MEMBER-scoped coverage read for the duplicate_live_bill refusal
  // reason (mig 0281). Member-scoped (not (member, plan_year)) so the check
  // uses the SAME coverage-overlap discriminator as the real
  // issueAutoDraftedRenewal guard — a plan_year-keyed read would miss the
  // anchored bill whose plan_year lags the term it charges.
  const coverageByMember =
    await deps.cyclesRepo.listMembershipCoverageForMembers(input.tenantId, memberIds);

  for (const row of input.rows) {
    const cycle = cyclesByInvoiceId.get(row.invoiceId) ?? null;

    let frozenPriceThb: string | null = null;
    let currentCataloguePriceThb: string | null = null;
    let priceChanged = false;
    let priceUnverifiable: boolean;

    if (cycle === null) {
      // Orphan window (auto-draft-due-renewals.ts docstring) — no stamped
      // cycle, so the price cannot be verified. Distinct from "confirmed
      // unchanged" — fail toward MORE scrutiny, never a silent "looks fine".
      priceUnverifiable = true;
    } else {
      frozenPriceThb = cycle.frozenPlanPriceThb;
      const catalogue = await loadCatalogue(cycle.planIdAtCycleStart, row.planYear);
      if (catalogue.status === 'found') {
        currentCataloguePriceThb = catalogue.plan.priceTHB;
        priceChanged =
          parseThbDecimalToSatang(cycle.frozenPlanPriceThb) !==
          parseThbDecimalToSatang(catalogue.plan.priceTHB);
        priceUnverifiable = false;
      } else {
        // The plan is no longer offered / active for this EXACT
        // (planId, planYear) — cannot confirm the frozen price still
        // matches. Flag as unverifiable rather than assume it is correct.
        priceUnverifiable = true;
      }
    }

    // Bill-year staleness — needs only `row.planYear` + "now", so it is
    // computable even for an orphaned draft.
    const billYearStale = row.planYear !== currentFiscalYear;

    // --- would-be-refused, evaluated in the SAME order the real guard does ---
    let refusalReason: AutoRenewalRefusalReason | null = null;

    // (a) plan_year_drift — only checkable when the stamped cycle resolved.
    if (cycle !== null) {
      const planYearFromCycle = deriveFiscalYear(cycle.periodFrom);
      if (row.planYear !== planYearFromCycle) {
        refusalReason = { kind: 'plan_year_drift' };
      }
    }

    // (b) member_terminated — independent of this row's own cycle.
    if (refusalReason === null) {
      const latestCycle = latestCycleByMember.get(row.memberId) ?? null;
      const access = deriveMembershipAccess(latestCycle, now);
      if (access.access === 'terminated') {
        refusalReason = { kind: 'member_terminated', reason: access.reason };
      }
    }

    // (c) member_erased — GDPR Art.17 / PDPA §33. Evaluated AFTER
    // member_terminated and BEFORE duplicate_live_bill, matching the real
    // guard's order so at most one reason is reported and it is the one the
    // treasurer would actually hit on click.
    if (refusalReason === null && erasedMemberIds.has(row.memberId)) {
      refusalReason = { kind: 'member_erased' };
    }

    // (d) duplicate_live_bill — coverage-window overlap (mig 0281), matching
    // the real issueAutoDraftedRenewal guard (which stopped using the
    // plan_year-coarse `findLiveMembershipBill`). Only COMMITTED bills
    // (issued/paid/partially_credited) block — `findOverlappingMembershipCoverageBill`
    // excludes drafts by default, so sibling auto_renewal drafts and this
    // row's own draft (also excluded by id) never self-refuse. Needs the
    // stamped cycle to compute the charged NEXT-term window `[periodTo,
    // periodTo + term)`; an orphaned draft (cycle === null) fails earlier on
    // `cycle_not_found` at issue time — deliberately outside this modelled set
    // (see the head docstring), so it is left unrefused here.
    if (refusalReason === null && cycle !== null) {
      const wNew = {
        from: cycle.periodTo,
        to: addMonthsUtc(cycle.periodTo, cycle.frozenPlanTermMonths),
      };
      const conflict = findOverlappingMembershipCoverageBill(
        coverageByMember.get(row.memberId) ?? [],
        wNew,
        { excludeInvoiceId: row.invoiceId },
      );
      if (conflict) {
        refusalReason = {
          kind: 'duplicate_live_bill',
          conflictingInvoiceId: conflict.invoiceId,
        };
      }
    }

    out.set(row.invoiceId, {
      cycleId: cycle?.cycleId ?? null,
      frozenPriceThb,
      currentCataloguePriceThb,
      priceChanged,
      priceUnverifiable,
      currentFiscalYear,
      billYearStale,
      refusalReason,
    });
  }

  return ok(out);
}
