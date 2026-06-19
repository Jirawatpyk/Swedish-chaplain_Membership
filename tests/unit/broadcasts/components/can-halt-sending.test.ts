// tests/unit/broadcasts/components/can-halt-sending.test.ts
/**
 * DV-12 follow-up review #6 — unit coverage for the admin "Halt sending" gate.
 *
 * The page-RSC inlined this decision (untested). Extracted to a pure helper so
 * every show/hide branch — including fail-safe-to-hidden on a batch-load
 * failure, "no pending batches", and non-`sending` states — is pinned here.
 */
import { describe, it, expect } from 'vitest';
import { canHaltSending } from '@/components/broadcast/admin/can-halt-sending';

const pending = { status: 'pending' as const };
const sendingBatch = { status: 'sending' as const };
const sent = { status: 'sent' as const };

describe('canHaltSending', () => {
  it('true: sending + ≥1 pending batch + load ok', () => {
    expect(canHaltSending('sending', false, [sent, pending])).toBe(true);
  });

  it('false: sending but NO pending batch (all already dispatched)', () => {
    expect(canHaltSending('sending', false, [sendingBatch, sent])).toBe(false);
  });

  it('false: sending + pending batch but batch load FAILED (fail-safe to hidden)', () => {
    expect(canHaltSending('sending', true, [pending])).toBe(false);
  });

  it('false: sending with NO batches (non-split single-audience send)', () => {
    expect(canHaltSending('sending', false, [])).toBe(false);
  });

  it('false: approved (pre-send — handled by the Cancel action, not Halt)', () => {
    expect(canHaltSending('approved', false, [pending])).toBe(false);
  });

  it('false: submitted', () => {
    expect(canHaltSending('submitted', false, [pending])).toBe(false);
  });

  it('false: non-sending states (draft / sent / rejected / failed_to_dispatch / cancelled / partially_sent)', () => {
    for (const s of [
      'draft',
      'sent',
      'rejected',
      'failed_to_dispatch',
      'cancelled',
      'partially_sent',
    ] as const) {
      expect(canHaltSending(s, false, [pending])).toBe(false);
    }
  });
});
