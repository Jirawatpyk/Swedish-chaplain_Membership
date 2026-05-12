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
import { createHmac } from 'node:crypto';

const TEST_SECRET = process.env['E2E_F6_TEST_WEBHOOK_SECRET'] ?? 'placeholder';
const TENANT_SLUG = process.env['E2E_F6_TENANT_SLUG'] ?? 'test-swecham';
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

test.describe('F6 webhook ingest — US1 AS1-AS5 @workers=1', () => {
  test('AS1 — signed payload + valid timestamp → 200 + member match + audit', async ({ request }) => {
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
          'X-Request-ID': `req-as1-${Date.now()}`,
        },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.registrationId).toBeTruthy();
    expect(['member_contact', 'member_domain', 'member_fuzzy', 'non_member', 'unmatched']).toContain(body.matched);
  });

  test('AS2 — non-member attendee persists with match_type=non_member', async ({ request }) => {
    const payload = makePayload({ attendee: { email: 'random-stranger@unaffiliated-domain.example' } });
    const signed = signBody(payload, TEST_SECRET);
    const res = await request.post(`${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`, {
      data: signed.rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': signed.signatureHeader,
        'X-Chamber-Timestamp': signed.timestamp,
        'X-Request-ID': `req-as2-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.matched).toBe('non_member');
    expect(body.matchedMemberId).toBeNull();
  });

  test('AS3 — duplicate X-Request-ID within 7d returns 409 with no new registration', async ({ request }) => {
    const requestId = `req-as3-${Date.now()}`;
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
        'X-Request-ID': `req-as4-${Date.now()}`,
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
        'X-Request-ID': `req-as5-${Date.now()}`,
      },
    });
    expect(res.status()).toBe(401);
  });
});
