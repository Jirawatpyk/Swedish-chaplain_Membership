/**
 * membership-coverage-exclude-guard — the application-layer PRE-FLIGHT twin of
 * the DB `invoices_membership_coverage_no_overlap` EXCLUDE constraint (mig
 * 0281).
 *
 * Why a read-guard AND a DB constraint:
 *   - The three membership-mint paths (confirmRenewal, adminRenewLapsedMember,
 *     issueAutoDraftedRenewal) do side-effecting writes (the cycle lazy-flip +
 *     its `renewal_entered_awaiting_payment` audit) BEFORE the F4 mint. If the
 *     ONLY guard were the DB constraint, a duplicate would fail at mint time —
 *     AFTER those writes committed — leaving a refused confirm that still
 *     flipped the cycle and emitted an untrue audit row (the "New-3" hazard).
 *     So a pre-flight refusal that runs ABOVE the first write is required.
 *   - The DB constraint remains the AUTHORITY: it is orphan-safe, path-agnostic
 *     and closes the read-decide-write concurrency race the read-guard cannot
 *     (two mints that both pass the read before either commits).
 *
 * Correctness (vs the two rejected read-guard designs): those approximated a
 * bill's coverage from its cycle window / plan_year and were refuted by
 * red-team (anchored-lag double-bill, migrated-cohort false refusal). This guard
 * reads the TRUE charged window PERSISTED on `invoices.coverage_from/to`
 * (mig 0281), so it does NOT approximate. Its blocking rule is byte-identical to
 * the DB `blocks_coverage` generated column + the half-open `tstzrange('[)')`
 * overlap, so the guard and the constraint can never disagree:
 *   - blocks iff status ∈ {issued, paid, partially_credited} — a COMMITTED
 *     membership document. `void` + fully-credited never block (the refunded
 *     period is re-billable). `draft` does NOT block: multiple provisional
 *     drafts for the same period legitimately coexist (an auto-draft plus a
 *     member-confirm draft, sibling auto-drafts awaiting the discard sweep);
 *     the barrier is the ISSUE (a draft that BECOMES issued/paid then blocks,
 *     and a concurrent double-issue is caught by the DB EXCLUDE). The
 *     auto-draft cron's own {draft,issued} dedup (Task 7) still prevents
 *     duplicate DRAFTS — that is a separate layer from this coverage guard.
 *   - a NULL coverage window never participates (legacy/first-payment/erased) —
 *     exactly matching the constraint's `WHERE (blocks_coverage)` predicate.
 */

/** The blocking status set — MUST mirror `blocks_coverage` in mig 0281. */
const BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  'issued',
  'paid',
  'partially_credited',
]);

export interface MembershipBillCoverageRow {
  readonly invoiceId: string;
  readonly status: string;
  /** ISO-8601, or null for from_payment / legacy-unbackfilled / event bills. */
  readonly coverageFrom: string | null;
  readonly coverageTo: string | null;
}

export interface CoverageWindow {
  readonly from: string;
  readonly to: string;
}

/**
 * The first EXISTING membership bill whose live coverage OVERLAPS `wNew`, or
 * `null` when the new bill's window is free to mint. Half-open `[from, to)` so
 * adjacent terms (…-01-01 → …-01-01) do NOT count as overlapping — identical to
 * the constraint's `tstzrange(coverage_from, coverage_to, '[)')`.
 *
 * @param excludeInvoiceId the caller's OWN draft (the queue-issue path passes
 *   its draft id; the create-then-issue paths have nothing to exclude).
 */
export function findOverlappingMembershipCoverageBill(
  bills: ReadonlyArray<MembershipBillCoverageRow>,
  wNew: CoverageWindow,
  opts?: { readonly excludeInvoiceId?: string; readonly includeDrafts?: boolean },
): MembershipBillCoverageRow | null {
  const newFrom = Date.parse(wNew.from);
  const newTo = Date.parse(wNew.to);
  for (const bill of bills) {
    if (opts?.excludeInvoiceId !== undefined && bill.invoiceId === opts.excludeInvoiceId) {
      continue;
    }
    // COMMITTED bills (issued/paid/partially_credited) always block — the same
    // set as the DB `blocks_coverage`. A `draft` blocks ONLY when the caller
    // opts in (`includeDrafts`): the CREATE-then-ISSUE paths (confirmRenewal,
    // adminRenewLapsedMember) refuse when a pending auto-draft already claims
    // the period, but the ISSUE path (issueAutoDraftedRenewal) must NOT block
    // on sibling drafts — it issues ONE and the discard-sweep clears the rest.
    // Money-safety never depends on draft-blocking: the DB EXCLUDE on committed
    // rows rejects any concurrent double-ISSUE regardless.
    const blocks =
      BLOCKING_STATUSES.has(bill.status) ||
      (opts?.includeDrafts === true && bill.status === 'draft');
    if (!blocks) continue;
    if (bill.coverageFrom === null || bill.coverageTo === null) continue;
    const billFrom = Date.parse(bill.coverageFrom);
    const billTo = Date.parse(bill.coverageTo);
    if (billFrom < newTo && newFrom < billTo) return bill;
  }
  return null;
}
