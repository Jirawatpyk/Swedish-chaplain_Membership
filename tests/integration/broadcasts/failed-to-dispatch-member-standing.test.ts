/**
 * Spec 140 s3 review round 2 (R2-E, security LOW) — the outbox dispatcher reads
 * `context_data.memberStanding` of a `broadcast_failed_to_dispatch_notification`
 * row as a POSITIVE literal: only the exact string `'held'` selects the
 * suspended-member paragraph (R1-E). `context_data` is jsonb, so any other value
 * (another string, the wrong case, an object) must fall back to the normal
 * `reassurance` copy, never to the held one.
 *
 * Live Neon outbox, real route; the Resend sender is mocked (captures the text).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { NextRequest } from 'next/server';

const sent: Array<{ to: string; text: string }> = [];
vi.mock('@/modules/auth/infrastructure/email/resend-client', () => ({
  emailSender: {
    send: vi.fn(async (message: { to: string; text: string }) => {
      sent.push(message);
      return { ok: true, value: { messageId: `msg-${sent.length}` } };
    }),
  },
}));

import { db } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { GET as outboxDispatch } from '@/app/api/cron/outbox-dispatch/route';
import enMessages from '@/i18n/messages/en.json';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const copy = enMessages.email.broadcastFailedToDispatch;

let tenant: TestTenant;
const run = randomUUID().slice(0, 8);
const cases: ReadonlyArray<{ readonly label: string; readonly standing: unknown }> = [
  { label: 'held', standing: 'held' },
  { label: 'erased', standing: 'erased' },
  { label: 'upper', standing: 'HELD' },
  { label: 'object', standing: {} },
];
const toEmail = (label: string) => `r2e-${label}-${run}@example.com`;

async function tick(): Promise<void> {
  const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
    method: 'GET',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  const res = await outboxDispatch(req);
  expect(res.status).toBe(200);
}

describe('outbox-dispatch — broadcast_failed_to_dispatch_notification memberStanding (140 s3 R2-E)', () => {
  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    await db.insert(notificationsOutbox).values(
      cases.map((c) => ({
        tenantId: tenant.ctx.slug,
        notificationType: 'broadcast_failed_to_dispatch_notification' as const,
        toEmail: toEmail(c.label),
        locale: 'en',
        contextData: {
          broadcastId: randomUUID(),
          broadcastSubject: `R2-E ${c.label}`,
          tenantDisplayName: 'R2-E Chamber',
          scheduledFor: '2026-11-05T03:00:00.000Z',
          reason: 'provider_cancelled',
          memberStanding: c.standing,
        },
        status: 'pending' as const,
      })),
    );
  });

  afterAll(async () => {
    await db
      .delete(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, tenant.ctx.slug),
          inArray(notificationsOutbox.toEmail, cases.map((c) => toEmail(c.label))),
        ),
      )
      .catch(() => {});
    await tenant.cleanup().catch(() => {});
  });

  it("only the exact 'held' selects the suspended paragraph; 'erased', 'HELD' and {} get the normal reassurance", async () => {
    // The shared dev outbox carries other suites' rows: tick until all of ours are sent (bounded).
    for (let i = 0; i < 8 && cases.some((c) => !sent.some((m) => m.to === toEmail(c.label))); i += 1) {
      await tick();
    }
    const textFor = (label: string) => sent.find((m) => m.to === toEmail(label))?.text;

    // Positive control: the held row does render the held paragraph.
    expect(textFor('held')).toContain(copy.reassuranceHeld);
    for (const label of ['erased', 'upper', 'object']) {
      const text = textFor(label);
      expect(text, `${label} row was sent`).toBeDefined();
      expect(text).toContain(copy.reassurance);
      expect(text).not.toContain(copy.reassuranceHeld);
    }
  });
});
