/**
 * F5 2026-05-17 polish — unit coverage for `_shared.ts` webhook
 * helpers. The 3 functions deduplicate audit-emit + markProcessed
 * patterns across confirm/fail/handle-cancel-event use-cases, so
 * a regression here cascades into 3 downstream use-cases.
 *
 * Covers:
 *   - markProcessedIfPresent — 4 deps×input branches (skip/call)
 *   - emitWebhookUnknownIntent — payload + retention contract
 *   - emitTerminalStateAck — both mismatch-kind summaries +
 *     extraPayload spread
 */
import { describe, expect, it, vi } from 'vitest';
import {
  markProcessedIfPresent,
  emitWebhookUnknownIntent,
  emitTerminalStateAck,
} from '@/modules/payments/application/use-cases/_shared';
import type {
  AuditPort,
  ProcessorEventsRepo,
} from '@/modules/payments/application/ports';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments/domain/system-actors';

describe('markProcessedIfPresent — atomic webhook processor_events bookkeeping', () => {
  it('calls processorEventsRepo.markProcessed when both deps + input present', async () => {
    const markProcessed = vi.fn().mockResolvedValue(undefined);
    const repo = { markProcessed } as unknown as ProcessorEventsRepo;
    const tx = { __tx: true };
    await markProcessedIfPresent(
      { processorEventsRepo: repo },
      { processorEventId: 'evt_test' },
      tx,
    );
    expect(markProcessed).toHaveBeenCalledTimes(1);
    expect(markProcessed).toHaveBeenCalledWith(tx, 'evt_test');
  });

  it('is a silent no-op when processorEventsRepo dep is missing', async () => {
    await expect(
      markProcessedIfPresent({}, { processorEventId: 'evt_test' }, {}),
    ).resolves.toBeUndefined();
  });

  it('is a silent no-op when processorEventId input is missing', async () => {
    const markProcessed = vi.fn();
    const repo = { markProcessed } as unknown as ProcessorEventsRepo;
    await markProcessedIfPresent(
      { processorEventsRepo: repo },
      {},
      {},
    );
    expect(markProcessed).not.toHaveBeenCalled();
  });

  it('is a silent no-op when BOTH deps + input missing', async () => {
    await expect(markProcessedIfPresent({}, {}, {})).resolves.toBeUndefined();
  });

  it('propagates the repo error if markProcessed throws', async () => {
    const repo = {
      markProcessed: vi.fn().mockRejectedValue(new Error('tx aborted')),
    } as unknown as ProcessorEventsRepo;
    await expect(
      markProcessedIfPresent(
        { processorEventsRepo: repo },
        { processorEventId: 'evt_test' },
        {},
      ),
    ).rejects.toThrow('tx aborted');
  });
});

describe('emitWebhookUnknownIntent — best-effort audit for orphan webhook', () => {
  it('emits with tx=null + canonical event_type + retention', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    const audit = { emit } as unknown as AuditPort;
    await emitWebhookUnknownIntent(
      audit,
      {
        tenantId: 'swecham',
        requestId: 'req_x',
        paymentIntentId: 'pi_orphan',
        eventCreatedAtUnixSeconds: 1_700_000_000,
      },
      'payment_intent.payment_failed',
    );
    expect(emit).toHaveBeenCalledTimes(1);
    const [tx, entry] = emit.mock.calls[0]!;
    expect(tx).toBeNull();
    expect(entry.eventType).toBe('webhook_unknown_intent');
    expect(entry.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK);
    expect(entry.summary).toContain('payment_intent.payment_failed');
    expect(entry.summary).toContain('pi_orphan');
    expect(entry.payload).toMatchObject({
      processor_payment_intent_id: 'pi_orphan',
      event_type: 'payment_intent.payment_failed',
      event_created_at_unix_seconds: 1_700_000_000,
    });
    expect(typeof entry.retentionYears).toBe('number');
  });

  it('accepts null tenantId (pre-resolution probe path)', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await emitWebhookUnknownIntent(
      { emit } as unknown as AuditPort,
      {
        tenantId: null,
        requestId: null,
        paymentIntentId: 'pi_x',
        eventCreatedAtUnixSeconds: 0,
      },
      'payment_intent.canceled',
    );
    const [, entry] = emit.mock.calls[0]!;
    expect(entry.tenantId).toBeNull();
    expect(entry.requestId).toBeNull();
  });

  it('uses the supplied eventType in summary for canceled events', async () => {
    const emit = vi.fn().mockResolvedValue(undefined);
    await emitWebhookUnknownIntent(
      { emit } as unknown as AuditPort,
      {
        tenantId: 't',
        requestId: 'r',
        paymentIntentId: 'pi_cancel',
        eventCreatedAtUnixSeconds: 1,
      },
      'payment_intent.canceled',
    );
    const [, entry] = emit.mock.calls[0]!;
    expect(entry.summary).toContain('payment_intent.canceled');
  });
});

