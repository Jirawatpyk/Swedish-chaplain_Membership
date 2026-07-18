/**
 * 107-auto-invoice Task 13 — `loadAutoRenewalQueueContext`.
 *
 * READ-ONLY enrichment for the admin `/admin/invoices` review-queue view
 * (`origin='auto_renewal' AND status='draft'`). For each queued draft it
 * resolves the three pieces of "why is this row here / is it safe to
 * issue" context a treasurer needs before clicking Issue (Task 14 wires
 * the actions; this is display-only):
 *
 *   1. **Drift** — does the cycle's frozen §86/4 price still match the
 *      CURRENT active plan-catalogue price for (planId, planYear)? Compared
 *      in exact satang (never float) via `parseThbDecimalToSatang`. Any
 *      non-zero delta, OR an inability to resolve an exact-year ACTIVE
 *      catalogue row at all (`loadPlanFrozenFields(mode:'offer')` returning
 *      anything but `'found'`), flags drift — this surface fails toward
 *      MORE scrutiny, never a silent "looks unchanged".
 *   2. **Bill-year ≠ coverage-year** — the rolling-anchor billing model
 *      derives `plan_year` from the cycle's `periodFrom` (the CURRENT/
 *      ending period) while the coverage the bill actually GRANTS starts
 *      at `periodTo` (the NEXT period). When those two fall in different
 *      fiscal years (a cycle straddling a calendar-year edge) the bill
 *      "for 2026" can cover 2027 — expected under the design, but
 *      confusing without an explanation, so it must be surfaced, not
 *      hidden.
 *   3. **Would-be-refused** — simulates `issueAutoDraftedRenewal`'s HARD
 *      REQ #2 content guard (`_lib/live-membership-bill.ts`,
 *      `LIVE_MEMBERSHIP_BILL_STATUSES` + `findLiveMembershipBill`): does
 *      ANOTHER membership invoice already exist for (member, planYear) in
 *      a live state? Sibling `origin='auto_renewal' status='draft'` rows
 *      are excluded from the candidate set FIRST, mirroring the real
 *      guard's tx1 sequence (Critical-1 fix, Task 9 review round 2) where
 *      those siblings are discarded BEFORE the guard runs — counting them
 *      here would produce a false "refused" prediction. This is a
 *      best-effort PREDICTION for display, not the authoritative guard: a
 *      TOCTOU gap between viewing the queue and clicking Issue is expected
 *      and is closed by the real guard re-checking under the per-cycle
 *      lock at issue time.
 *
 * Batched (no N+1): ONE query for the cycles (keyed by
 * `auto_draft_invoice_id`), ONE query for the candidate live bills (keyed
 * by (memberId, planYear) pairs), and the plan-catalogue lookup is
 * deduplicated by (planId, planYear) — a page of drafts sharing the same
 * plan/year (the common case) pays for exactly one catalogue read per
 * unique pair, not one per row.
 *
 * NEVER throws / NEVER returns `err` from a resolvable failure — a row
 * whose cycle is missing (the Task 7 "orphaned after commit" window) is
 * NOT an error, it degrades to `driftFlagged: true` with null fields
 * (cannot verify anything without the cycle) so the treasurer still sees
 * an honest "needs a closer look" signal instead of the row silently
 * vanishing or crashing the list page. Only a malformed INPUT shape
 * (never expected from the page's own typed row-VM) produces `err`.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import { parseThbDecimalToSatang } from '@/lib/money';
import { parseInput, type InvalidInputError } from './_lib/parse-input';
import { findLiveMembershipBill } from './_lib/live-membership-bill';
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
  'cyclesRepo' | 'planLookupForRenewal'
>;

/** Per-row decision context, keyed by `invoiceId` in the returned map. */
export interface AutoRenewalQueueRowMeta {
  /** `null` when no cycle was found stamped with this draft (orphan window). */
  readonly cycleId: string | null;
  readonly frozenPriceThb: string | null;
  /** `null` when the catalogue lookup did not resolve to an active exact-year row. */
  readonly currentCataloguePriceThb: string | null;
  readonly driftFlagged: boolean;
  readonly coverageFromIso: string | null;
  readonly coverageToIso: string | null;
  readonly coverageYear: number | null;
  readonly billYearCoverageYearMismatch: boolean;
  readonly wouldBeRefused: boolean;
  /** The conflicting invoice's id, or `null` when `wouldBeRefused` is false. */
  readonly conflictingInvoiceId: string | null;
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

  // Batched candidate live-bill scan for the would-be-refused prediction.
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

  for (const row of input.rows) {
    const cycle = cyclesByInvoiceId.get(row.invoiceId) ?? null;

    let frozenPriceThb: string | null = null;
    let currentCataloguePriceThb: string | null = null;
    let driftFlagged: boolean;
    let coverageFromIso: string | null = null;
    let coverageToIso: string | null = null;
    let coverageYear: number | null = null;
    let billYearCoverageYearMismatch = false;

    if (cycle === null) {
      // Orphan window (auto-draft-due-renewals.ts docstring) — no stamped
      // cycle. Nothing here can be verified against its origin cycle;
      // fail toward MORE scrutiny rather than assume "unchanged".
      driftFlagged = true;
    } else {
      frozenPriceThb = cycle.frozenPlanPriceThb;
      const catalogue = await loadCatalogue(
        cycle.planIdAtCycleStart,
        row.planYear,
      );
      if (catalogue.status === 'found') {
        currentCataloguePriceThb = catalogue.plan.priceTHB;
        driftFlagged =
          parseThbDecimalToSatang(cycle.frozenPlanPriceThb) !==
          parseThbDecimalToSatang(catalogue.plan.priceTHB);
      } else {
        // The plan is no longer offered / active for this EXACT
        // (planId, planYear) — cannot confirm the frozen price still
        // matches. Flag rather than assume it is still correct.
        driftFlagged = true;
      }

      coverageFromIso = cycle.periodTo;
      coverageToIso = addMonthsUtc(cycle.periodTo, cycle.frozenPlanTermMonths);
      coverageYear = deriveFiscalYear(coverageFromIso);
      billYearCoverageYearMismatch = row.planYear !== coverageYear;
    }

    // Would-be-refused prediction — mirrors issueAutoDraftedRenewal's HARD
    // REQ #2 content guard. Sibling auto_renewal DRAFTS are excluded from
    // the candidate set first: the real guard's tx1 discards them BEFORE
    // the guard runs (Task 9 review Critical-1 fix), so counting them here
    // would produce a false "refused" prediction for the routine
    // double-draft case design §5.4 calls harmless.
    const key = `${row.memberId}::${row.planYear}`;
    const candidateBills = (billsByKey.get(key) ?? []).filter(
      (b) => !(b.origin === 'auto_renewal' && b.status === 'draft'),
    );
    const conflict = findLiveMembershipBill(candidateBills, row.invoiceId);

    out.set(row.invoiceId, {
      cycleId: cycle?.cycleId ?? null,
      frozenPriceThb,
      currentCataloguePriceThb,
      driftFlagged,
      coverageFromIso,
      coverageToIso,
      coverageYear,
      billYearCoverageYearMismatch,
      wouldBeRefused: conflict !== null,
      conflictingInvoiceId: conflict?.invoiceId ?? null,
    });
  }

  return ok(out);
}
