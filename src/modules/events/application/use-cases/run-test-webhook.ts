/**
 * `runTestWebhook` use-case (F6 Application, Phase 5 T072).
 *
 * Implements FR-023 + contracts/admin-integration-eventcreate-api.md
 * § POST test-webhook. Generates a synthetic signed payload with
 * sentinel external IDs (`__test_webhook__`), POSTs it to the tenant's
 * own webhook URL, awaits the round-trip response, and reports the
 * outcome to the admin UI.
 *
 * Sentinel contract (round-2 P8): the synthetic payload uses
 *   - `event.external_id === '__test_webhook__'`
 *   - `attendee.external_id === '__test_webhook__-<unix_seconds>'`
 *
 * The receiver detects the sentinel BEFORE the strict-transactional
 * ACID unit opens and short-circuits — no rows inserted into `events`,
 * `event_registrations`, or `eventcreate_idempotency_receipts`. The
 * receiver emits a `webhook_test_invoked` audit row with
 * `processing_outcome = 'short_circuited_test'`. This use-case is
 * NOT responsible for emitting that audit — the receiver owns the
 * audit-trail entry per contract spec line 127.
 *
 * Rate-limit: 10 tests/hour per (tenant, actor) — enforced at the
 * route layer (FR-023). The use-case is unaware of the limit so
 * tests are deterministic.
 *
 * Pure Application — `signRequest` (HMAC) and `httpFetch` (network)
 * are injected so unit tests stub both without touching crypto or
 * the network. Production wires `signRequest = signWebhookRequest`
 * + `httpFetch = global fetch` via the composition adapter (T074).
 *
 * Failure surface (caller renders user-friendly message):
 *   - `network_error` — fetch threw (DNS fail, TLS handshake, etc.)
 *   - `non_2xx_response` — receiver returned 4xx/5xx (signature
 *     mismatch, malformed body, tenant disabled, etc.)
 *   - `invalid_response_body` — receiver 200 but body shape unexpected
 */
import { ok, err, type Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { WebhookSecret } from '../../domain/branded-types';

export interface RunTestWebhookInput {
  readonly tenantId: TenantId;
  readonly tenantSlug: string;
  readonly webhookBaseUrl: string;
  readonly activeSecret: WebhookSecret;
  readonly actorUserId: UserId;
  /** Injected for deterministic test fixtures; production uses `new Date()`. */
  readonly now: Date;
}

export type ProcessingOutcomeLabel =
  | 'short_circuited_test'
  | 'matched_member_contact'
  | 'matched_member_domain'
  | 'matched_member_fuzzy'
  | 'non_member'
  | 'unmatched';

export type FailureCategory =
  | 'signature_mismatch'
  | 'timestamp_skew'
  | 'ingest_disabled'
  | 'rate_limited'
  | 'malformed_payload'
  | 'server_error'
  | 'network_error'
  | 'invalid_response_body';

export type RunTestWebhookOutcome =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly deliveredAt: string;
      readonly verifiedAt: string;
      readonly processingOutcome: ProcessingOutcomeLabel;
      readonly durationMs: number;
    }
  | {
      readonly ok: false;
      readonly requestId: string;
      readonly deliveredAt: string;
      readonly signatureOutcome: 'rejected' | 'unknown';
      readonly failureCategory: FailureCategory;
      readonly hint: string;
    };

export type RunTestWebhookError =
  | { readonly kind: 'invalid_base_url' }
  | { readonly kind: 'sign_failed'; readonly message: string };

export interface SignRequestFn {
  (input: {
    readonly secret: string;
    readonly rawBody: string;
    readonly now: Date;
  }): { readonly signatureHeader: string; readonly timestamp: string };
}

export interface HttpFetchFn {
  (url: string, init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
  }): Promise<{
    readonly status: number;
    readonly json: () => Promise<unknown>;
    readonly text: () => Promise<string>;
  }>;
}

export interface RunTestWebhookDeps {
  readonly signRequest: SignRequestFn;
  readonly httpFetch: HttpFetchFn;
}

/**
 * 4xx → mapped to `failureCategory` so the admin sees actionable
 * recovery copy.
 */
function mapFailureCategory(status: number): FailureCategory {
  if (status === 401) return 'signature_mismatch';
  if (status === 400) return 'malformed_payload';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'ingest_disabled';
  if (status >= 500) return 'server_error';
  return 'server_error';
}

function hintFor(category: FailureCategory): string {
  switch (category) {
    case 'signature_mismatch':
      return 'Did you save the secret correctly? Try rotating the secret and reconfiguring Zapier.';
    case 'timestamp_skew':
      return 'Server clock may be skewed >5 minutes. Retry; if it persists, contact support.';
    case 'ingest_disabled':
      return 'Ingest is disabled for this tenant. Enable it from the integration page to retry.';
    case 'rate_limited':
      return 'Too many test requests in the last hour. Wait and retry.';
    case 'malformed_payload':
      return 'The synthetic payload was rejected. Report this bug to support.';
    case 'server_error':
      return 'Chamber-OS returned an unexpected error. Retry; if it persists, contact support.';
    case 'network_error':
      return 'Could not reach the webhook endpoint. Check network connectivity.';
    case 'invalid_response_body':
      return 'Webhook responded but with an unexpected body shape. Contact support with this test request ID.';
  }
}

