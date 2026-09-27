/**
 * Spec 122 US3 (`Portal-timeline` board) — timeline rows name what they are
 * about: an invoice row its document number, a payment row its method and the
 * invoice it paid, an event row the event's name, an E-Blast row its subject.
 *
 * `member_timeline_v` carries only ids for the non-audit sources, so the repo
 * resolves them in one batched lookup per source on the tenant transaction.
 * The db layer is faked: each `tx.execute` is answered by the table its SQL
 * reads, so the test pins the enrichment, not the query order.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();
const INVOICE_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const BROADCAST_ID = '33333333-3333-4333-8333-333333333333';

const PAGE = [
  { ref_id: INVOICE_ID, occurred_at_iso: '2026-09-15 01:00:00+00', source: 'invoice', actor_kind: 'staff', payload: { status: 'issued', invoice_id: INVOICE_ID } },
  { ref_id: 'pay_01', occurred_at_iso: '2026-09-14 01:00:00+00', source: 'payment', actor_kind: 'system', payload: { status: 'succeeded', amount_satang: '3852000' } },
  { ref_id: 'reg-1', occurred_at_iso: '2026-09-05 12:00:00+00', source: 'event', actor_kind: 'member', payload: { event_id: EVENT_ID, counted_against_cultural_quota: false } },
  { ref_id: BROADCAST_ID, occurred_at_iso: '2026-07-03 02:00:00+00', source: 'broadcast', actor_kind: 'member', payload: { broadcast_id: BROADCAST_ID, status: 'sent' } },
];

const seen: string[] = [];
const executeMock = vi.fn(async (query: SQL) => {
  const { sql } = dialect.sqlToQuery(query);
  seen.push(sql);
  if (sql.includes('count(*)')) return [{ n: PAGE.length }];
  if (sql.includes('FROM member_timeline_v')) return PAGE;
  if (sql.includes('FROM payments')) return [{ id: 'pay_01', method: 'promptpay', document_number: 'SC-2026-000123' }];
  if (sql.includes('FROM invoices')) return [{ id: INVOICE_ID, document_number: 'SC-2026-000123' }];
  if (sql.includes('FROM events')) return [{ id: EVENT_ID, name: 'Crayfish Party 2026' }];
  if (sql.includes('FROM broadcasts')) return [{ id: BROADCAST_ID, subject: 'New office on Wireless Road' }];
  throw new Error(`unexpected query: ${sql}`);
});

vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ execute: executeMock }),
  db: {},
}));
vi.mock('@/lib/metrics', () => ({ insightsMetrics: { timelineQueryDurationMs: vi.fn() } }));

import { drizzleTimelineRepo } from '@/modules/members/infrastructure/timeline/drizzle-timeline-repo';
import type { TenantContext } from '@/modules/tenants';

describe('drizzleTimelineRepo — row references (spec 122 US3)', () => {
  it('adds the document number, payment method, event name and E-Blast subject', async () => {
    const r = await drizzleTimelineRepo.listByMember({ slug: 'swecham' } as unknown as TenantContext, {
      memberId: '00000000-0000-4000-8000-000000000001',
      limit: 50,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [invoice, payment, event, broadcast] = r.value.events;
    expect(invoice?.payload).toMatchObject({ document_number: 'SC-2026-000123' });
    expect(payment?.payload).toMatchObject({ payment_method: 'promptpay', document_number: 'SC-2026-000123' });
    expect(event?.payload).toMatchObject({ event_name: 'Crayfish Party 2026' });
    expect(broadcast?.payload).toMatchObject({ broadcast_subject: 'New office on Wireless Road' });
  });

  it('scopes every lookup to the tenant as well as RLS (Principle I second wall)', () => {
    const lookups = seen.filter((s) => /FROM (invoices|payments|events|broadcasts)/.test(s));
    expect(lookups).toHaveLength(4);
    for (const s of lookups) expect(s).toMatch(/tenant_id = \$\d+/);
  });
});
