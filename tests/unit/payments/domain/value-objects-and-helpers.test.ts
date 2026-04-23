/**
 * Value-object + aggregate-helper coverage for the F5 Domain layer.
 *
 * Covers the pure helpers exported by:
 *   - payment.ts            (asPaymentId, parsePaymentId, isTerminalPaymentStatus)
 *   - value-objects/payment-method.ts (parsePaymentMethod, isCard, isPromptPay)
 *   - processor-event.ts    (isTenantBindable)
 *   - tenant-payment-settings.ts (assertSettingsComplete,
 *                                isMethodEnabled, isPublishableKeyConsistent)
 *
 * Paired with `payment-state-machine.test.ts` and
 * `one-succeeded-payment-per-invoice.test.ts`, this completes the 100%
 * line/branch coverage assertion on `src/modules/payments/domain/**`
 * set by T053 (vitest.config.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  asPaymentId,
  parsePaymentId,
  isTerminalPaymentStatus,
  assertCardMetadataComplete,
  PAYMENT_STATUSES,
  TERMINAL_PAYMENT_STATUSES,
  type Payment,
} from '@/modules/payments/domain/payment';
import {
  parsePaymentMethod,
  isCard,
  isPromptPay,
  PAYMENT_METHODS,
} from '@/modules/payments/domain/value-objects/payment-method';
import {
  isTenantBindable,
  PROCESSOR_EVENT_OUTCOMES,
} from '@/modules/payments/domain/processor-event';
import {
  assertSettingsComplete,
  isMethodEnabled,
  isPublishableKeyConsistent,
  type TenantPaymentSettings,
} from '@/modules/payments/domain/tenant-payment-settings';

// ---------------------------------------------------------------------------
// payment.ts
// ---------------------------------------------------------------------------

describe('payment — id brand + status helpers', () => {
  it('asPaymentId performs an unchecked cast (trusted-input path)', () => {
    const id = asPaymentId('pmt_01JABC');
    expect(id).toBe('pmt_01JABC');
  });

  it('parsePaymentId accepts a ULID-shaped id', () => {
    const r = parsePaymentId('pmt_01HZABCDE1234567890');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.value).toBe('pmt_01HZABCDE1234567890');
  });

  it('parsePaymentId rejects too-short strings', () => {
    const r = parsePaymentId('short');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('invalid_payment_id');
    expect(r.error.raw).toBe('short');
  });

  it('parsePaymentId rejects forbidden characters', () => {
    const r = parsePaymentId('pmt_with spaces inside which is too long blah');
    expect(r.ok).toBe(false);
  });

  it('isTerminalPaymentStatus matches TERMINAL_PAYMENT_STATUSES set', () => {
    for (const s of PAYMENT_STATUSES) {
      const expected = (TERMINAL_PAYMENT_STATUSES as readonly string[]).includes(s);
      expect(isTerminalPaymentStatus(s)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// value-objects/payment-method.ts
// ---------------------------------------------------------------------------

describe('payment-method value object', () => {
  it('parsePaymentMethod accepts every canonical method', () => {
    for (const m of PAYMENT_METHODS) {
      const r = parsePaymentMethod(m);
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('unreachable');
      expect(r.value).toBe(m);
    }
  });

  it('parsePaymentMethod rejects unknown strings with typed error', () => {
    const r = parsePaymentMethod('bitcoin');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.kind).toBe('invalid_payment_method');
    expect(r.error.raw).toBe('bitcoin');
  });

  it('parsePaymentMethod rejects empty string', () => {
    expect(parsePaymentMethod('').ok).toBe(false);
  });

  it('isCard narrows card and rejects promptpay', () => {
    expect(isCard('card')).toBe(true);
    expect(isCard('promptpay')).toBe(false);
  });

  it('isPromptPay narrows promptpay and rejects card', () => {
    expect(isPromptPay('promptpay')).toBe(true);
    expect(isPromptPay('card')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// processor-event.ts
// ---------------------------------------------------------------------------

describe('processor-event — tenant-bindability invariant', () => {
  it('rejected_signature is NEVER tenant-bindable', () => {
    expect(isTenantBindable('rejected_signature')).toBe(false);
  });

  it('every non-rejected_signature outcome is tenant-bindable', () => {
    for (const o of PROCESSOR_EVENT_OUTCOMES) {
      const expected = o !== 'rejected_signature';
      expect(isTenantBindable(o)).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// tenant-payment-settings.ts
// ---------------------------------------------------------------------------

const COMPLETE: TenantPaymentSettings = {
  tenantId: 'ten-1',
  processor: 'stripe',
  processorEnvironment: 'test',
  processorAccountId: 'acct_test_abc',
  processorPublishableKey: 'pk_test_xyz',
  enabledMethods: ['card', 'promptpay'],
  onlinePaymentEnabled: true,
  autoEmailOnPayment: true,
  promptpayQrExpirySeconds: 900,
  allowAnonymousPaylink: false,
};

describe('tenant-payment-settings — assertSettingsComplete', () => {
  it('ok on a fully-populated row', () => {
    expect(assertSettingsComplete(COMPLETE).ok).toBe(true);
  });

  it('err online_payment_disabled when global flag is false', () => {
    const r = assertSettingsComplete({ ...COMPLETE, onlinePaymentEnabled: false });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('online_payment_disabled');
  });

  it('err missing_processor_account_id when empty', () => {
    const r = assertSettingsComplete({ ...COMPLETE, processorAccountId: '' });
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('missing_processor_account_id');
  });

  it('err missing_publishable_key when empty', () => {
    const r = assertSettingsComplete({ ...COMPLETE, processorPublishableKey: '' });
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('missing_publishable_key');
  });

  it('err no_enabled_methods when enabledMethods is empty', () => {
    const r = assertSettingsComplete({ ...COMPLETE, enabledMethods: [] });
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('no_enabled_methods');
  });
});

describe('tenant-payment-settings — isMethodEnabled', () => {
  it('returns true for every method in enabledMethods', () => {
    expect(isMethodEnabled(COMPLETE, 'card')).toBe(true);
    expect(isMethodEnabled(COMPLETE, 'promptpay')).toBe(true);
  });

  it('returns false when method is not in enabledMethods', () => {
    const cardOnly: TenantPaymentSettings = { ...COMPLETE, enabledMethods: ['card'] };
    expect(isMethodEnabled(cardOnly, 'promptpay')).toBe(false);
  });
});

describe('tenant-payment-settings — isPublishableKeyConsistent', () => {
  it('live env + pk_live_… → consistent', () => {
    expect(
      isPublishableKeyConsistent({
        ...COMPLETE,
        processorEnvironment: 'live',
        processorPublishableKey: 'pk_live_123',
      }),
    ).toBe(true);
  });

  it('live env + pk_test_… → inconsistent', () => {
    expect(
      isPublishableKeyConsistent({
        ...COMPLETE,
        processorEnvironment: 'live',
        processorPublishableKey: 'pk_test_123',
      }),
    ).toBe(false);
  });

  it('test env + pk_test_… → consistent', () => {
    expect(isPublishableKeyConsistent(COMPLETE)).toBe(true);
  });

  it('test env + pk_live_… → inconsistent', () => {
    expect(
      isPublishableKeyConsistent({ ...COMPLETE, processorPublishableKey: 'pk_live_abc' }),
    ).toBe(false);
  });

  it('empty key never consistent', () => {
    expect(
      isPublishableKeyConsistent({ ...COMPLETE, processorPublishableKey: '' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// system-actors.ts + rbac-policy.ts defensive-branch coverage
// (kept in this file so the 100%-line threshold for the F5 Domain layer
// is satisfied by a single pass of `pnpm test tests/unit/payments`).
// ---------------------------------------------------------------------------

import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments/domain/system-actors';
import {
  isAllowed,
  type F5Action,
  type F5Resource,
} from '@/modules/payments/domain/rbac-policy';

describe('system-actors — reserved UUID stability', () => {
  it('SYSTEM_ACTOR_STRIPE_WEBHOOK is the frozen reserved-range UUID', () => {
    expect(SYSTEM_ACTOR_STRIPE_WEBHOOK).toBe(
      '00000000-0000-0000-0000-0000000f5001',
    );
  });
});

// ---------------------------------------------------------------------------
// assertCardMetadataComplete (reliability-guardian F-03)
// ---------------------------------------------------------------------------

function makePayment(overrides: Partial<Payment>): Payment {
  const base: Payment = {
    id: asPaymentId('pmt_01JABCDEFGHIJKLMNOP'),
    tenantId: 'ten-1',
    invoiceId: '00000000-0000-0000-0000-000000000001',
    memberId: '00000000-0000-0000-0000-000000000002',
    method: 'card',
    status: 'pending',
    amountSatang: 5_350_000n,
    currency: 'THB',
    processorPaymentIntentId: 'pi_test_1',
    processorChargeId: null,
    processorEnvironment: 'test',
    attemptSeq: 1,
    card: null,
    failureReasonCode: null,
    initiatedAt: new Date('2026-05-12T00:00:00Z'),
    completedAt: null,
    actorUserId: '00000000-0000-0000-0000-000000000003',
    correlationId: 'corr-1',
  };
  return { ...base, ...overrides };
}

describe('assertCardMetadataComplete — DB CHECK mirror', () => {
  it('ok on pending card with NULL card metadata (DB CHECK relaxed for pending)', () => {
    expect(assertCardMetadataComplete(makePayment({ status: 'pending' })).ok).toBe(true);
  });

  it('err card_metadata_missing on succeeded card with NULL card', () => {
    const r = assertCardMetadataComplete(makePayment({ status: 'succeeded', card: null }));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('card_metadata_missing_on_non_pending');
  });

  it('ok on succeeded card with full metadata', () => {
    const r = assertCardMetadataComplete(
      makePayment({
        status: 'succeeded',
        card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('ok on promptpay with NULL card (expected)', () => {
    expect(
      assertCardMetadataComplete(makePayment({ method: 'promptpay', card: null })).ok,
    ).toBe(true);
  });

  it('err when promptpay carries card metadata (invariant violation)', () => {
    const r = assertCardMetadataComplete(
      makePayment({
        method: 'promptpay',
        card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 },
      }),
    );
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('card_metadata_set_on_promptpay');
  });
});

// ---------------------------------------------------------------------------
// one-succeeded-per-invoice — self-inclusion false-positive (F-02)
// ---------------------------------------------------------------------------

import { enforceOneSucceededPerInvoice } from '@/modules/payments/domain/invariants/one-succeeded-payment-per-invoice';

describe('one-succeeded-per-invoice — self-inclusion warning (F-02)', () => {
  it('self-inclusion of the row being transitioned causes a false-positive violation', () => {
    // Simulates caller bug: passing the row being transitioned to
    // succeeded (which is itself already in lineage because the tx
    // just updated it) instead of excluding by payment_id. Domain cannot
    // detect this — the contract documented in JSDoc must be honoured
    // by the repository layer (SELECT excludes the current payment_id).
    const r = enforceOneSucceededPerInvoice(['succeeded']);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error.existingSucceededCount).toBe(1);
    // If callers don't exclude self, every retry fails here — this
    // test is the canary that would catch the bug class via coverage
    // inspection when the Application layer lands.
  });
});

// ---------------------------------------------------------------------------
// assertSettingsComplete — key_environment_mismatch (F-04)
// ---------------------------------------------------------------------------

describe('assertSettingsComplete — env/key mismatch (F-04)', () => {
  it('err key_environment_mismatch when pk_live_ rides test env', () => {
    const r = assertSettingsComplete({
      ...COMPLETE,
      processorEnvironment: 'test',
      processorPublishableKey: 'pk_live_abc',
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('key_environment_mismatch');
  });

  it('err key_environment_mismatch when pk_test_ rides live env', () => {
    const r = assertSettingsComplete({
      ...COMPLETE,
      processorEnvironment: 'live',
      processorPublishableKey: 'pk_test_xyz',
    });
    if (r.ok) throw new Error('unreachable');
    expect(r.reason).toBe('key_environment_mismatch');
  });
});

describe('rbac-policy — fails-closed on unknown combinations', () => {
  it('unknown resource returns false (line 130 guard)', () => {
    // Cast to bypass TS guard — we're testing defensive runtime behaviour.
    const r = isAllowed(
      'admin',
      'unknown-resource' as unknown as F5Resource,
      'read-list',
    );
    expect(r).toBe(false);
  });

  it('unknown action on a known resource returns false (line 132 guard)', () => {
    const r = isAllowed(
      'admin',
      'payments',
      'unknown-action' as unknown as F5Action,
    );
    expect(r).toBe(false);
  });
});
