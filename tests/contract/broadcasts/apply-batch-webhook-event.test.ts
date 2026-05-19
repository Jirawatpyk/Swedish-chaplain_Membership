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
  readonly deps: unknown;
}

function makeStubDeps(opts: { incrementFails?: 'not_found' | 'storage_error' } = {}): StubDeps {
  const emits: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
  const increments: Array<{ field: string }> = [];

  return {
    emits,
    increments,
    deps: {
      batchManifests: {
        async incrementCounter(_t: unknown, _id: unknown, field: string) {
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
          return { ok: true, value: undefined };
        },
      },
      audit: {
        async emit(_tx: unknown, e: { eventType: string; payload?: Record<string, unknown> }) {
          emits.push(e);
        },
      },
      clock: { now: () => new Date('2026-06-15T05:00:00Z') },
    },
  };
}

const baseInput = {
  tenantId: 'test-tenant',
  batchManifestId: 'batch-1',
  batchIndex: 0,
  broadcastId: 'broadcast-1',
  recipientEmailHashed: 'hash123',
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
    // Phase 3F.7 F-23 fix — forensic audit emitted on the race-window path
    expect(emits.some((e) => e.eventType === 'broadcast_cross_tenant_probe')).toBe(true);
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
});