describe('emitTerminalStateAck — forensic audit on illegal-transition / invariant-violation', () => {
  function makeAudit() {
    const emit = vi.fn().mockResolvedValue(undefined);
    const audit = { emit } as unknown as AuditPort;
    return { audit, emit };
  }

  it('writes payment_acknowledged_terminal_state with illegal_transition summary', async () => {
    const { audit, emit } = makeAudit();
    await emitTerminalStateAck(audit, {
      tenantId: 'swecham',
      requestId: 'req_a',
      useCaseLabel: 'failPayment',
      paymentIntentId: 'pi_x',
      paymentId: 'pay_x',
      fromStatus: 'succeeded',
      toStatus: 'failed',
      mismatchKind: 'illegal_transition',
    });
    const [tx, entry] = emit.mock.calls[0]!;
    expect(tx).toBeNull();
    expect(entry.eventType).toBe('payment_acknowledged_terminal_state');
    expect(entry.summary).toContain('failPayment');
    expect(entry.summary).toContain('illegal_transition from succeeded');
    expect(entry.summary).toContain('acknowledged + no-op');
    expect(entry.payload).toMatchObject({
      payment_intent_id: 'pi_x',
      payment_id: 'pay_x',
      from_status: 'succeeded',
      to_status: 'failed',
      mismatch_kind: 'illegal_transition',
    });
  });

  it('writes payment_acknowledged_terminal_state with invariant_violation_duplicate_succeeded summary', async () => {
    const { audit, emit } = makeAudit();
    await emitTerminalStateAck(audit, {
      tenantId: 'swecham',
      requestId: null,
      useCaseLabel: 'confirmPayment',
      paymentIntentId: 'pi_x',
      paymentId: 'pay_x',
      fromStatus: 'pending',
      toStatus: 'succeeded',
      mismatchKind: 'invariant_violation_duplicate_succeeded',
    });
    const [, entry] = emit.mock.calls[0]!;
    expect(entry.summary).toContain('invariant_violation_duplicate_succeeded');
    expect(entry.summary).not.toContain('illegal_transition from');
  });

  it('spreads extraPayload into the audit payload (e.g. invoice_id)', async () => {
    const { audit, emit } = makeAudit();
    await emitTerminalStateAck(audit, {
      tenantId: 'swecham',
      requestId: 'r',
      useCaseLabel: 'handleCancelEvent',
      paymentIntentId: 'pi_x',
      paymentId: 'pay_x',
      fromStatus: 'succeeded',
      toStatus: 'canceled',
      mismatchKind: 'illegal_transition',
      extraPayload: { invoice_id: 'inv_99', custom_field: 42 },
    });
    const [, entry] = emit.mock.calls[0]!;
    expect(entry.payload).toMatchObject({
      payment_intent_id: 'pi_x',
      payment_id: 'pay_x',
      mismatch_kind: 'illegal_transition',
      invoice_id: 'inv_99',
      custom_field: 42,
    });
  });

  it('handles undefined extraPayload gracefully (omitted = empty spread)', async () => {
    const { audit, emit } = makeAudit();
    await emitTerminalStateAck(audit, {
      tenantId: 't',
      requestId: 'r',
      useCaseLabel: 'confirmPayment',
      paymentIntentId: 'pi_x',
      paymentId: 'pay_x',
      fromStatus: 'pending',
      toStatus: 'succeeded',
      mismatchKind: 'invariant_violation_duplicate_succeeded',
    });
    const [, entry] = emit.mock.calls[0]!;
    // Just the 5 baseline keys, no extra
    expect(Object.keys(entry.payload).sort()).toEqual(
      [
        'from_status',
        'mismatch_kind',
        'payment_id',
        'payment_intent_id',
        'to_status',
      ].sort(),
    );
  });

  it('always emits with tx=null (best-effort, survives caller rollback)', async () => {
    const { audit, emit } = makeAudit();
    await emitTerminalStateAck(audit, {
      tenantId: 'swecham',
      requestId: 'r',
      useCaseLabel: 'failPayment',
      paymentIntentId: 'pi_x',
      paymentId: 'pay_x',
      fromStatus: 'succeeded',
      toStatus: 'failed',
      mismatchKind: 'illegal_transition',
    });
    const [tx] = emit.mock.calls[0]!;
    expect(tx).toBeNull();
  });
});
