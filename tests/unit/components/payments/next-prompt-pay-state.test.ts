/**
 * Unit tests for `nextPromptPayStateOnPollFailure` — pure transition
 * helper extracted from `<PaySheetInternal>` so its `card_declined`
 * vs `canceled`/`3ds_timeout` routing can be tested without rendering
 * the full pay-sheet subtree.
 *
 * Behavior under test:
 *   - `card_declined` (issuer rejected the PromptPay charge) →
 *     transitions to `failure` state with the localized declined-by-
 *     bank reason. A blind "QR expired — Refresh" prompt would
 *     mislead the user into infinite retry.
 *   - `canceled` (user / system cancel) → transitions to `expired`
 *     so the Refresh CTA is the right next action.
 *   - `3ds_timeout` (5-min poll cap) → transitions to `expired`.
 */
import { describe, it, expect } from 'vitest';

import { nextPromptPayStateOnPollFailure } from '@/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-sheet-internal';

const DECLINED_MSG = 'Your card was declined.';

describe('nextPromptPayStateOnPollFailure', () => {
  it('card_declined → failure state with the supplied localized reason', () => {
    const next = nextPromptPayStateOnPollFailure('card_declined', DECLINED_MSG);
    expect(next.kind).toBe('failure');
    if (next.kind !== 'failure') return;
    expect(next.reason).toBe(DECLINED_MSG);
  });

  it('canceled → expired state', () => {
    const next = nextPromptPayStateOnPollFailure('canceled', DECLINED_MSG);
    expect(next.kind).toBe('expired');
  });

  it('3ds_timeout → expired state', () => {
    const next = nextPromptPayStateOnPollFailure('3ds_timeout', DECLINED_MSG);
    expect(next.kind).toBe('expired');
  });
});
