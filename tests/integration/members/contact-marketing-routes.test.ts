/**
 * 108 PR-D — the three marketing ROUTE HANDLERS against live Neon.
 *
 * Why this file exists: the pre-push API-route gate (#339) reported
 *
 *   [pre-push] no integration test imports src/app/api/admin/contacts/[contactId]/marketing/route.ts — skipping
 *   [pre-push] no integration test imports src/app/api/portal/profile/marketing/route.ts — skipping
 *   [pre-push] no integration test imports src/app/api/portal/profile/route.ts — skipping
 *
 * for every route PR-D adds. Their contract tests mock
 * `@/lib/contact-marketing-deps`, `@/modules/members`, `@/lib/idempotency`
 * and `@/lib/tenant-context`, so they prove the route's SHAPE (status codes,
 * order of checks, RFC 7807 bodies) and nothing about the wiring underneath
 * it. Route → real deps builder → real use case → real repo → RLS → audit had
 * only ever been exercised by e2e, which has no CI job. That is the exact
 * shape of the `void-pdf-reconcile` cron that shipped broken and rode 31
 * commits.
 *
 * Mocked: `@/lib/auth-session` — session lookup needs a Next.js request
 * scope this harness does not have. Everything below it is real: RBAC
 * evaluation, tenant resolution (`x-tenant`, gated on
 * `E2E_X_TENANT_HEADER_ENABLED`), `buildContactMarketingDeps`,
 * `drizzleContactRepo` and the audit append — all against the live Neon
 * `dev` branch.
 *
 * The idempotency store is Upstash Redis, and its reservation FAILS CLOSED on
 * an outage by design (post-ship R6 C3: a write that cannot be reserved is
 * refused with 503, never processed twice). The required smoke job seeds its
 * env from `.env.example`, whose Upstash URL is the placeholder
 * `https://example.upstash.io` — so in CI every Idempotency-Key route 503s
 * before it reaches the database, and this file was the first in that job to
 * find out (7 of 8 cases: `expected 503 to be 200`). Rather than skip in the
 * required job (vacuous) or weaken the route (wrong), the store is replaced
 * with a faithful in-memory one ONLY when no real Redis is configured. The
 * state machine is identical — first / replay-with-stored-body / conflict-on-
 * different-body / conflict-while-in-flight — so the replay and conflict
 * cases still test the route's handling of each outcome. Locally and in the
 * pre-push gate `.env.local` carries real credentials and the REAL store runs;
 * that is where the "against Upstash" evidence for FR-030b comes from. Adding
 * `UPSTASH_REDIS_REST_URL/TOKEN` secrets to the smoke job makes CI take the
 * real path too, with no change here.
 *
 * What it proves that the mocked contract tests cannot:
 *   1. a staff "off" writes all three 0294 columns AND its audit row;
 *   2. `manager` is refused (`contacts.marketing` is never manager) with the
 *      row untouched — defence in depth behind the hidden UI;
 *   3. a member's own "off" is stamped `source:'self'` and audited under
 *      `member_id`, the key migration 0009's trigger reads;
 *   4. **staff cannot lift that objection** — 409 `self_opted_out` reaches the
 *      client and the row still carries the person's own opt-out.
 *
 * Scope of (4), measured, not assumed: disabling the repo's UNDER-LOCK guard
 * (`if (!nextOff && actor === 'staff' && source === 'self')`) leaves all six
 * tests here GREEN — the use case's pre-read refuses first, so this file
 * proves the refusal REACHES THE CLIENT, not that it survives a self opt-out
 * committing between the pre-read and the lock. That TOCTOU leg is
 * `contact-marketing-opt-out-guard.test.ts`, which drives the repo directly
 * and does kill that mutant (2 of its 4 cases fail). Two files, two claims;
 * neither is a substitute for the other.
 *
 * Simulated emails only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { db, runInTenant } from '@/lib/db';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

// See the file header. Decided at import time from the env the setup file
// loaded; the placeholder host is what `.env.example` ships and what CI seeds.
vi.mock('@/lib/idempotency', async () => {
  const actual = await vi.importActual<typeof import('@/lib/idempotency')>('@/lib/idempotency');
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? '';
  const realRedis = url.length > 0 && !url.includes('example.upstash.io');
  if (realRedis) return actual;

  type Stored = { bodyHash: string; response: { status: number; body: unknown } | null };
  const store = new Map<string, Stored>();
  const k = (tenant: { slug: string }, key: string) => `${tenant.slug}:${key}`;
  return {
    ...actual,
    async classifyIdempotencyRequest(tenant: { slug: string }, key: string, bodyHash: string) {
      const hit = store.get(k(tenant, key));
      if (!hit) return { kind: 'first' as const };
      if (hit.bodyHash !== bodyHash) return { kind: 'conflict' as const };
      if (hit.response === null) return { kind: 'conflict' as const };
      return { kind: 'replay' as const, previousResponse: hit.response };
    },
    async reserveIdempotencyRecord(tenant: { slug: string }, key: string, bodyHash: string) {
      store.set(k(tenant, key), { bodyHash, response: null });
      return { ok: true as const, value: { kind: 'reserved' as const } };
    },
    async rememberIdempotentResponse(
      tenant: { slug: string },
      key: string,
      bodyHash: string,
      response: { status: number; body: unknown },
    ) {
      store.set(k(tenant, key), { bodyHash, response });
    },
  };
});

const getCurrentSessionMock = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...a: unknown[]) => getCurrentSessionMock(...a),
  requireSession: (...a: unknown[]) => getCurrentSessionMock(...a),
}));

import { POST as staffMarketingPost } from '@/app/api/admin/contacts/[contactId]/marketing/route';
import { PATCH as portalMarketingPatch } from '@/app/api/portal/profile/marketing/route';
import { GET as portalProfileGet } from '@/app/api/portal/profile/route';

let tenant: TestTenant;
let admin: TestUser;
let manager: TestUser;
let memberUser: TestUser;
let memberId: string;
let contactId: string;

function sessionAs(user: TestUser, role: 'admin' | 'manager' | 'member') {
  getCurrentSessionMock.mockResolvedValue({
    session: { id: `sess-${randomUUID()}` },
    user: { id: user.userId, role, email: user.rawEmail },
  });
}

/**
 * `requestIdFromHeaders` REGENERATES anything that fails
 * `/^[a-f0-9-]{8,128}$/i`, so a readable label like `rt-staff-off-…` would be
 * silently replaced and the audit row would be unfindable by it. Use a plain
 * UUID and keep the label in the variable name.
 */
