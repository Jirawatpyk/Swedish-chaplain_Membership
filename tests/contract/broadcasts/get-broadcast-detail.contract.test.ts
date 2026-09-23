/**
 * F119 T141 (US6-AS2, FR-049) — `GET /api/broadcasts/[id]` carries the
 * E-Blast's SUBJECT and BODY.
 *
 * `contracts/portal-eblast-approval-api.md § GET /api/broadcasts/[id]` lists
 * "the subject and body of the E-Blast" as the PR-1 half of the FR-049
 * widening. The route has in fact returned both since the F7 MVP (`858fc15c1`)
 * — what was missing was the SCREEN (T141 renders them) and any test holding
 * the route to it. PR-2's T141a edits this same payload to add `stage`,
 * `whoseTurn`, `round` and the latest-sent-version body rule, so the two
 * fields FR-049 depends on are pinned here first.
 *
 * `customRecipientCount` is asserted alongside because it is the PII-
 * minimisation rule of the same payload (W0-15): the count, never the list.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const requireMemberContextMock = vi.fn();
const findByIdMock = vi.fn();
const enforceTenantContextMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/broadcasts', () => ({
  parseBroadcastId: (id: string) => ({ ok: true as const, value: id }),
  makeGetBroadcastDeps: () => ({ broadcastsRepo: { findById: findByIdMock } }),
  makeEnforceTenantContextDeps: () => ({}),
  enforceTenantContext: (...args: unknown[]) => enforceTenantContextMock(...args),
}));

const BROADCAST_ID = '77777777-7777-4777-8777-777777777777';

const memberCtx = {
  current: { user: { id: 'usr-1' } },
  member: { memberId: 'mem-1' },
  tenant: { slug: 'test-tenant' },
  requestId: 'req-1',
};

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/broadcasts/${BROADCAST_ID}`, {
    method: 'GET',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireMemberContextMock.mockResolvedValue(memberCtx);
  enforceTenantContextMock.mockResolvedValue({ ok: true });
  findByIdMock.mockResolvedValue({
    broadcastId: BROADCAST_ID,
    tenantId: 'test-tenant',
    requestedByMemberId: 'mem-1',
    status: 'sent',
    subject: 'Autumn mixer — save the date',
    bodyHtml: '<p>The autumn mixer is on 12 October.</p>',
    bodySource: '<p>The autumn mixer is on 12 October.</p>',
    segmentType: 'all_members',
    segmentParams: null,
    customRecipientEmails: ['a@example.com', 'b@example.com'],
    estimatedRecipientCount: 42,
    scheduledFor: null,
    submittedAt: new Date('2026-09-01T03:00:00.000Z'),
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    cancelledAt: null,
    cancellationReason: null,
    sentAt: new Date('2026-09-02T03:00:00.000Z'),
    createdAt: new Date('2026-08-31T03:00:00.000Z'),
    updatedAt: new Date('2026-09-02T03:00:00.000Z'),
  });
});

describe('GET /api/broadcasts/[id] — FR-049 subject + body', () => {
  it('the owning member reads back the subject and the body of their E-Blast', async () => {
    const { GET } = await import('@/app/api/broadcasts/[id]/route');
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: BROADCAST_ID }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subject: string;
      bodyHtml: string;
      customRecipientEmails?: unknown;
      customRecipientCount: number;
    };
    expect(body.subject).toBe('Autumn mixer — save the date');
    expect(body.bodyHtml).toBe('<p>The autumn mixer is on 12 October.</p>');
    // PII minimisation (W0-15): the count, never the address list.
    expect(body.customRecipientCount).toBe(2);
    expect(body.customRecipientEmails).toBeUndefined();
  });

  it('another member\'s E-Blast is 404 and carries no subject or body', async () => {
    findByIdMock.mockResolvedValue({
      broadcastId: BROADCAST_ID,
      tenantId: 'test-tenant',
      requestedByMemberId: 'someone-else',
      subject: 'Autumn mixer — save the date',
      bodyHtml: '<p>secret</p>',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { GET } = await import('@/app/api/broadcasts/[id]/route');
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ id: BROADCAST_ID }),
    });

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('secret');
  });
});
