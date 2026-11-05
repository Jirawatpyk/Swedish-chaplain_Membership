/**
 * Spec 140 s2d (#736c) — a broadcasts log line carries an error as its class
 * (`errKind`) and SQLSTATE (`pgErrorCode`), never the error object or its
 * message. drizzle-orm's `DrizzleQueryError` has enumerable `query` and
 * `params`, and a webhook's statements bind the recipient's email.
 *
 * Representative sites: the webhook's uncaught arm (it logged
 * `{ message, name }`) and its member-lookup arm (it logged `e.message`).
 * `_safe-audit-emit` and the L1 / L2 cells are pinned in their own files.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logger';
import { processWebhookEvent, type ProcessWebhookEventDeps } from '@/modules/broadcasts/application/use-cases/process-webhook-event';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { asTenantContext } from '@/modules/tenants';

const EMAIL = 'ann@example.com';
const tenant = asTenantContext('test-tenant');
const broadcastId = asBroadcastId('33333333-3333-3333-3333-333333333333');

function leakyDbError(): DrizzleQueryError {
  const pg = Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
  return new DrizzleQueryError('insert into broadcast_deliveries (recipient_email_lower) values ($1)', [EMAIL], pg);
}

function fieldsOf(level: 'error' | 'warn', msg: string): Record<string, unknown> {
  const calls = vi.mocked(logger[level]).mock.calls.filter((c) => c[1] === msg);
  expect(calls, `one ${level} line "${msg}"`).toHaveLength(1);
  return calls[0]![0] as Record<string, unknown>;
}

function expectNoErrorText(fields: Record<string, unknown>): void {
  expect(JSON.stringify(fields)).not.toMatch(/ann@example\.com|Failed query|broadcast_deliveries|"params"|"query"|"message"/);
}

const event = {
  id: 'evt-736c',
  type: 'email.delivered',
  createdAt: '2026-11-04T00:00:00.000Z',
  data: { recipientEmail: EMAIL, status: 'delivered' },
} as never;

beforeEach(() => vi.clearAllMocks());

describe('the webhook path — processWebhookEvent uncaught arm', () => {
  it('logs the class and the SQLSTATE, not the message', async () => {
    const deps = {
      tenant,
      broadcastsRepo: {
        withTx: vi.fn(async () => {
          throw leakyDbError();
        }),
      },
      deliveriesRepo: {},
      marketingUnsubscribes: {},
      membersBridge: {},
      audit: {},
      clock: { now: () => new Date('2026-11-04T00:00:00.000Z') },
    } as unknown as ProcessWebhookEventDeps;

    const r = await processWebhookEvent(deps, { event, broadcastId } as never);

    expect(r.ok).toBe(false);
    const fields = fieldsOf('error', 'broadcasts.process_webhook.uncaught');
    expect(fields).toEqual({
      err: 'DrizzleQueryError',
      code: '40001',
      tenantId: 'test-tenant',
      broadcastId,
      eventId: 'evt-736c',
    });
    expectNoErrorText(fields);
  });
});
