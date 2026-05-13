/**
 * Unit tests for `runTestWebhook` use-case (T072).
 *
 * Covers:
 *   - happy short-circuit — receiver returns ok=true + matched=short_circuited_test
 *   - happy normal match — receiver returns matched=matched_member_contact (unlikely
 *     but allowed by the contract)
 *   - 401 → failureCategory=signature_mismatch + signatureOutcome=rejected
 *   - 400 → failureCategory=malformed_payload
 *   - 429 → failureCategory=rate_limited
 *   - 503 → failureCategory=ingest_disabled
 *   - 500 → failureCategory=server_error
 *   - network throw → failureCategory=network_error
 *   - 200 with unexpected body shape → failureCategory=invalid_response_body
 *   - synthetic payload uses sentinel external IDs (`__test_webhook__`)
 *   - `signRequest` invoked with the rawBody actually POSTed
 *   - `httpFetch` invoked with the signed headers + URL composed from baseUrl + slug
 */
import { describe, expect, it, vi } from 'vitest';
import { runTestWebhook } from '@/modules/events/application/use-cases/run-test-webhook';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { WebhookSecret } from '@/modules/events';

const TENANT: TenantId = 'test-swecham' as TenantId;
const TENANT_SLUG = 'test-swecham';
const ACTOR: UserId = 'usr_admin_001' as UserId;
const SECRET = 'whsec_TEST_PLAINTEXT' as WebhookSecret;
const BASE_URL = 'https://app.test';

function makeSignRequest() {
  return vi.fn().mockReturnValue({
    signatureHeader: 'sha256=abc123',
    timestamp: '1700000000',
  });
}

function makeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const INPUT = {
  tenantId: TENANT,
  tenantSlug: TENANT_SLUG,
  webhookBaseUrl: BASE_URL,
  activeSecret: SECRET,
  actorUserId: ACTOR,
  now: new Date('2026-05-13T12:00:00.000Z'),
};

describe('runTestWebhook', () => {
  it('happy short-circuit — receiver returns matched=short_circuited_test', async () => {
    const signRequest = makeSignRequest();
    const httpFetch = makeFetch(200, {
      ok: true,
      matched: 'short_circuited_test',
      registrationId: null,
      eventCreated: false,
      quotaEffect: null,
    });

    const result = await runTestWebhook(INPUT, { signRequest, httpFetch });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.processingOutcome).toBe('short_circuited_test');
    expect(outcome.testRequestId).toMatch(/^test-/);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('happy normal match — receiver returned matched=matched_member_contact', async () => {
    const signRequest = makeSignRequest();
    const httpFetch = makeFetch(200, {
      ok: true,
      matched: 'matched_member_contact',
      registrationId: 'reg-1',
      eventCreated: true,
    });

    const result = await runTestWebhook(INPUT, { signRequest, httpFetch });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.processingOutcome).toBe('matched_member_contact');
  });

  it('401 → failureCategory=signature_mismatch + signatureOutcome=rejected', async () => {
    const signRequest = makeSignRequest();
    const httpFetch = makeFetch(401, { detail: 'Signature validation failed' });

    const result = await runTestWebhook(INPUT, { signRequest, httpFetch });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('signature_mismatch');
    expect(outcome.signatureOutcome).toBe('rejected');
    expect(outcome.hint).toContain('secret');
  });

  it('400 → failureCategory=malformed_payload', async () => {
    const result = await runTestWebhook(INPUT, {
      signRequest: makeSignRequest(),
      httpFetch: makeFetch(400, { errors: [] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('malformed_payload');
  });

  it('429 → failureCategory=rate_limited', async () => {
    const result = await runTestWebhook(INPUT, {
      signRequest: makeSignRequest(),
      httpFetch: makeFetch(429, { detail: 'rate limit' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('rate_limited');
  });

  it('503 → failureCategory=ingest_disabled', async () => {
    const result = await runTestWebhook(INPUT, {
      signRequest: makeSignRequest(),
      httpFetch: makeFetch(503, { detail: 'disabled' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('ingest_disabled');
  });

  it('500 → failureCategory=server_error', async () => {
    const result = await runTestWebhook(INPUT, {
      signRequest: makeSignRequest(),
      httpFetch: makeFetch(500, { detail: 'internal' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('server_error');
  });

  it('network throw → failureCategory=network_error', async () => {
    const httpFetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const result = await runTestWebhook(INPUT, {
      signRequest: makeSignRequest(),
      httpFetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('network_error');
  });

  it('200 with malformed body → failureCategory=invalid_response_body', async () => {
    const httpFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => 'not an object',
      text: async () => 'not an object',
    });
    const result = await runTestWebhook(INPUT, {
      signRequest: makeSignRequest(),
      httpFetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const outcome = result.value;
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.failureCategory).toBe('invalid_response_body');
  });

  it('synthetic payload uses sentinel external IDs', async () => {
    const signRequest = makeSignRequest();
    const httpFetch = makeFetch(200, { ok: true, matched: 'short_circuited_test' });

    await runTestWebhook(INPUT, { signRequest, httpFetch });

    const fetchCall = httpFetch.mock.calls[0]!;
    const requestBody = JSON.parse(fetchCall[1].body) as {
      event: { externalId: string };
      attendee: { externalId: string };
    };
    expect(requestBody.event.externalId).toBe('__test_webhook__');
    expect(requestBody.attendee.externalId).toMatch(/^__test_webhook__-\d+$/);
  });

  it('signRequest called with the rawBody actually POSTed', async () => {
    const signRequest = makeSignRequest();
    const httpFetch = makeFetch(200, { ok: true, matched: 'short_circuited_test' });

    await runTestWebhook(INPUT, { signRequest, httpFetch });

    const signCall = signRequest.mock.calls[0]![0];
    const fetchCall = httpFetch.mock.calls[0]!;
    expect(signCall.rawBody).toBe(fetchCall[1].body);
    expect(signCall.secret).toBe(SECRET);
    expect(signCall.now).toBe(INPUT.now);
  });

  it('webhook URL composed from baseUrl + slug', async () => {
    const httpFetch = makeFetch(200, { ok: true, matched: 'short_circuited_test' });
    await runTestWebhook(INPUT, { signRequest: makeSignRequest(), httpFetch });

    const fetchCall = httpFetch.mock.calls[0]!;
    expect(fetchCall[0]).toBe(
      `${BASE_URL}/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
    );
    expect(fetchCall[1].headers['X-Chamber-Signature']).toBe('sha256=abc123');
    expect(fetchCall[1].headers['X-Chamber-Timestamp']).toBe('1700000000');
    expect(fetchCall[1].headers['X-Request-ID']).toMatch(/^test-/);
  });

  it('invalid_base_url when webhookBaseUrl is not a valid URL', async () => {
    const result = await runTestWebhook(
      { ...INPUT, webhookBaseUrl: 'not a url' },
      {
        signRequest: makeSignRequest(),
        httpFetch: makeFetch(200, { ok: true, matched: 'short_circuited_test' }),
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error.kind).toBe('invalid_base_url');
  });
});
