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
 * rows and its would-be-refused prediction missed two of
 * `issueAutoDraftedRenewal`'s three refusal reasons.
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
 *   3. **Would-be-refused** — review A2: simulates ALL THREE of
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
 *        c. `duplicate_live_bill` — HARD REQ #2: another membership
 *           invoice already exists for (member, planYear) in a live
 *           state (`LIVE_MEMBERSHIP_BILL_STATUSES` via
 *           `findLiveMembershipBill`, `_lib/live-membership-bill.ts`).
 *           Sibling `origin='auto_renewal' status='draft'` rows are
 *           excluded from the candidate set FIRST, mirroring the real
 *           guard's tx1 sequence (Task 9 review Critical-1 fix, where
 *           those siblings are discarded BEFORE the guard runs) —
 *           counting them here would produce a false "refused" for the
 *           routine double-draft case design §5.4 calls harmless.
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
 * (dedup'd `memberId`s), ONE query for the candidate live bills (dedup'd
 * (memberId, planYear) pairs), and the plan-catalogue lookup is
 * deduplicated by (planId, planYear) — a page of drafts sharing the same
 * plan/year (the common case) pays for exactly one catalogue read per
 * unique pair, not one per row.
 *
 * NEVER throws / NEVER returns `err` from a resolvable failure. Only a
 * malformed INPUT shape (never expected from the page's own typed
 * row-VM) produces `err`.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { parseThbDecimalToSatang } from '@/lib/money';
import { parseInput, type InvalidInputError } from './_lib/parse-input';
import { findLiveMembershipBill } from './_lib/live-membership-bill';
import { deriveMembershipAccess, type RenewalCycle } from '../../domain/renewal-cycle';
import type { MembershipInvoiceRef } from '../ports/renewal-cycle-repo';
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
  'cyclesRepo' | 'planLookupForRenewal' | 'clock'
>;

/** Why `issueAutoDraftedRenewal` would refuse this draft right now — first-match-wins, mirrors the real guard's evaluation order. */
export type AutoRenewalRefusalReason =
  | { readonly kind: 'plan_year_drift' }
  | { readonly kind: 'member_terminated'; readonly reason: string }
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

  // --- would-be-refused (review A2: 3 reasons, first-match-wins) ---
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

  // Batched candidate live-bill scan for the duplicate_live_bill refusal reason.
  const dedupedPairs = new Map<string, { readonly memberId: string; readonly planYear: number }>();
  for (const row of input.rows) {
    dedupedPairs.set(`${row.memberId}::${row.planYear}`, {
      memberId: row.memberId,
      planYear: row.planYear,
    });
  }
  const membershipBills =
    await deps.cyclesRepo.listMembershipInvoicesForPlanYearPairs(
      input.tenantId,
      [...dedupedPairs.values()],
    );
  const billsByKey = new Map<string, MembershipInvoiceRef[]>();
  for (const bill of membershipBills) {
    const key = `${bill.memberId}::${bill.planYear}`;
    const bucket = billsByKey.get(key);
    if (bucket) bucket.push(bill);
    else billsByKey.set(key, [bill]);
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

    // (c) duplicate_live_bill — sibling auto_renewal drafts excluded first
    // (mirrors the real guard's discard-before-check sequence).
    if (refusalReason === null) {
      const key = `${row.memberId}::${row.planYear}`;
      const candidateBills = (billsByKey.get(key) ?? []).filter(
        (b) => !(b.origin === 'auto_renewal' && b.status === 'draft'),
      );
      const conflict = findLiveMembershipBill(candidateBills, row.invoiceId);
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
