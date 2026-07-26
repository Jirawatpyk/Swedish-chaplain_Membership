/**
 * membership-coverage-exclude-guard — the application-layer PRE-FLIGHT twin of
 * the DB `invoices_membership_coverage_no_overlap` EXCLUDE constraint (mig
 * 0281).
 *
 * Why a read-guard AND a DB constraint:
 *   - The create-then-issue mint paths (confirmRenewal, adminRenewLapsedMember)
 *     do side-effecting writes BEFORE the F4 mint — confirmRenewal flips the
 *     cycle to `awaiting_payment` and emits `renewal_entered_awaiting_payment`
 *     ahead of the bill. If the ONLY guard were the DB constraint, a duplicate
 *     would fail at mint time — AFTER those writes committed — leaving a refused
 *     confirm that still flipped the cycle and emitted an untrue audit row (the
 *     "New-3" hazard). So a pre-flight refusal that runs ABOVE the first write
 *     is required on those paths. (issueAutoDraftedRenewal is the ISSUE path: it
 *     emits no `renewal_entered_awaiting_payment`, its cycle flip happens in tx2
 *     AFTER the mint, and its only pre-mint write is the sibling-draft discard;
 *     it still runs this guard above that discard for symmetry + to avoid a
 *     wasted mint.)
 *   - The DB constraint remains the AUTHORITY: it is orphan-safe, path-agnostic
 *     and closes the read-decide-write concurrency race the read-guard cannot
 *     (two mints that both pass the read before either commits, or a
 *     void-on-reissue reactivation of a same-period bill). A 23P01 from the
 *     EXCLUDE at mint time is mapped to the typed `invoice_already_issued`
 *     (issue-invoice.ts) so the caller sees a 409, not a raw 500.
 *
 * Correctness (vs the two rejected read-guard designs): those approximated a
 * bill's coverage from its cycle window / plan_year and were refuted by
 * red-team (anchored-lag double-bill, migrated-cohort false refusal). This guard
 * reads the TRUE charged window PERSISTED on `invoices.coverage_from/to`
 * (mig 0281), so it does NOT approximate. Its blocking rule is identical to the
 * DB `blocks_coverage` generated column ON COMMITTED ROWS + the half-open
 * `tstzrange('[)')` overlap, so the guard and the constraint agree on every
 * committed bill; the app guard may ADDITIONALLY refuse drafts on the
 * create-then-issue paths (`includeDrafts`, see below) — a deliberate,
 * one-directional strictness, never a disagreement that would let a committed
 * double-bill through:
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

/**
 * The six `invoice_status` values, redefined locally — Domain must NOT import
 * F4's `InvoiceStatus` (Principle III forbids a cross-context Domain import).
 * Identical to the sibling `MembershipInvoiceRef.status` union and the DB enum.
 */
export type InvoiceStatusLiteral =
  | 'draft'
  | 'issued'
  | 'paid'
  | 'void'
  | 'partially_credited'
  | 'credited';

/**
 * The blocking status set — MUST mirror `blocks_coverage` in mig 0281 AND the
 * Drizzle generated-column SQL in `schema-invoices.ts`. Those three
 * representations are pinned to one oracle by the live-Neon parity assertion in
 * `tests/integration/invoicing/membership-coverage-exclude.test.ts` (one row per
 * enum value → `blocks_coverage` must equal `BLOCKING_STATUSES.has(status)`), so
 * a drift in any one of them fails a test rather than silently letting the app
 * guard and the DB constraint disagree. Typed against `InvoiceStatusLiteral` so
 * a typo (`'issed'`) cannot compile.
 */
const BLOCKING_STATUSES: ReadonlySet<InvoiceStatusLiteral> = new Set([
  'issued',
  'paid',
  'partially_credited',
]);

export interface CoverageWindow {
  /** ISO-8601 UTC. */
  readonly from: string;
  /** ISO-8601 UTC. */
  readonly to: string;
}

export interface MembershipBillCoverageRow {
  readonly invoiceId: string;
  readonly status: InvoiceStatusLiteral;
  /**
   * The charged window, or `null` for from_payment / legacy-unbackfilled /
   * event bills. Collapsed into a single `CoverageWindow | null` so the DB
   * CHECK `invoices_coverage_window_wellformed` (both-or-neither) is expressed
   * at the type level — an illegal half-set `{from, null}` is unrepresentable.
   */
  readonly coverage: CoverageWindow | null;
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
  // Fail LOUD on a malformed window. `Date.parse` returns NaN for a bad string
  // and every comparison with NaN is false → "no overlap" → a silent
  // under-block (the UNSAFE direction — it would let a double-bill through).
  // Callers pass server-derived ISO today, so this only trips on a future bug.
  if (Number.isNaN(newFrom) || Number.isNaN(newTo)) {
    throw new Error(
      `findOverlappingMembershipCoverageBill: malformed coverage window [${wNew.from}, ${wNew.to})`,
    );
  }
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
    if (bill.coverage === null) continue;
    const billFrom = Date.parse(bill.coverage.from);
    const billTo = Date.parse(bill.coverage.to);
    if (billFrom < newTo && newFrom < billTo) return bill;
  }
  return null;
}
