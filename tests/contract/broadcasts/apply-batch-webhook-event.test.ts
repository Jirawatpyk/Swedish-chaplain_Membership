/**
 * Phase 3F.5 (2026-05-19) — Contract test for `applyBatchWebhookEvent`
 * (T057). Closes pr-test-analyzer Finding 3: the use case was mocked
 * in the webhook contract test but never had a dedicated `it` block
 * exercising it. A typo mapping `delivered → boundedCount` would
 * have shipped undetected.
 *
 * Covers: (a) parametrised per-event mapping (delivered/bounced/
 * complained/unsubscribed → correct counter field); (b) BATCH_NOT_FOUND
 * mapping + forensic audit emit; (c) audit payload shape.
 */
import { describe, expect, it } from 'vitest';
import { applyBatchWebhookEvent } from '@/modules/broadcasts/application/use-cases/apply-batch-webhook-event';
import type { BatchWebhookEventType } from '@/modules/broadcasts/application/use-cases/apply-batch-webhook-event';

interface StubDeps {
  readonly emits: Array<{ eventType: string; payload?: Record<string, unknown> }>;
  readonly increments: Array<{ field: string }>;
  readonly suppressions: Array<{ reason: string; emailLower: string }>;
  readonly deps: unknown;
}

function makeStubDeps(
  opts: {
    incrementFails?: 'not_found' | 'storage_error';
    duplicate?: boolean;
    suppressionWasNew?: boolean;
    suppressionThrows?: boolean;
  } = {},
): StubDeps {
  const emits: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
  const increments: Array<{ field: string }> = [];
  const suppressions: Array<{ reason: string; emailLower: string }> = [];

  return {
    emits,
    increments,
    suppressions,
    deps: {
      batchManifests: {
        async incrementCounter(
          _t: unknown,
          _id: unknown,
          field: string,
          _resendEventId: string,
        ) {
          increments.push({ field });
          if (opts.incrementFails === 'not_found') {
            return { ok: false, error: { kind: 'not_found' as const } };
          }
          if (opts.incrementFails === 'storage_error') {
            return {
              ok: false,
              error: { kind: 'storage_error' as const, detail: 'simulated' },
            };
          }
          return { ok: true, value: { duplicate: opts.duplicate ?? false } };
        },
      },
      audit: {
        async emit(_tx: unknown, e: { eventType: string; payload?: Record<string, unknown> }) {
          emits.push(e);
        },
      },
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
      // Bug #10 (code-review) — batch path suppresses recipients.
      marketingUnsubscribes: {
        async upsertStandalone(input: { reason: string; emailLower: string }) {
          suppressions.push({ reason: input.reason, emailLower: input.emailLower });
          if (opts.suppressionThrows) {
            throw new Error('simulated suppression upsert failure');
          }
          return {
            wasNew: opts.suppressionWasNew ?? true,
            suppression: {} as unknown,
          };
        },
      },
    },
  };
}

const baseInput = {
  tenantId: 'test-tenant',
  batchManifestId: 'batch-1',
  batchIndex: 0,
  broadcastId: '11111111-1111-1111-1111-111111111111',
  recipientEmailHashed: 'hash123',
  recipientEmailLower: 'recipient@example.com',
  resendEventId: 'evt-1',
};