const reqId = (): string => randomUUID();

/** A fresh key per call — the route consumes one reservation per request. */
function makeRequest(
  path: string,
  init: { method: string; body?: unknown; requestId: string; idempotencyKey?: string },
): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    method: init.method,
    headers: {
      'x-tenant': tenant.ctx.slug,
      'x-request-id': init.requestId,
      'idempotency-key': init.idempotencyKey ?? `idem-${randomUUID()}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

function staffToggle(state: 'on' | 'off', requestId: string, idempotencyKey?: string) {
  return staffMarketingPost(
    makeRequest(`/api/admin/contacts/${contactId}/marketing`, {
      method: 'POST',
      body: { state },
      requestId,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    }),
    { params: Promise.resolve({ contactId }) },
  );
}

async function readContactRow() {
  const [row] = await runInTenant(tenant.ctx, (tx) =>
    tx
      .select({
        at: contacts.marketingOptOutAt,
        source: contacts.marketingOptOutSource,
        by: contacts.marketingOptOutByUserId,
      })
      .from(contacts)
      .where(eq(contacts.contactId, contactId)),
  );
  return row!;
}

async function auditRowsFor(requestId: string) {
  return db
    .select({ eventType: auditLog.eventType, payload: auditLog.payload })
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenant.ctx.slug), eq(auditLog.requestId, requestId)));
}

beforeAll(async () => {
  admin = await createActiveTestUser('admin');
  manager = await createActiveTestUser('manager');
  memberUser = await createActiveTestUser('member');
  tenant = await createTestTenant('test-swecham');
  const planId = `mktrt-${randomUUID().slice(0, 6)}`;
  await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
  const seeded = await seedPortalMemberWithContact(tenant, planId, {
    linkedUserId: memberUser.userId,
  });
  memberId = seeded.memberId;
  contactId = seeded.contactId;
  // A SECOND contact on the same member, so the FR-032 assertion in the
  // portal-profile case has a real row to be about (staff review T2).
  await runInTenant(tenant.ctx, (tx) =>
    tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId: randomUUID(),
      memberId,
      firstName: 'Peer',
      lastName: 'Contact',
      email: `peer-${randomUUID().slice(0, 8)}@example.test`,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
    }),
  );
}, 180_000);

afterAll(async () => {
  await tenant.cleanup().catch(() => {});
  await deleteTestUser(admin).catch(() => {});
  await deleteTestUser(manager).catch(() => {});
  await deleteTestUser(memberUser).catch(() => {});
}, 180_000);

describe('108 PR-D — POST /api/admin/contacts/[contactId]/marketing (live Neon)', () => {
  it('a staff "off" writes the three 0294 columns and its audit row in one request', async () => {
    sessionAs(admin, 'admin');
    const requestId = reqId();

    const res = await staffToggle('off', requestId);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ outcome: 'changed' });

    const row = await readContactRow();
    expect(row.at).not.toBeNull();
    expect(row.source).toBe('staff');
    expect(row.by).toBe(admin.userId);

    const audits = await auditRowsFor(requestId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.eventType).toBe('contact_marketing_opted_out');
    // FR-053a — ids only. Staff changes carry `related_member_id`, NOT
    // `member_id`: this is not the member's own activity, so it must not bump
    // `members.last_activity_at` through migration 0009's trigger.
    expect(audits[0]!.payload).toMatchObject({ related_member_id: memberId });
    expect(audits[0]!.payload).not.toHaveProperty('member_id');
    expect(JSON.stringify(audits[0]!.payload)).not.toContain('@');
  });

  it('the same state again is `unchanged` and writes no second audit row', async () => {
    sessionAs(admin, 'admin');
    const requestId = reqId();

    const res = await staffToggle('off', requestId);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ outcome: 'unchanged' });
    await expect(auditRowsFor(requestId)).resolves.toHaveLength(0);
  });

  it('the SAME Idempotency-Key replays the stored response and writes no second audit row', async () => {
    // Staff review A2/T5: replay was proven only against a mocked
    // `@/lib/idempotency`. This drives the real reservation table.
    sessionAs(admin, 'admin');
    const key = `idem-fixed-${randomUUID()}`;
    const firstReq = reqId();
    const first = await staffToggle('on', firstReq, key);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    await expect(auditRowsFor(firstReq)).resolves.toHaveLength(1);

    const replayReq = reqId();
    const replay = await staffToggle('on', replayReq, key);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstBody);
    // The replay is served from the store: no second write, no second row.
    await expect(auditRowsFor(replayReq)).resolves.toHaveLength(0);
  });

  it('the same Idempotency-Key with a DIFFERENT body is a 409 conflict, not a silent replay', async () => {
    sessionAs(admin, 'admin');
    const key = `idem-conflict-${randomUUID()}`;
    expect((await staffToggle('off', reqId(), key)).status).toBe(200);

    const conflict = await staffToggle('on', reqId(), key);
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { type?: string };
    expect(body.type).toMatch(/idempotency_conflict$/);
    // Refused, so the row still reads what the first call made it.
    await expect(readContactRow()).resolves.toMatchObject({ source: 'staff' });
  });

  it('a manager session is refused and the row is untouched (contacts.marketing is never manager)', async () => {
    const before = await readContactRow();
    sessionAs(manager, 'manager');

    const res = await staffToggle('on', reqId());
    expect(res.status).toBe(403);

    await expect(readContactRow()).resolves.toEqual(before);
  });
});

describe('108 PR-D — the person outranks staff, end to end (FR-025 AMENDMENT)', () => {
  it('a member switching their own marketing off is stamped `self` and audited under member_id', async () => {
    // Clear the staff opt-out first so the self write is the only objection.
    sessionAs(admin, 'admin');
    expect((await staffToggle('on', reqId())).status).toBe(200);
    await expect(readContactRow()).resolves.toMatchObject({ at: null, source: null, by: null });

    sessionAs(memberUser, 'member');
    const requestId = reqId();
    const res = await portalMarketingPatch(
      makeRequest('/api/portal/profile/marketing', {
        method: 'PATCH',
        body: { optOut: true },
        requestId,
      }),
    );
    expect(res.status).toBe(200);

    const row = await readContactRow();
    expect(row.at).not.toBeNull();
    expect(row.source).toBe('self');
    expect(row.by).toBe(memberUser.userId);

    const audits = await auditRowsFor(requestId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.eventType).toBe('contact_marketing_opted_out');
    // `member_id` (snake_case) is what migration 0009's trigger reads to bump
    // `members.last_activity_at` — a self change IS member activity.
    expect(audits[0]!.payload).toMatchObject({ member_id: memberId });
    expect(JSON.stringify(audits[0]!.payload)).not.toContain('@');
  });

  it('staff CANNOT switch it back on — 409 self_opted_out, and the objection survives', async () => {
    sessionAs(admin, 'admin');

    const res = await staffToggle('on', reqId());
    expect(res.status).toBe(409);
    // RFC 7807: the machine-readable code lives in `type`, not a `code` field.
    const body = (await res.json()) as { type?: string; detail?: string };
    expect(body.type).toMatch(/self_opted_out$/);
    expect(typeof body.detail).toBe('string');

    // The row must still carry the person's own objection, not a half-applied
    // staff write. (Which of the two guards refused is not observable here —
    // see the scope note in the file header.)
    const row = await readContactRow();
    expect(row.source).toBe('self');
    expect(row.at).not.toBeNull();
  });

  it('GET /api/portal/profile reports the state the person set', async () => {
    sessionAs(memberUser, 'member');
    const res = await portalProfileGet(
      makeRequest('/api/portal/profile', { method: 'GET', requestId: reqId() }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contacts: ReadonlyArray<{ contact_id: string; marketing?: { state?: string } }>;
    };
    // FR-032 — `marketing.state` is attached to the OWN contact only, and a
    // self opt-out derives `off_by_contact` (not the raw column value).
    const own = body.contacts.find((c) => c.contact_id === contactId);
    expect(own?.marketing?.state).toBe('off_by_contact');
    // Staff review T2: the member has a SECOND contact (seeded in beforeAll),
    // so this assertion is about a real row. It used to run `.every()` over an
    // empty array — vacuously true, and a serialiser attaching `marketing` to
    // every contact would have passed.
    const others = body.contacts.filter((c) => c.contact_id !== contactId);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((c) => c.marketing === undefined)).toBe(true);
  });
});
