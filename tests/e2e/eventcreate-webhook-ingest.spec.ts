/**
 * T037 — E2E: F6 webhook ingest end-to-end (US1 AS1–AS5).
 *
 * Spec authority: specs/012-eventcreate-integration/spec.md User Story 1.
 *
 * RED reason: webhook route + use-cases not yet shipped (Phase 3 T043–T052).
 * Until then, the route returns 404 and every assertion fails.
 *
 * Run with: pnpm test:e2e --grep "F6 webhook ingest" --workers=1
 * (--workers=1 is mandatory per CLAUDE.md memory feedback_e2e_workers).
 *
 * Turns GREEN: when T052 route + T043+T047 use-cases land AND the
 * test tenant fixture seeds a webhook config row with a known secret
 * (test helper to be authored alongside Phase 5 T080).
 */
import { test, expect } from '@playwright/test';
import { createHmac, randomUUID } from 'node:crypto';
import { F6_E2E_FIXTURE_SECRET } from './helpers/eventcreate-seed';

/**
 * D1 verify-fix (2026-05-13) — request-id helper.
 *
 * Background: `src/proxy.ts` validates inbound `X-Request-ID` against
 * `REQUEST_ID_PATTERN = /^[a-f0-9-]{8,128}$/i` (src/lib/request-id.ts:58).
 * Non-hex IDs like `req-as3-${Date.now()}` (the previous spec default)
 * are REJECTED and replaced with a fresh UUIDv7 per request. That made
 * AS3's "same X-Request-ID twice → 409" assertion impossible: two
 * inbound calls with identical `req-as3-*` headers each received a
 * DIFFERENT proxy-generated UUIDv7, so the receiver-side idempotency
 * check never fired.
 *
 * Fix: use `randomUUID()` (UUIDv4 — matches `[a-f0-9-]{36}`) so the
 * proxy passes the inbound ID through verbatim. AS3 then sees the
 * SAME request_id on both calls and idempotency correctly returns 409
 * on the second.
 */
function uniqueRequestId(suffix: string): string {
  // Embed the test-suffix in the UUID's last group so log/audit
  // grepping can still find AS-scoped rows (e.g. `tail | grep as3`)
  // even though the bytes are hex-shaped.
  const u = randomUUID();
  // Replace last 12 chars with a deterministic suffix derived from
  // `suffix` (left-padded with zeros, truncated, hex-only).
  const safe = suffix.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 12).padStart(12, '0');
  return `${u.slice(0, 24)}${safe}`;
}

// D1 verify-fix (2026-05-13) — defaults aligned with the global-setup
// `seedF6Events` seed (helpers/eventcreate-seed.ts). Previously
// TEST_SECRET defaulted to `'placeholder'` (never matched the seeded
// row) and TENANT_SLUG defaulted to `'test-swecham'` (no row created
// for that tenant). Both made the spec functionally un-runnable
// without per-developer env-var overrides — defaults now reflect the
// real seeded shape so `pnpm test:e2e` works out of the box.
const TEST_SECRET =
  process.env['E2E_F6_TEST_WEBHOOK_SECRET'] ?? F6_E2E_FIXTURE_SECRET;
const TENANT_SLUG =
  process.env['E2E_F6_TENANT_SLUG'] ??
  process.env['TENANT_SLUG'] ??
  'swecham';
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3100';

function signBody(body: unknown, secret: string, timestampSeconds?: number) {
  const rawBody = JSON.stringify(body);
  const ts = (timestampSeconds ?? Math.floor(Date.now() / 1000)).toString();
  const sig = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  return { rawBody, timestamp: ts, signatureHeader: `sha256=${sig}` };
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    eventType: 'attendee.registered',
    tenantSlug: TENANT_SLUG,
    event: {
      externalId: `event_${Math.random().toString(36).slice(2, 10)}`,
      name: 'F6 E2E Test Event',
      startDate: '2026-06-21T18:00:00+07:00',
      category: 'networking',
    },
    attendee: {
      externalId: `att_${Math.random().toString(36).slice(2, 10)}`,
      email: 'e2e-test@example.com',
      fullName: 'E2E Test',
      registeredAt: '2026-06-01T10:00:00Z',
    },
    ...overrides,
  };
}

/**
 * R7.S / Staff R2 R038 closure — seed-dependency contract for AS1.
 *
 * AS1 happy-path asserts `body.matched === 'non_member'` because:
 *   1. No F3 contact row exists for `e2e-test@example.com` in the
 *      `swecham` tenant (grep across `tests/e2e/helpers/`,
 *      `scripts/seed-e2e-user.ts`, `src/` returns 0 occurrences as of
 *      2026-05-17).
 *   2. Default `makePayload` omits `companyName`, so no fuzzy match.
 *   3. No member has `email_domain LIKE '%example.com'`.
 *
 * If a future task seeds `e2e-test@example.com` as a contact email,
 * AS1 will start failing with "expected `non_member` got `member_*`".
 * Root cause: the seed change, NOT the receiver code path. Either:
 *   (a) Update this assertion to `'member_contact'` and acknowledge
 *       the seed change in the comment, OR
 *   (b) Change the test payload to use a different attendee email
 *       guaranteed not to match any seeded contact.
 *
 * member_contact happy-path coverage lives at
 * `tests/integration/events/match-attendee-to-member.test.ts:109+`
 * which seeds explicit contacts to test the FR-002 match rule.
 */
