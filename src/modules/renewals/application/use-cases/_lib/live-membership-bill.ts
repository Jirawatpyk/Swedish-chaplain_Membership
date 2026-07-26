/**
 * `LIVE_MEMBERSHIP_BILL_STATUSES` — the set of invoice statuses that count as a
 * "live" membership §86/4 for LINK-HYGIENE, NOT for the coverage dup-guard.
 *
 * History: this file also held `findLiveMembershipBill`, a plan_year-coarse
 * duplicate-bill predicate used by all three mint paths. The
 * membership-coverage-exclude-guard (mig 0281) replaced that predicate with the
 * period-aware `findOverlappingMembershipCoverageBill`
 * (`domain/membership-bill-coverage.ts`, blocking on the NARROWER
 * `BLOCKING_STATUSES` = {issued, paid, partially_credited}), so the function was
 * removed. Only the status SET remains, for a different concern:
 *
 *   - `confirmRenewal` (`confirm-renewal.ts`) checks whether a cycle's stale
 *     `linked_invoice_id` still points at a live bill before re-linking — link
 *     hygiene. It deliberately uses this BROADER set (incl. `draft`/`credited`)
 *     because a draft or credited bill is still a real link target to preserve,
 *     which is a distinct question from "does a committed bill already cover
 *     this period" (the coverage guard's narrower set).
 *
 * ## Why each status is in (or out) — for the LINK-HYGIENE meaning of "live":
 *
 * `draft` — IN. A draft is the outstanding CLAIM on a §87 number about to be
 * minted; a cycle legitimately links to it.
 *
 * `issued` / `paid` / `partially_credited` / `credited` — IN. All are real,
 * numbered tax documents a cycle can point at.
 *
 * `void` — OUT. A voided document is precisely the one a cycle should stop
 * linking to; nothing else clears `linked_invoice_id` on void, so treating it
 * as "not live" lets the next renewal re-link cleanly.
 */

export const LIVE_MEMBERSHIP_BILL_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'issued',
  'paid',
  'partially_credited',
  'credited',
]);
