/**
 * F119 T097 / T105 — the test copy (FR-037; research R23, V4 RESOLVED).
 *
 * Any user of the writing tool may send a test copy to their OWN address
 * only: the recipient is resolved server-side from the session (a
 * body-supplied `to` is ignored), the subject carries the localised `[Test]`
 * prefix, the body goes through the IDENTICAL pipeline as a real send
 * (shared sanitiser policy, design-block validation, brand header/footer,
 * the same wrapper), and nothing changes — no stage, no version, no
 * allowance. Synchronous and non-durable through the shared TRANSACTIONAL
 * sender (never the Broadcasts surface — a test must not enter the marketing
 * suppression list or reputation pool): no outbox row, no sixth
 * `notification_type`. 10 per user per hour. Audit
 * `broadcast_test_copy_sent { related_member_id, broadcast_id | null,
 * version_id | null, recipient_hash, actor_role }` — `related_member_id`
 * EVEN for a portal user (a test copy to one's own inbox is not member
 * activity on the E-Blast, so it must NOT move `last_activity_at`).
 *
 * Part 1 pins the use case with fakes; part 2 pins the two routes' wire
 * contract with the use case mocked at the barrel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';
import { logger } from '@/lib/logger';
import { sendTestCopy } from '@/modules/broadcasts/application/use-cases/send-test-copy';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant-swe' as never;

function makeDeps(o?: {
  mailerFails?: 'upstream-unavailable' | 'invalid-recipient';
  sanitize?: (html: string) => string;
}) {
  const send = vi.fn(async () => (o?.mailerFails ? err({ code: o.mailerFails, message: 'x' }) : ok({ messageId: 'msg-1' })));
  const audit: AuditPort = { emit: vi.fn(async () => undefined), emitTyped: vi.fn(async () => undefined) };
  // A spy, so the size guards can be pinned as running BEFORE or AFTER it.
  const sanitize = vi.fn(o?.sanitize ?? ((html: string) => html.replace(/<script>.*?<\/script>/g, '')));
  return {
    sanitize,
    deps: {
      sanitizer: { sanitize },
      brand: { load: async () => ({ primaryColor: '#b04a00', postalAddress: '1 Street', logoUrl: null }) },
      renderer: {
        render: (i: { subject: string; bodyHtml: string; brand: { primaryColor: string | null } }) =>
          `<!doctype html><title>${i.subject}</title>${i.bodyHtml}<!--${i.brand.primaryColor}-->`,
      },
      mailer: { send },
      audit,
    },
    send,
    audit,
  };
}

const base = {
  tenantId: TENANT,
  tenantDisplayName: 'Chamber',
  actorUserId: 'user-1',
  actorRole: 'member' as string | null,
  actorEmail: 'Me@Example.org',
  relatedMemberId: 'm-1' as string | null,
  broadcastId: null as string | null,
  versionId: null as string | null,
  requestId: 'req-1',
  subject: 'Hello',
  bodyHtml: '<p>Body</p><script>x</script>',
  locale: 'en' as const,
};

describe('sendTestCopy — use case', () => {
  it('sends to the SESSION address only, with the localised [Test] prefix, through the identical pipeline', async () => {
    const { deps, send } = makeDeps();
    const r = await sendTestCopy(deps, base);
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const [msg] = send.mock.calls[0] as unknown as [{ to: string; subject: string; html: string }];
    expect(msg.to).toBe('Me@Example.org');
    expect(msg.subject).toBe('[Test] Hello');
    // Sanitised (script gone), rendered by the wrapper with the live brand.
    expect(msg.html).toContain('<p>Body</p>');
    expect(msg.html).not.toContain('<script>');
    expect(msg.html).toContain('<!--#b04a00-->');
  });

  it('the Thai prefix is used for a th locale', async () => {
    const { deps, send } = makeDeps();
    await sendTestCopy(deps, { ...base, locale: 'th' });
    const [msg] = send.mock.calls[0] as unknown as [{ subject: string }];
    expect(msg.subject.startsWith('[ทดสอบ] ')).toBe(true);
  });

  it('audits broadcast_test_copy_sent with related_member_id (never member_id), a recipient hash and the session role — never the address', async () => {
    const { deps, audit } = makeDeps();
    await sendTestCopy(deps, { ...base, broadcastId: 'b-1', versionId: 'v-1' });
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [, event] = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const e = event as { eventType: string; payload: Record<string, unknown> };
    expect(e.eventType).toBe('broadcast_test_copy_sent');
    expect(e.payload).toMatchObject({ related_member_id: 'm-1', broadcast_id: 'b-1', version_id: 'v-1', actor_role: 'member' });
    expect(e.payload).not.toHaveProperty('member_id');
    expect(typeof e.payload.recipient_hash).toBe('string');
    expect(JSON.stringify(e.payload)).not.toMatch(/example\.org/i);
  });

  it('four CTA blocks → too_many_cta, nothing sent, nothing audited', async () => {
    const { deps, send, audit } = makeDeps();
    const cta = '<a data-eb="cta" href="https://x.example/">Go</a>';
    const r = await sendTestCopy(deps, { ...base, bodyHtml: cta.repeat(4) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('content_rules');
    if (r.error.kind === 'content_rules') expect(r.error.violations[0]?.code).toBe('too_many_cta');
    expect(send).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('a 201-character subject → invalid_body; the mailer is never reached', async () => {
    const { deps, send } = makeDeps();
    const r = await sendTestCopy(deps, { ...base, subject: 'x'.repeat(201) });
    expect(r).toMatchObject({ ok: false, error: { kind: 'invalid_body' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('a mailer failure → mailer_unavailable and no audit row (nothing was sent)', async () => {
    const { deps, audit } = makeDeps({ mailerFails: 'upstream-unavailable' });
    const r = await sendTestCopy(deps, base);
    expect(r).toMatchObject({ ok: false, error: { kind: 'mailer_unavailable', code: 'upstream-unavailable' } });
    expect(audit.emit).not.toHaveBeenCalled();
  });

  // F7-5 — the port separates a bad address from a provider outage, and the
  // code is PII-free; dropping it made a Resend `validation_error` answer
  // "try again" forever and log exactly like an outage.
  it('a refused recipient keeps the mailer code (invalid-recipient), so the route can tell it from an outage', async () => {
    const { deps, audit } = makeDeps({ mailerFails: 'invalid-recipient' });
    const r = await sendTestCopy(deps, base);
    expect(r).toMatchObject({ ok: false, error: { kind: 'mailer_unavailable', code: 'invalid-recipient' } });
    expect(audit.emit).not.toHaveBeenCalled();
  });

  // --- Senior-tester review H2 ------------------------------------------------
  // The four arms below were the uncovered branches that held this use case at
  // 76.47 % branch, under the Application floor of 80/80. Each is a refusal that
  // has to stop the pipeline at a DIFFERENT point, and "stops" is the assertion:
  // a refusal that still reached the mailer or still wrote an audit row would be
  // a test copy the operator was told had failed.

  it('a sanitiser that throws → sanitizer_unavailable; the mailer is never reached and nothing is audited', async () => {
    const { deps, send, audit } = makeDeps({
      sanitize: () => {
        throw new Error('DOMPurify jsdom window unavailable');
      },
    });
    const r = await sendTestCopy(deps, base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('sanitizer_unavailable');
    if (r.error.kind === 'sanitizer_unavailable') {
      expect(r.error.reason).toContain('DOMPurify');
    }
    expect(send).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('a non-Error sanitiser throw still carries a reason (String(e), not "[object Object]")', async () => {
    const { deps } = makeDeps({
      sanitize: () => {
        // A bare string, deliberately: the `String(e)` arm is a different
        // branch from the `instanceof Error` one.
        throw 'sanitizer pool exhausted';
      },
    });
    const r = await sendTestCopy(deps, base);
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'sanitizer_unavailable', reason: 'sanitizer pool exhausted' },
    });
  });

  it('a 201 KB body → invalid_body/body_too_large BEFORE the sanitiser is asked to parse it', async () => {
    const { deps, send, sanitize } = makeDeps();
    const oversize = `<p>${'x'.repeat(201 * 1024)}</p>`;
    const r = await sendTestCopy(deps, { ...base, bodyHtml: oversize });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid_body', reason: 'body_too_large' },
    });
    // The point of the pre-check: 201 KB never reaches DOMPurify.
    expect(sanitize).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('a sanitiser that GROWS the body past 200 KB → body_too_large on the POST-sanitise check', async () => {
    // Entity-escaping is the real growth path: `&` → `&amp;` is 5 bytes for 1.
    const { deps, send, audit, sanitize } = makeDeps({
      sanitize: (html) => `${html}${'y'.repeat(200 * 1024)}`,
    });
    const r = await sendTestCopy(deps, { ...base, bodyHtml: '<p>small</p>' });
    expect(r).toMatchObject({
      ok: false,
      error: { kind: 'invalid_body', reason: 'body_too_large' },
    });
    // …and this one DID run the sanitiser — that is what distinguishes it from
    // the pre-check above.
    expect(sanitize).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('a session carrying no role records actor_role: null — never a fabricated literal', async () => {
    const { deps, audit } = makeDeps();
    const r = await sendTestCopy(deps, { ...base, actorRole: null });
    expect(r.ok).toBe(true);
    const [, event] = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const payload = (event as { payload: Record<string, unknown> }).payload;
    // The audit-truth invariant: no row states a role its actor did not hold.
    expect(payload.actor_role).toBeNull();
  });
});

// --- Part 2: the routes ------------------------------------------------------

const requireMemberContextMock = vi.fn();
const requireApiPermissionMock = vi.fn();
const sendTestCopyMock = vi.fn();
const checkLimitMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/broadcast-test-copy-deps', () => ({
  makeSendTestCopyDeps: async () => ({ sanitizer: {}, brand: {}, renderer: {}, mailer: {}, audit: {}, tenantDisplayName: 'Test Chamber' }),
}));
vi.mock('@/modules/broadcasts', async () => {
  const actual = await vi.importActual<typeof import('@/modules/broadcasts/application/use-cases/send-test-copy')>(
    '@/modules/broadcasts/application/use-cases/send-test-copy',
  );
  return {
    sendTestCopy: (...args: unknown[]) => sendTestCopyMock(...args),
    TEST_COPY_SUBJECT_MAX: actual.TEST_COPY_SUBJECT_MAX,
    TEST_COPY_BODY_MAX_BYTES: actual.TEST_COPY_BODY_MAX_BYTES,
    broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
  };
});

const memberCtx = {
  current: {
    user: { id: 'user-member-1', email: 'member@swecham.test', role: 'member' as const, status: 'active' as const, displayName: 'Member' },
    session: { id: 'sess-m-1' },
  },
  tenant: { slug: 'test-tenant', __brand: true },
  member: { memberId: 'm-1', planId: 'p-prem' },
  memberId: 'm-1',
  ownContact: { contactId: 'c-1' },
  ownContactId: 'c-1',
  sourceIp: '203.0.113.10',
  requestId: 'req-tc-1',
};
const staffCtx = {
  current: {
    user: { id: 'user-mk-1', email: 'mk@swecham.test', role: 'marketing' as const, status: 'active' as const, displayName: 'Mk' },
    session: { id: 'sess-s-1' },
  },
  requestId: 'req-tc-2',
};
const VALID = { subject: 'Hello', bodyHtml: '<p>Body</p>', locale: 'en' };

function req(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const importMember = () => import('@/app/api/broadcasts/test-copy/route');
const importStaff = () => import('@/app/api/admin/broadcasts/test-copy/route');

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  checkLimitMock.mockResolvedValue(ok(true));
  sendTestCopyMock.mockResolvedValue(ok({ messageId: 'msg-1' }));
  requireMemberContextMock.mockResolvedValue(memberCtx);
  requireApiPermissionMock.mockResolvedValue(staffCtx);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/broadcasts/test-copy (member)', () => {
  it('202: a body-supplied `to` is ignored and the SESSION address is used; related_member_id is the caller\'s member', async () => {
    const { POST } = await importMember();
    const res = await POST(req('/api/broadcasts/test-copy', { ...VALID, to: 'victim@example.org' }));
    expect(res.status).toBe(202);
    expect(sendTestCopyMock).toHaveBeenCalledTimes(1);
    const [, input] = sendTestCopyMock.mock.calls[0]!;
    expect(input).toMatchObject({
      actorEmail: 'member@swecham.test',
      actorRole: 'member',
      relatedMemberId: 'm-1',
      subject: 'Hello',
      bodyHtml: '<p>Body</p>',
      locale: 'en',
      tenantDisplayName: 'Test Chamber',
    });
    expect(JSON.stringify(input)).not.toContain('victim@example.org');
  });

  it('the 11th call in an hour → 429 with Retry-After, consumed BEFORE the send', async () => {
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 1800 }));
    const { POST } = await importMember();
    const res = await POST(req('/api/broadcasts/test-copy', VALID));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('1800');
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:test-copy:test-tenant:user-member-1', 10, 3600);
    expect(sendTestCopyMock).not.toHaveBeenCalled();
  });

  it('content-rule violations → 422 with the violation code; invalid body → 400; mailer down → 503', async () => {
    const { POST } = await importMember();
    sendTestCopyMock.mockResolvedValueOnce(err({ kind: 'content_rules', violations: [{ code: 'too_many_cta', index: 3, max: 3 }] }));
    const r1 = await POST(req('/api/broadcasts/test-copy', VALID));
    expect(r1.status).toBe(422);
    expect((await r1.json()).error.code).toBe('too_many_cta');
    expect((await POST(req('/api/broadcasts/test-copy', { ...VALID, subject: 'x'.repeat(201) }))).status).toBe(400);
    sendTestCopyMock.mockResolvedValueOnce(err({ kind: 'mailer_unavailable', code: 'upstream-unavailable', reason: 'x' }));
    const r3 = await POST(req('/api/broadcasts/test-copy', VALID));
    expect(r3.status).toBe(503);
    expect((await r3.json()).error.code).toBe('test_copy_unavailable');
  });

  // F7-5 — a permanent refusal is not an outage: "try again" would never work.
  // F7-6 — and it is not proof the ADDRESS is bad: the port code also carries
  // Resend `validation_error` (an unverified from-domain, a test-mode key), so
  // the copy names the refusal, not the member's address, as the fault.
  it('a permanent provider refusal → 422 test_copy_invalid_recipient, not the 503 "try again"', async () => {
    const { POST } = await importMember();
    sendTestCopyMock.mockResolvedValueOnce(err({ kind: 'mailer_unavailable', code: 'invalid-recipient', reason: 'x' }));
    const res = await POST(req('/api/broadcasts/test-copy', VALID));
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe('test_copy_invalid_recipient');
    expect(error.message).toMatch(/refused/);
    expect(error.message).not.toMatch(/could not receive/);
    expect(error.messageThai).toMatch(/ปฏิเสธ/);
  });

  // F2-9 — `reason` is Resend's VERBATIM message and can echo the recipient
  // address ("Invalid `to` field: …@…"). The log carries the PII-free mailer
  // CODE (F7-5 — it used to carry the constant kind, so a bad address and an
  // outage logged identically), never the provider message.
  it('the mailer/sanitizer failure log lines carry the typed code, never the provider message', async () => {
    const { POST } = await importMember();
    sendTestCopyMock.mockResolvedValueOnce(
      err({
        kind: 'mailer_unavailable',
        code: 'invalid-recipient',
        reason: 'Invalid `to` field: member.secret@swecham.test is suppressed',
      }),
    );
    await POST(req('/api/broadcasts/test-copy', VALID));
    const warned = vi.mocked(logger.warn).mock.calls.find(
      (c) => c[1] === 'broadcasts.test_copy.mailer_unavailable',
    );
    expect(warned, 'expected a broadcasts.test_copy.mailer_unavailable log line').toBeDefined();
    expect((warned![0] as { err: unknown }).err).toBe('invalid-recipient');
    expect(JSON.stringify(warned![0])).not.toContain('member.secret@swecham.test');

    sendTestCopyMock.mockResolvedValueOnce(err({ kind: 'mailer_unavailable', code: 'upstream-unavailable', reason: 'x' }));
    await POST(req('/api/broadcasts/test-copy', VALID));
    const upstream = vi.mocked(logger.warn).mock.calls.filter(
      (c) => c[1] === 'broadcasts.test_copy.mailer_unavailable',
    );
    expect((upstream.at(-1)![0] as { err: unknown }).err).toBe('upstream-unavailable');

    sendTestCopyMock.mockResolvedValueOnce(
      err({ kind: 'sanitizer_unavailable', reason: 'DOMPurify threw on <img src=member.secret@swecham.test>' }),
    );
    await POST(req('/api/broadcasts/test-copy', VALID));
    const errored = vi.mocked(logger.error).mock.calls.find(
      (c) => c[1] === 'broadcasts.test_copy.sanitizer_unavailable',
    );
    expect(errored, 'expected a broadcasts.test_copy.sanitizer_unavailable log line').toBeDefined();
    expect((errored![0] as { err: unknown }).err).toBe('sanitizer_unavailable');
    expect(JSON.stringify(errored![0])).not.toContain('member.secret@swecham.test');
  });
});

describe('POST /api/admin/broadcasts/test-copy (staff)', () => {
  it('names broadcasts.write (a manager cannot send a test copy) and sends to the staff session address', async () => {
    const { POST } = await importStaff();
    const res = await POST(req('/api/admin/broadcasts/test-copy', VALID));
    expect(res.status).toBe(202);
    expect(requireApiPermissionMock.mock.calls[0]![1]).toBe('broadcasts.write');
    const [, input] = sendTestCopyMock.mock.calls[0]!;
    expect(input).toMatchObject({ actorEmail: 'mk@swecham.test', actorRole: 'marketing', relatedMemberId: null });
  });

  it('returns the gate\'s 403 untouched and is limited on the same 10 / hour bucket per staff user', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({ response: NextResponse.json({ error: 'permission_denied' }, { status: 403 }) });
    const { POST } = await importStaff();
    expect((await POST(req('/api/admin/broadcasts/test-copy', VALID))).status).toBe(403);
    checkLimitMock.mockResolvedValueOnce(err({ retryAfterSeconds: 60 }));
    const res = await POST(req('/api/admin/broadcasts/test-copy', VALID));
    expect(res.status).toBe(429);
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:test-copy:test-tenant:user-mk-1', 10, 3600);
  });
});