test.describe('F6 webhook ingest — US1 AS1-AS5 @workers=1', () => {
  test('AS1 — signed payload + valid timestamp → 200 + deterministic match + audit', async ({ request }) => {
    // R6.B2 / Round 5 staff-review R002 closure — the prior assertion
    // accepted ALL 5 match outcomes (`['member_contact','member_domain',
    // 'member_fuzzy','non_member','unmatched']`), which is a FALSE
    // POSITIVE: if the FR-002 contact-email match rule silently breaks
    // and returns one of the other 4 shapes, the test still passes.
    //
    // The E2E seed (`seedF6Events`) does NOT create an F3 contact row
    // for `e2e-test@example.com`, so the FR-002 match rule deterministi-
    // cally returns `non_member`. We now assert that exact shape — a
    // regression flipping unmatched/member_* would fail this test.
    //
    // The `member_contact` HAPPY PATH (with a seeded contact email) is
    // covered by `tests/integration/events/transactional-ingest.test.ts`
    // which exercises the F3 contact-email match against live Neon.
    const payload = makePayload();
    const signed = signBody(payload, TEST_SECRET);
    const res = await request.post(
      `${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      {
        data: signed.rawBody,
        headers: {
          'Content-Type': 'application/json',
          'X-Chamber-Signature': signed.signatureHeader,
          'X-Chamber-Timestamp': signed.timestamp,
          'X-Request-ID': uniqueRequestId('as1'),
        },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.registrationId).toBeTruthy();
    // R6.B2 — tightened from `toContain([...5 shapes])` to deterministic
    // `toBe('non_member')`. The seed does not include `e2e-test@example.com`
    // in F3 contacts, so the FR-002 match rule MUST return `non_member`.
    // A regression here is a real bug.
    expect(body.matched).toBe('non_member');
  });

  test('AS2 — non-member attendee persists with match_type=non_member', async ({ request }) => {
    // D1 verify-fix (2026-05-13) — TWO bugs to dodge:
    //   1. `makePayload` shallow-spreads `...overrides` at root → if
    //      caller passes `{attendee: {x: y}}` the `attendee` object is
    //      REPLACED entirely, not deep-merged. Previously this dropped
    //      required `externalId`/`fullName`/`registeredAt` fields →
    //      zod rejected with 400 → no registration row → spec
    //      assertion `matched=non_member` was never reached because
    //      the underlying POST silently failed. Workaround: pass the
    //      FULL attendee object including all required fields.
    //   2. Default attendee `companyName` is `'Fogmaker International
    //      AB'` which IS a seeded member → fuzzy step matched even
    //      when email indicates non-member. Sentinel `E2E-NonMember-
    //      Sentinel-Co-2026` never seeded → fuzzy step finds zero
    //      candidates → falls through to non_member.
    const payload = makePayload({
      attendee: {
        externalId: `att_as2_${Date.now()}`,
        email: 'random-stranger@unaffiliated-domain.example',
        fullName: 'AS2 Non-Member Stranger',
        companyName: 'E2E-NonMember-Sentinel-Co-2026',
        registeredAt: '2026-06-01T10:00:00Z',
      },
    });
    const signed = signBody(payload, TEST_SECRET);
    const res = await request.post(`${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`, {
      data: signed.rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': signed.signatureHeader,
        'X-Chamber-Timestamp': signed.timestamp,
        'X-Request-ID': uniqueRequestId('as2'),
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe('non_member');
    expect(body.matchedMemberId).toBeNull();
  });

  test('AS3 — duplicate X-Request-ID within 7d returns 409 with no new registration', async ({ request }) => {
    const requestId = uniqueRequestId('as3');
    const payload = makePayload();
    const signed = signBody(payload, TEST_SECRET);
    const headers = {
      'Content-Type': 'application/json',
      'X-Chamber-Signature': signed.signatureHeader,
      'X-Chamber-Timestamp': signed.timestamp,
      'X-Request-ID': requestId,
    };
    const first = await request.post(`${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`, {
      data: signed.rawBody,
      headers,
    });
    expect(first.status()).toBe(200);
    const second = await request.post(`${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`, {
      data: signed.rawBody,
      headers,
    });
    expect(second.status()).toBe(409);
  });

  test('AS4 — bad signature → 401 generic body (no oracle)', async ({ request }) => {
    const payload = makePayload();
    const res = await request.post(`${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`, {
      data: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': 'sha256=00' + 'a'.repeat(62),
        'X-Chamber-Timestamp': Math.floor(Date.now() / 1000).toString(),
        'X-Request-ID': uniqueRequestId('as4'),
      },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.title).toMatch(/authentication failed/i);
  });

  test('AS5 — timestamp skew >5min → 401 (replay rejection, same generic body as AS4)', async ({ request }) => {
    const payload = makePayload();
    const sixMinAgo = Math.floor(Date.now() / 1000) - 360;
    const signed = signBody(payload, TEST_SECRET, sixMinAgo);
    const res = await request.post(`${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`, {
      data: signed.rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': signed.signatureHeader,
        'X-Chamber-Timestamp': signed.timestamp,
        'X-Request-ID': uniqueRequestId('as5'),
      },
    });
    expect(res.status()).toBe(401);
  });
});
