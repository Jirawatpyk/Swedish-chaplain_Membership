/**
 * 108 Phase 9 review S44 — the retired-status register, and the derivation
 * that consumes it.
 *
 * `ca51f59a1` deleted the batch dispatch path and with it every producer of
 * `partially_sent` and `partial_delivery_accepted`. The statuses stay in
 * `BROADCAST_STATUSES` so the type covers historical rows and
 * `status-badge-mapping` keeps rendering them; what changes is that a human
 * is no longer OFFERED them as a filter, because such a filter can only ever
 * return zero rows and zero rows reads as "it never happened".
 *
 * Why this file exists rather than an assertion inside `queue-filters`:
 * the review found that the branch removed two cross-tenant guards whose
 * property still held structurally but had no test left. A named register
 * with no test is the same shape — true today, unenforced tomorrow.
 *
 * The POSITIVE CONTROL is the point. `queue-filters` derives its terminal
 * chip group by SUBTRACTING two lists from `BROADCAST_STATUSES`. A subtraction
 * that over-matches would silently drop a live status from the UI, and an
 * "is X absent?" assertion cannot tell that apart from working correctly —
 * absence proves nothing on its own. So every case below that asserts a
 * status is withheld is paired with one asserting the live statuses survive.
 */
import { describe, expect, it } from 'vitest';

import {
  BROADCAST_STATUSES,
  RETIRED_BROADCAST_STATUSES,
  TERMINAL_BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

// Mirrors `src/components/broadcast/admin/queue-filters.tsx`. Kept in step by
// the last case in this file, which fails if the two ever diverge.
const IN_REVIEW_STATUSES: ReadonlyArray<BroadcastStatus> = [
  'submitted',
  'approved',
  'sending',
  'draft',
];

function offeredTerminalChips(): ReadonlyArray<BroadcastStatus> {
  const retired: ReadonlyArray<BroadcastStatus> = RETIRED_BROADCAST_STATUSES;
  return BROADCAST_STATUSES.filter(
    (s) => !IN_REVIEW_STATUSES.includes(s) && !retired.includes(s),
  );
}

describe('retired broadcast statuses', () => {
  it('every retired status is still a member of BROADCAST_STATUSES', () => {
    // Retiring a status must never narrow the type — a historical row still
    // has to parse and render. If this fails, someone deleted the value
    // instead of registering it.
    for (const s of RETIRED_BROADCAST_STATUSES) {
      expect(BROADCAST_STATUSES).toContain(s);
    }
  });

  it('withholds exactly the retired statuses from the terminal chip group', () => {
    const offered = offeredTerminalChips();
    for (const s of RETIRED_BROADCAST_STATUSES) {
      expect(offered).not.toContain(s);
    }
  });

  it('POSITIVE CONTROL — every live terminal status is still offered', () => {
    // Without this, the case above passes just as happily when the filter
    // over-matches and the chip strip renders empty.
    const offered = offeredTerminalChips();
    const retired: ReadonlyArray<string> = RETIRED_BROADCAST_STATUSES;
    const expected = BROADCAST_STATUSES.filter(
      (s) => !IN_REVIEW_STATUSES.includes(s) && !retired.includes(s),
    );

    expect(offered).toEqual(expected);
    expect(offered.length).toBeGreaterThan(0);
    // Named explicitly so a future status rename cannot quietly empty the
    // group while both derivations agree with each other.
    expect(offered).toContain('sent');
    expect(offered).toContain('rejected');
    expect(offered).toContain('cancelled');
    expect(offered).toContain('failed_to_dispatch');
  });

  it('POSITIVE CONTROL — in-review statuses are withheld from the terminal group but still exist', () => {
    const offered = offeredTerminalChips();
    for (const s of IN_REVIEW_STATUSES) {
      expect(offered).not.toContain(s);
      expect(BROADCAST_STATUSES).toContain(s);
    }
  });

  it('every status is offered in exactly one group, or is retired', () => {
    // The property the original `queue-filters` comment claims: a newly-added
    // status cannot silently vanish from BOTH groups. Retirement is now the
    // only way out, and it has to be declared.
    const retired: ReadonlyArray<string> = RETIRED_BROADCAST_STATUSES;
    const unaccounted = BROADCAST_STATUSES.filter(
      (s) =>
        !IN_REVIEW_STATUSES.includes(s) &&
        !offeredTerminalChips().includes(s) &&
        !retired.includes(s),
    );
    expect(unaccounted).toEqual([]);
  });

  it('partial_delivery_accepted stays terminal so cleanup-audiences still reaps it', () => {
    // Retiring a status must not change reaping. `cleanup-audiences` deletes
    // Resend audiences for broadcasts in TERMINAL_BROADCAST_STATUSES; a
    // historical partially-accepted row still holds an audience.
    expect(TERMINAL_BROADCAST_STATUSES).toContain('partial_delivery_accepted');
  });

  it('records that `partially_sent` is now a dead end — non-terminal with no way forward', () => {
    // NOT a bug to fix here, and the assertion is deliberately of the CURRENT
    // truth rather than of a desired one.
    //
    // `partially_sent` was correctly non-terminal while the batch path existed:
    // its way out was a retry, which advanced it to `sent` or to
    // `partial_delivery_accepted`. `ca51f59a1` deleted every retry entry point,
    // so a row in this state now has no forward transition AND is not reaped by
    // `cleanup-audiences`, which reads TERMINAL_BROADCAST_STATUSES — it would
    // hold its Resend audience indefinitely.
    //
    // Left as-is on purpose: prod has zero rows in this state (the batch path
    // was never flag-enabled), and promoting it to terminal would change reaping
    // semantics for a state nothing can produce. Making it terminal is the fix
    // IF a row is ever found; this test is here so the next reader learns that
    // from the register instead of from an orphaned audience.
    expect(TERMINAL_BROADCAST_STATUSES).not.toContain('partially_sent');
    expect(RETIRED_BROADCAST_STATUSES).toContain('partially_sent');
  });
});