describe('applyBatchWebhookEvent contract (Phase 3F.5)', () => {
  it.each([
    ['delivered', 'deliveredCount'],
    ['bounced', 'bouncedCount'],
    ['complained', 'complainedCount'],
    ['unsubscribed', 'unsubscribedCount'],
  ] as Array<[BatchWebhookEventType, string]>)(
    'event %s → increments %s counter field',
    async (eventType, expectedField) => {
      const { deps, increments } = makeStubDeps();
      const result = await applyBatchWebhookEvent(deps as never, {
        ...baseInput,
        eventType,
      });
      expect(result.ok).toBe(true);
      expect(increments).toHaveLength(1);
      expect(increments[0]?.field).toBe(expectedField);
    },
  );

  it('audit payload includes batchManifestId, batchIndex, eventType, resendEventId', async () => {
    const { deps, emits } = makeStubDeps();
    await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'delivered',
    });
    const auditEvent = emits.find((e) => e.eventType === 'broadcast_delivery_recorded');
    expect(auditEvent).toBeDefined();
    expect(auditEvent?.payload?.['batchManifestId']).toBe('batch-1');
    expect(auditEvent?.payload?.['batchIndex']).toBe(0);
    expect(auditEvent?.payload?.['eventType']).toBe('delivered');
    expect(auditEvent?.payload?.['resendEventId']).toBe('evt-1');
  });

  it('incrementCounter returns not_found → BATCH_NOT_FOUND error + forensic audit', async () => {
    const { deps, emits } = makeStubDeps({ incrementFails: 'not_found' });
    const result = await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'delivered',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('BATCH_NOT_FOUND');
    // Phase 3F.11.3 (M3 — Round 2 fix) — operational-forensic event
    // `broadcast_webhook_batch_missing` (split from security-forensic
    // `broadcast_cross_tenant_probe` which now only covers admin/member-
    // actor probes, not webhook races).
    expect(emits.some((e) => e.eventType === 'broadcast_webhook_batch_missing')).toBe(true);
  });

  // Phase 3F.11.12 (Round 3 Gap 4) — verify the forensic audit emits
  // for ALL 4 event types, not just `delivered`. If a future regression
  // adds a per-event-type branch around the audit emit, a non-delivered
  // event might skip the forensic trail silently. Parametrise.
  it.each([
    ['bounced', 'broadcast_webhook_batch_missing'],
    ['complained', 'broadcast_webhook_batch_missing'],
    ['unsubscribed', 'broadcast_webhook_batch_missing'],
  ] as Array<[BatchWebhookEventType, string]>)(
    'incrementCounter not_found on %s event → forensic audit %s still emitted',
    async (eventType, expectedAuditType) => {
      const { deps, emits } = makeStubDeps({ incrementFails: 'not_found' });
      const result = await applyBatchWebhookEvent(deps as never, {
        ...baseInput,
        eventType,
      });
      expect(result.ok).toBe(false);
      expect(emits.some((e) => e.eventType === expectedAuditType)).toBe(true);
      // Forensic payload retains the event-type discriminator so ops
      // can correlate which Resend event triggered the missing batch.
      const auditEvent = emits.find(
        (e) => e.eventType === expectedAuditType,
      );
      expect(auditEvent?.payload?.['resendEventType']).toBe(eventType);
    },
  );

  it('duplicate (Resend redelivery) short-circuits — ok, no second audit (F7-SF-1)', async () => {
    const { deps, emits } = makeStubDeps({ duplicate: true });
    const result = await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'delivered',
    });
    expect(result.ok).toBe(true);
    // The replay must NOT emit a second broadcast_delivery_recorded row —
    // the counter was already bumped + audited on the first delivery.
    expect(
      emits.some((e) => e.eventType === 'broadcast_delivery_recorded'),
    ).toBe(false);
  });

  it('incrementCounter storage_error → server_error (no double-emit)', async () => {
    const { deps, emits } = makeStubDeps({ incrementFails: 'storage_error' });
    const result = await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'delivered',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe('apply_batch_webhook.server_error');
    // server_error path doesn't emit any audit
    expect(emits).toHaveLength(0);
  });

  // Bug #10 (code-review) — the batch path must ALSO suppress recipients, not
  // just count them (previously multi-batch unsubscribers/bouncers stayed
  // re-emailable, violating FR-027/FR-030).
  it('unsubscribed → suppresses recipient (recipient_initiated) + suppression audit', async () => {
    const { deps, suppressions, emits } = makeStubDeps();
    const result = await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'unsubscribed',
    });
    expect(result.ok).toBe(true);
    expect(suppressions).toEqual([
      { reason: 'recipient_initiated', emailLower: 'recipient@example.com' },
    ]);
    expect(
      emits.some((e) => e.eventType === 'broadcast_suppression_applied'),
    ).toBe(true);
  });

  it('complained → suppresses recipient (complaint)', async () => {
    const { deps, suppressions } = makeStubDeps();
    await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'complained',
    });
    expect(suppressions.map((s) => s.reason)).toEqual(['complaint']);
  });

  it('bounced + bounceType hard → suppresses recipient (hard_bounce)', async () => {
    const { deps, suppressions } = makeStubDeps();
    await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'bounced',
      bounceType: 'hard',
    });
    expect(suppressions.map((s) => s.reason)).toEqual(['hard_bounce']);
  });

  it('bounced + bounceType soft → does NOT suppress (transient)', async () => {
    const { deps, suppressions } = makeStubDeps();
    await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'bounced',
      bounceType: 'soft',
    });
    expect(suppressions).toHaveLength(0);
  });

  it('delivered → does NOT suppress', async () => {
    const { deps, suppressions } = makeStubDeps();
    await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'delivered',
    });
    expect(suppressions).toHaveLength(0);
  });

  // Bug #1-6 (re-review) — suppression runs BEFORE the counter's idempotency
  // ledger commits, so a Svix replay DOES re-run the (idempotent) suppression
  // upsert. That is intentional: it makes suppression RECOVERABLE — if the
  // first attempt's upsert failed transiently, the ledger row was never
  // written, so the retry re-runs both. On a genuine replay the ON CONFLICT
  // makes the re-run a no-op (wasNew=false → no duplicate audit) and the
  // counter short-circuits on `duplicate`.
  it('duplicate (replayed) unsubscribed → re-runs idempotent suppression, no duplicate audit', async () => {
    const { deps, suppressions, emits } = makeStubDeps({
      duplicate: true,
      suppressionWasNew: false, // row already exists from the first delivery
    });
    const result = await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'unsubscribed',
    });
    expect(result.ok).toBe(true);
    // The upsert is attempted again (idempotent), but produces no new row…
    expect(suppressions).toHaveLength(1);
    // …so no duplicate suppression audit, and no duplicate delivery audit.
    expect(
      emits.some((e) => e.eventType === 'broadcast_suppression_applied'),
    ).toBe(false);
    expect(
      emits.some((e) => e.eventType === 'broadcast_delivery_recorded'),
    ).toBe(false);
  });

  // Bug #1-6 (re-review, HIGH) — recoverability guarantee. A transient
  // suppression-upsert failure MUST fail loud (server_error → webhook 5xx →
  // Svix retries) and MUST NOT increment the counter (which would commit the
  // idempotency ledger and make the retry short-circuit, permanently losing
  // the FR-027/FR-030 write).
  it('suppression upsert throws → server_error AND counter NOT incremented (recoverable)', async () => {
    const { deps, increments, emits } = makeStubDeps({ suppressionThrows: true });
    const result = await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'complained',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect((result.error as { kind: string }).kind).toBe(
      'apply_batch_webhook.server_error',
    );
    // The counter must not have run — the ledger stays unwritten so the retry
    // re-runs both the suppression and the increment.
    expect(increments).toHaveLength(0);
    // No delivery/suppression audit on the fail-loud path.
    expect(emits).toHaveLength(0);
  });

  // Bug #7 (re-review) — the Resend diagnostic (SMTP 550 / complaint note) is
  // threaded into the suppression `reason_text` for parity with the MVP path.
  it('errorMessage threaded into suppression reason_text', async () => {
    const captured: Array<{ reasonText: unknown }> = [];
    const { deps } = makeStubDeps();
    // Wrap the stub to capture reasonText (StubDeps only records reason+email).
    const wrapped = deps as {
      marketingUnsubscribes: {
        upsertStandalone: (i: { reasonText: unknown }) => Promise<unknown>;
      };
    };
    const orig = wrapped.marketingUnsubscribes.upsertStandalone;
    wrapped.marketingUnsubscribes.upsertStandalone = async (i: {
      reasonText: unknown;
    }) => {
      captured.push({ reasonText: i.reasonText });
      return orig(i as never);
    };
    await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'bounced',
      bounceType: 'hard',
      errorMessage: 'smtp; 550 5.1.1 mailbox unavailable',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.reasonText).toBe('smtp; 550 5.1.1 mailbox unavailable');
  });

  it('suppression on an already-suppressed recipient (wasNew=false) → no duplicate suppression audit', async () => {
    const { deps, emits } = makeStubDeps({ suppressionWasNew: false });
    await applyBatchWebhookEvent(deps as never, {
      ...baseInput,
      eventType: 'complained',
    });
    expect(
      emits.some((e) => e.eventType === 'broadcast_suppression_applied'),
    ).toBe(false);
  });
});