export async function runTestWebhook(
  input: RunTestWebhookInput,
  deps: RunTestWebhookDeps,
): Promise<Result<RunTestWebhookOutcome, RunTestWebhookError>> {
  // Cheap sanity check — invalid baseUrl is a programming bug, not a
  // user error. Caller should always pass a fully-qualified URL.
  let webhookUrl: string;
  try {
    const u = new URL(`/api/webhooks/eventcreate/v1/${input.tenantSlug}`, input.webhookBaseUrl);
    webhookUrl = u.toString();
  } catch {
    return err({ kind: 'invalid_base_url' });
  }

  const nowUnixSeconds = Math.floor(input.now.getTime() / 1000);
  // Round-6 verify-fix 2026-05-13 (type-design C2) — variable renamed
  // from `testRequestId` to `requestId` to mirror the audit payload
  // field-name convention now shared across the entire F6 webhook
  // audit family. The synthetic value format is unchanged
  // (`test-<unix>-<random>`) so existing correlation patterns in SRE
  // dashboards still match. (Round 2 C-H1 fix — earlier wording said
  // "from requestId to requestId" which was a typo of the original
  // identifier.)
  const requestId = `test-${nowUnixSeconds}-${Math.random().toString(36).slice(2, 10)}`;
  const syntheticPayload = {
    eventType: 'attendee.registered',
    tenantSlug: input.tenantSlug,
    event: {
      externalId: '__test_webhook__',
      name: 'Chamber-OS synthetic test event',
      description: null,
      startDate: input.now.toISOString(),
      endDate: null,
      location: null,
      category: null,
      eventCreateUrl: null,
    },
    attendee: {
      externalId: `__test_webhook__-${nowUnixSeconds}`,
      email: 'test-webhook@chamber-os.local',
      fullName: 'Chamber-OS Synthetic Tester',
      companyName: null,
      ticketType: null,
      ticketPricePaid: 0,
      paymentStatus: 'free' as const,
      registeredAt: input.now.toISOString(),
    },
    // Phase 5 review-fix S-05 (2026-05-13) — internal metadata field
    // recording the admin who clicked "Test webhook". Only present
    // on sentinel-recognised synthetic payloads + HMAC-signed by the
    // admin route, so the receiver can trust the claimed actor
    // (any other source would fail signature verification before
    // reaching the short-circuit branch). Receiver writes this into
    // the `webhook_test_invoked` audit row so role-enforcement drift
    // surfaces — if a non-admin path ever produces a test webhook,
    // `dispatchedByActorRole !== 'admin'` flags it for triage.
    chamberTestMetadata: {
      dispatchedByActorUserId: input.actorUserId,
      dispatchedByActorRole: 'admin' as const,
    },
  };

  const rawBody = JSON.stringify(syntheticPayload);

  let signed: ReturnType<SignRequestFn>;
  try {
    signed = deps.signRequest({
      secret: input.activeSecret,
      rawBody,
      now: input.now,
    });
  } catch (e) {
    return err({
      kind: 'sign_failed',
      message: e instanceof Error ? e.message : String(e),
    });
  }

  const startedAtMs = Date.now();
  let response: Awaited<ReturnType<HttpFetchFn>>;
  try {
    response = await deps.httpFetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': signed.signatureHeader,
        'X-Chamber-Timestamp': signed.timestamp,
        'X-Request-ID': requestId,
      },
      body: rawBody,
    });
  } catch {
    const deliveredAt = input.now.toISOString();
    return ok({
      ok: false,
      requestId,
      deliveredAt,
      signatureOutcome: 'unknown',
      failureCategory: 'network_error',
      hint: hintFor('network_error'),
    });
  }

  const durationMs = Date.now() - startedAtMs;
  const deliveredAt = input.now.toISOString();

  if (response.status !== 200) {
    const failureCategory = mapFailureCategory(response.status);
    return ok({
      ok: false,
      requestId,
      deliveredAt,
      signatureOutcome: response.status === 401 ? 'rejected' : 'unknown',
      failureCategory,
      hint: hintFor(failureCategory),
    });
  }

  // 200 OK — parse body to confirm short-circuit fired.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return ok({
      ok: false,
      requestId,
      deliveredAt,
      signatureOutcome: 'unknown',
      failureCategory: 'invalid_response_body',
      hint: hintFor('invalid_response_body'),
    });
  }

  // Receiver short-circuit shape (per T074 implementation):
  //   { ok: true, matched: 'short_circuited_test', ... }
  // OR a normal match-resolved shape from ingestWebhookAttendee.
  if (
    typeof body !== 'object' ||
    body === null ||
    !('ok' in body) ||
    !('matched' in body)
  ) {
    return ok({
      ok: false,
      requestId,
      deliveredAt,
      signatureOutcome: 'unknown',
      failureCategory: 'invalid_response_body',
      hint: hintFor('invalid_response_body'),
    });
  }

  const matched = (body as { matched: unknown }).matched;
  const processingOutcome = isProcessingOutcomeLabel(matched)
    ? matched
    : 'short_circuited_test';

  return ok({
    ok: true,
    requestId,
    deliveredAt,
    verifiedAt: deliveredAt,
    processingOutcome,
    durationMs,
  });
}

const PROCESSING_OUTCOME_LABELS: readonly ProcessingOutcomeLabel[] = [
  'short_circuited_test',
  'matched_member_contact',
  'matched_member_domain',
  'matched_member_fuzzy',
  'non_member',
  'unmatched',
];

function isProcessingOutcomeLabel(v: unknown): v is ProcessingOutcomeLabel {
  return (
    typeof v === 'string' &&
    (PROCESSING_OUTCOME_LABELS as readonly string[]).includes(v)
  );
}
