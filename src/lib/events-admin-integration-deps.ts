/**
 * F6 admin-integration composition adapter (Phase 5 T074).
 *
 * Bridges `src/app/api/admin/integrations/eventcreate/**` route handlers
 * to the Application use-cases + Infrastructure adapters. Mirrors F6
 * Phase 4 `events-admin-deps.ts` precedent.
 *
 * Exposed factories (round-6 type-design C7 renamed disable→toggle):
 *   - `runLoadIntegrationConfig`   — GET config view + recent deliveries
 *   - `runGenerateWebhookSecret`   — POST generate-secret
 *   - `runRotateWebhookSecret`     — POST rotate-secret
 *   - `runRunTestWebhook`          — POST test-webhook
 *   - `runToggleIngest`            — POST disable (enable + disable)
 *   - `rotateSecretRateLimitCheck` — 3/hr/(tenant,actor) gate
 *   - `testWebhookRateLimitCheck`  — 10/hr/(tenant,actor) gate
 *
 * The `runDisableIngest` deprecated alias was dropped at Round 2
 * (Phase 5 verify-fix Round 2 / P3) — zero source-side callers and
 * F6 unshipped.
 *
 * **Principle III note**: this file imports the Drizzle
 * `tenantWebhookConfigs` table + `auditLog` directly. Per
 * `src/lib/events-webhook-deps.ts` precedent (Phase 3), `src/lib/**`
 * is the composition adapter layer — ESLint barrel-enforcement allows
 * deep imports here, and Application use-cases never reach this file.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { runInTenant } from '@/lib/db';
import { rateLimiter as authRateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { eventcreateMetrics } from '@/lib/metrics';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { asTenantId } from '@/modules/members';
import { asUserId } from '@/modules/auth';
// Phase 5 review-fix S-06 (2026-05-13) — use-cases + their error
// types now flow through the public barrel instead of deep-importing
// from `application/use-cases/*`. Same runtime behaviour; cleaner
// boundary for the rest of the project to follow.
import {
  generateWebhookSecret,
  rotateWebhookSecret,
  runTestWebhook,
  type GenerateWebhookSecretError,
  type RotateWebhookSecretError,
  type RunTestWebhookError,
  type RunTestWebhookOutcome,
} from '@/modules/events';
// Round 3 verify-fix 2026-05-13 — pull client-safe types + the
// `KNOWN_RECENT_PROCESSING_OUTCOMES` Set from the dedicated pure
// module. Eliminates the transitive Client Component leak that
// allowed `@/modules/members` barrel → F8 renewals deps → F5
// `revalidateTag` to bleed into the wizard's client-side bundle.
import {
  KNOWN_RECENT_PROCESSING_OUTCOMES,
  isKnownRecentProcessingOutcome,
  type IntegrationConfigView,
  type LoadConfigOptions,
  type RecentDelivery,
  type RecentDeliveryProcessingOutcome,
} from './events-admin-integration-types';
export {
  KNOWN_RECENT_PROCESSING_OUTCOMES,
  isKnownRecentProcessingOutcome,
  type IntegrationConfigView,
  type LoadConfigOptions,
  type RecentDelivery,
  type RecentDeliveryProcessingOutcome,
};
import {
  signWebhookRequest,
  asSecretLastFour,
  makeDrizzleTenantWebhookConfigRepository,
  type WebhookSecret,
  type TenantWebhookConfigAggregate,
  type SecretLastFour,
  type TenantWebhookConfigRepositoryError,
} from '@/modules/events';
// Use `makeAuditPortForTenant` composition factory from the barrel —
// avoids deep-import of the infrastructure adapter (matches barrel
// JSDoc intent; ESLint exemption for src/lib/** is no longer needed
// for this seam).
import { makeAuditPortForTenant as makePinoAuditPort } from '@/modules/events';
// Phase 5 review-fix S-07 (2026-05-13) — `tenantWebhookConfigs`
// import dropped after the barrel re-export was removed; the file
// no longer needs the raw schema reference. Tests now reach
// `@/modules/events/infrastructure/schema` directly.

// ---------------------------------------------------------------------------
// Rate limits (FR-008, FR-023)
// ---------------------------------------------------------------------------

const ROTATE_MAX_PER_HOUR = 3;
const TEST_WEBHOOK_MAX_PER_HOUR = 10;
// Phase 5 review-fix W-01 (2026-05-13) — generate-secret rate limit.
// Fresh tenant onboarding is a one-shot action; 3/hour matches the
// rotate-secret budget and prevents an attacker with a compromised
// admin session from hammering the endpoint (each call costs an
// Upstash check + a DB conflict probe even though the 409 idempotency
// bound prevents repeated writes).
const GENERATE_SECRET_MAX_PER_HOUR = 3;
const WINDOW_SECONDS = 3600;

/**
 * Outcome of a rate-limit `check`. Round-6 verify-fix 2026-05-13
 * (type-design C5) renamed the `reset: number` field to
 * `resetAtUnixMs` so the unit + epoch are visible at call sites
 * (previously callers had to inspect the Upstash adapter to know
 * whether `reset` was milliseconds-until-reset or absolute epoch ms).
 * The adapter returns absolute epoch ms; the field name now reflects
 * that contract.
 */
export interface RateLimitOutcome {
  readonly success: boolean;
  /** Absolute Unix epoch in milliseconds when the window resets. */
  readonly resetAtUnixMs: number;
}

/**
 * Phase E E6 — factory for F6 admin-integration rate-limit checks.
 * Replaces 3 near-identical wrappers (rotate / test-webhook /
 * generate-secret) that differed only in key prefix + per-hour cap.
 */
function makeF6RateLimitCheck(
  prefix: string,
  perHour: number,
): (tenantSlug: string, actorUserId: string) => Promise<RateLimitOutcome> {
  return async (tenantSlug, actorUserId) => {
    const result = await authRateLimiter.check(
      `${prefix}:${tenantSlug}:${actorUserId}`,
      perHour,
      WINDOW_SECONDS,
    );
    return { success: result.success, resetAtUnixMs: result.reset };
  };
}

export const rotateSecretRateLimitCheck = makeF6RateLimitCheck(
  'f6-rotate-secret',
  ROTATE_MAX_PER_HOUR,
);

export const testWebhookRateLimitCheck = makeF6RateLimitCheck(
  'f6-test-webhook',
  TEST_WEBHOOK_MAX_PER_HOUR,
);

/**
 * generate-secret rate-limit gate. 3 generations/hour per (tenant,
 * actor). Even though `generateWebhookSecret` returns 409
 * `secret_already_exists` after the first successful call, each
 * additional call still consumes Upstash budget AND incurs a DB
 * SELECT (conflict probe).
 */
export const generateSecretRateLimitCheck = makeF6RateLimitCheck(
  'f6-generate-secret',
  GENERATE_SECRET_MAX_PER_HOUR,
);

// ---------------------------------------------------------------------------
// GET config + recent deliveries
// ---------------------------------------------------------------------------

// Round 3 verify-fix 2026-05-13 — `RecentDelivery`,
// `RecentDeliveryProcessingOutcome`, `IntegrationConfigView`, and
// `LoadConfigOptions` moved to `events-admin-integration-types.ts`
// so client components can consume them without crossing the
// server-only dependency chain. Re-exported above for back-compat
// with existing call-sites that import from this lib file.

const RECENT_DELIVERIES_LIMIT = 10;
const DELIVERY_EVENT_TYPES = [
  'webhook_receipt_verified',
  'webhook_signature_rejected',
  'webhook_test_invoked',
  'webhook_duplicate_rejected',
  'webhook_malformed_rejected',
  'webhook_rolled_back',
] as const;

function mapSignatureOutcome(
  eventType: string,
): 'verified' | 'rejected' | 'unknown' {
  if (eventType === 'webhook_receipt_verified') return 'verified';
  if (eventType === 'webhook_test_invoked') return 'verified';
  if (eventType === 'webhook_signature_rejected') return 'rejected';
  return 'unknown';
}

function extractProcessingOutcome(
  payload: unknown,
): RecentDeliveryProcessingOutcome | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as Record<string, unknown>)['processingOutcome'];
  if (typeof raw !== 'string') return null;
  return isKnownRecentProcessingOutcome(raw) ? raw : 'unknown';
}

/**
 * Phase E E7 — consolidated payload-string extractor. Returns the
 * value at `key` when it's a string, otherwise null. Replaces 2
 * near-identical extractor helpers (matchedMemberId + registrationId).
 */
function getPayloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function extractMatchedMemberId(payload: unknown): string | null {
  return getPayloadString(payload, 'matchedMemberId');
}

function extractRegistrationId(payload: unknown): string | null {
  return getPayloadString(payload, 'registrationId');
}

export async function runLoadIntegrationConfig(
  tenantSlug: string,
  options: LoadConfigOptions,
): Promise<IntegrationConfigView> {
  const ctx: TenantContext = asTenantContext(tenantSlug);
  const webhookUrl = new URL(
    `/api/webhooks/eventcreate/v1/${tenantSlug}`,
    options.webhookBaseUrl,
  ).toString();

  return runInTenant(ctx, async (tx) => {
    const repo = makeDrizzleTenantWebhookConfigRepository(tx);
    const cfgResult = await repo.findByTenantSource(
      asTenantId(tenantSlug),
      'eventcreate',
    );

    let cfg: TenantWebhookConfigAggregate | null = null;
    if (cfgResult.ok) {
      cfg = cfgResult.value;
    } else {
      // Round-6 verify-fix 2026-05-13 (E4) — DB-load failure must
      // surface as a 500 rather than collapsing into a "first-visit
      // view". The previous behaviour displayed an empty wizard
      // (Phase A "Generate secret") to an admin whose tenant already
      // had a configured row — clicking Generate then hit 409
      // `already_exists` with zero hint that the prior visible state
      // was caused by an Infrastructure error. Caller route catches
      // and maps to 500 + RFC 7807 problem body (now with usable
      // `detail` after H6 fix).
      logger.error(
        { event: 'f6_load_integration_config_failed', tenantSlug, errKind: cfgResult.error.kind },
        '[F6] config load failed — propagating as 500',
      );
      throw new Error(
        `f6_load_integration_config_failed: ${cfgResult.error.kind}`,
      );
    }

    if (!cfg) {
      return {
        secretConfigured: false,
        webhookUrl,
        recentDeliveries: [],
        recentDeliveriesIncludeTests: options.includeTestDeliveries,
      } satisfies IntegrationConfigView;
    }

    // Recent deliveries query. RLS-scoped via runInTenant tx, so
    // tenant_id predicate is enforced by policy + index. Belt-and-
    // braces: explicit `eq(auditLog.tenantId, tenantSlug)` for index
    // utilisation. Round-6 verify-fix 2026-05-13 (code #7) — push the
    // `webhook_test_invoked` filter into SQL when `!includeTestDeliveries`
    // so the DB returns exactly `LIMIT` rows instead of over-fetching
    // 2–3× for the JS-side filter loop. Receiver emits
    // `webhook_test_invoked` ONLY for short-circuit test paths
    // (sentinel external IDs); no production webhook delivery uses
    // this event type, so filtering by event_type is equivalent to
    // "this is a synthetic test delivery".
    const baseWhere = and(
      eq(auditLog.tenantId, tenantSlug),
      // Our 6-event subset is a small constant; the broader
      // `audit_event_type` Drizzle enum spans the union of all F1-F8
      // event types. The PgEnumColumn typing requires `as const`
      // widening that doesn't compose with a `readonly` tuple, so use
      // a raw SQL `IN (...)` template to bypass the overload picker.
      sql`${auditLog.eventType} IN (${sql.join(
        DELIVERY_EVENT_TYPES.map((t) => sql`${t}`),
        sql`, `,
      )})`,
    );
    const rows = await tx
      .select({
        timestamp: auditLog.timestamp,
        eventType: auditLog.eventType,
        requestId: auditLog.requestId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(
        options.includeTestDeliveries
          ? baseWhere
          : and(
              baseWhere,
              ne(
                auditLog.eventType,
                // Cast through `never` because the enum literal union
                // doesn't include F6's `ALTER TYPE`-added members at
                // compile time (same precedent as pino-audit-port.ts).
                'webhook_test_invoked' as never,
              ),
            ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(RECENT_DELIVERIES_LIMIT);

    const recent: RecentDelivery[] = rows.map((row) => {
      const isTestRow = (row.eventType as string) === 'webhook_test_invoked';
      const processingOutcome: RecentDeliveryProcessingOutcome | null =
        isTestRow ? 'short_circuited_test' : extractProcessingOutcome(row.payload);
      return {
        receivedAt: new Date(row.timestamp).toISOString(),
        requestId: row.requestId,
        signatureOutcome: mapSignatureOutcome(row.eventType),
        processingOutcome,
        matchedMemberId: extractMatchedMemberId(row.payload),
        registrationId: extractRegistrationId(row.payload),
      };
    });

    const graceActiveUntil =
      cfg.graceRotatedAt !== null
        ? new Date(cfg.graceRotatedAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
        : null;

    return {
      secretConfigured: true,
      webhookUrl,
      // Round 2 type-design Concern A fix (2026-05-13) — dropped the
      // unnecessary `as unknown as string` double-cast. `WebhookSecret
      // = string & { __brand }` is already assignable to `string` (the
      // brand intersection is covariant on the unbranded supertype).
      secretLastFour: asSecretLastFour(cfg.activeSecret),
      graceActiveUntil,
      ingestEnabled: cfg.enabled,
      lastReceivedAt: cfg.lastReceivedAt
        ? cfg.lastReceivedAt.toISOString()
        : null,
      recentDeliveries: recent,
      recentDeliveriesIncludeTests: options.includeTestDeliveries,
    } satisfies IntegrationConfigView;
  });
}

// ---------------------------------------------------------------------------
// Shared secret-generation factory (32-byte base64url)
// ---------------------------------------------------------------------------

function freshSecret(): WebhookSecret {
  return randomBytes(32).toString('base64url') as WebhookSecret;
}

// ---------------------------------------------------------------------------
// POST generate-secret
// ---------------------------------------------------------------------------

export async function runGenerateWebhookSecret(
  tenantSlug: string,
  actorUserId: string,
): Promise<
  Result<{ secret: string; secretLastFour: SecretLastFour }, GenerateWebhookSecretError>
> {
  const ctx: TenantContext = asTenantContext(tenantSlug);
  const result = await runInTenant(ctx, async (tx) => {
    const repo = makeDrizzleTenantWebhookConfigRepository(tx);
    const audit = makePinoAuditPort(tx);
    return generateWebhookSecret(
      {
        tenantId: asTenantId(tenantSlug),
        source: 'eventcreate',
        actorUserId: asUserId(actorUserId),
        now: new Date(),
      },
      { repo, audit, generateSecret: freshSecret },
    );
  });
  // Round 3 H3 (2026-05-13) — generate counter parity with rotate's
  // SF-H2/H3 dashboard-truth pattern. When the use-case returns
  // `audit_emit_failed`, the DB row HAS already been written (audit
  // emission happens AFTER `repo.create`); gating the counter on
  // `result.ok` would under-count audit-fail commits and hide
  // audit-orphan rows in dashboards. Wrapped in try/catch so a
  // metric-port throw never crashes the route.
  const generationCommitted =
    result.ok || result.error.kind === 'audit_emit_failed';
  if (generationCommitted) {
    try {
      eventcreateMetrics.webhookSecretGenerated(tenantSlug);
    } catch (metricErr) {
      logger.warn(
        {
          event: 'f6_metric_emit_failed',
          metricName: 'webhookSecretGenerated',
          tenantSlug,
          err: metricErr instanceof Error ? metricErr.message : String(metricErr),
        },
        '[F6] metric emit failed (suppressed) — counter undercount possible',
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// POST rotate-secret
// ---------------------------------------------------------------------------

export async function runRotateWebhookSecret(
  tenantSlug: string,
  actorUserId: string,
): Promise<
  Result<
    { secret: string; secretLastFour: SecretLastFour; graceActiveUntil: string },
    RotateWebhookSecretError
  >
> {
  const ctx: TenantContext = asTenantContext(tenantSlug);
  const result = await runInTenant(ctx, async (tx) => {
    const repo = makeDrizzleTenantWebhookConfigRepository(tx);
    const audit = makePinoAuditPort(tx);
    return rotateWebhookSecret(
      {
        tenantId: asTenantId(tenantSlug),
        source: 'eventcreate',
        actorUserId: asUserId(actorUserId),
        now: new Date(),
      },
      { repo, audit, generateSecret: freshSecret },
    );
  });
  // FR-036 #8 — emit secret-rotation counter on successful commit.
  //
  // Round 2 SF-H2 fix (2026-05-13) — also emit on `audit_emit_failed`.
  // Reasoning mirrors the H3 dashboard-truth invariant applied to
  // `runToggleIngest`: when the use-case returns `audit_emit_failed`,
  // the DB row HAS already mutated (audit emission happens AFTER
  // `repo.rotateSecret` in the use-case). Gating the counter on
  // `result.ok` under-counts every audit-fail rotation — masking a
  // real ops event in dashboards. The forensic-trail gap is still
  // surfaced separately via the route's 500 + the use-case's
  // `logger.fatal` line.
  //
  // Round-6 verify-fix (E5) wraps the emit in try/catch so a
  // metric-port throw never crashes the route.
  const rotationCommitted =
    result.ok || result.error.kind === 'audit_emit_failed';
  if (rotationCommitted) {
    try {
      eventcreateMetrics.webhookSecretRotated(tenantSlug);
    } catch (metricErr) {
      logger.warn(
        {
          event: 'f6_metric_emit_failed',
          metricName: 'webhookSecretRotated',
          tenantSlug,
          err: metricErr instanceof Error ? metricErr.message : String(metricErr),
        },
        '[F6] metric emit failed (suppressed) — counter undercount possible',
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// POST test-webhook
// ---------------------------------------------------------------------------

export interface RunTestWebhookComposeInput {
  readonly webhookBaseUrl: string;
}

export async function runRunTestWebhook(
  tenantSlug: string,
  actorUserId: string,
  options: RunTestWebhookComposeInput,
): Promise<
  Result<
    RunTestWebhookOutcome,
    | RunTestWebhookError
    | { kind: 'config_missing' }
    | { kind: 'config_load_failed'; errKind: string }
  >
> {
  const ctx: TenantContext = asTenantContext(tenantSlug);

  // Load active secret outside the use-case (use-case is HTTP-bound,
  // no transactional reason to keep config read inside the same tx).
  const cfg = await runInTenant(ctx, async (tx) => {
    const repo = makeDrizzleTenantWebhookConfigRepository(tx);
    return repo.findByTenantSource(asTenantId(tenantSlug), 'eventcreate');
  });
  // Round 3 M-err-7 (2026-05-13) — separate the "DB load failed"
  // discriminant from "row not present". Previously both returned
  // `config_missing` and the route mapped to 404, causing transient
  // Neon outages to surface as "tenant not configured" 404s even when
  // the tenant IS configured. Route now maps `config_load_failed` →
  // 500 + RFC 7807 problem body.
  if (!cfg.ok) {
    logger.error(
      { event: 'f6_test_webhook_config_load_failed', tenantSlug, errKind: cfg.error.kind },
      '[F6] test-webhook config load failed',
    );
    // Phase 5 review-fix W-07 — count failure outcomes too.
    safeEmitTestInvokedMetric(tenantSlug, 'failure');
    return err({ kind: 'config_load_failed', errKind: cfg.error.kind });
  }
  if (cfg.value === null) {
    // Phase 5 review-fix W-07 — count failure outcomes too.
    safeEmitTestInvokedMetric(tenantSlug, 'failure');
    return err({ kind: 'config_missing' });
  }

  const useCaseResult = await runTestWebhook(
    {
      tenantId: asTenantId(tenantSlug),
      tenantSlug,
      webhookBaseUrl: options.webhookBaseUrl,
      activeSecret: cfg.value.activeSecret,
      actorUserId: asUserId(actorUserId),
      now: new Date(),
    },
    {
      signRequest: signWebhookRequest,
      httpFetch: async (url, init) => {
        // Phase 5 review-fix W-02 (2026-05-13) — 10s AbortSignal
        // timeout. Without this, a stuck receiver (advisory-lock
        // contention, Neon connectivity glitch, cold function start
        // targeting itself) blocks the admin route until Vercel
        // platform timeout (~30s) before surfacing as a generic
        // failure. 10s is conservative-but-actionable: the receiver's
        // happy path is sub-100ms p95 (SC-003 budget <300ms), so 10s
        // is 33× headroom for real outage detection without false
        // positives under cold-start latency.
        const TEST_WEBHOOK_TIMEOUT_MS = 10_000;
        try {
          const res = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(TEST_WEBHOOK_TIMEOUT_MS),
          });
          return {
            status: res.status,
            json: () => res.json(),
            text: () => res.text(),
          };
        } catch (e) {
          // Round-6 verify-fix 2026-05-13 (errors E6) — log the
          // underlying fetch failure so SREs can diagnose DNS / TLS
          // handshake / abort / timeout causes without manual repro.
          // The use-case re-throws via its own try/catch as
          // `failureCategory='network_error'`, so the user-facing
          // outcome is unchanged — this log is forensic-only.
          //
          // Round 2 SF-LOW7 fix (2026-05-13) — also capture `e.cause`
          // (the actual undici syscall code: ENOTFOUND / ECONNREFUSED
          // / CERT_HAS_EXPIRED / UND_ERR_SOCKET / …). Native undici
          // fetch wraps the syscall error in a generic TypeError
          // ("fetch failed") and exposes the root via `.cause`. Without
          // this, SREs see only "fetch failed" + "TypeError" with no
          // actionable hint.
          const cause =
            e instanceof Error && 'cause' in e
              ? (e as { cause: unknown }).cause
              : null;
          logger.warn(
            {
              event: 'f6_test_webhook_fetch_threw',
              tenantSlug,
              url,
              err: e instanceof Error ? e.message : String(e),
              errName: e instanceof Error ? e.name : null,
              errCause:
                cause === null || cause === undefined
                  ? null
                  : typeof cause === 'object' && 'code' in cause
                    ? String((cause as { code: unknown }).code)
                    : String(cause),
            },
            '[F6] test-webhook outbound fetch threw — failureCategory=network_error will be returned',
          );
          throw e;
        }
      },
    },
  );

  // Phase 5 review-fix W-07 (2026-05-13) — emit test-invoked metric
  // on every completed round-trip. We classify by `result.ok` AND by
  // the inner `RunTestWebhookOutcome.ok` (the use-case returns
  // `Result.ok` even when the receiver returned 4xx/5xx — the outer
  // Result only fails on signing errors / invalid_base_url, which are
  // programming bugs not user-facing failures).
  const outcome: 'success' | 'failure' =
    useCaseResult.ok && useCaseResult.value.ok ? 'success' : 'failure';
  safeEmitTestInvokedMetric(tenantSlug, outcome);
  return useCaseResult;
}

/** Phase 5 review-fix W-07 — safe metric emit helper for test-webhook. */
function safeEmitTestInvokedMetric(
  tenantSlug: string,
  outcome: 'success' | 'failure',
): void {
  try {
    eventcreateMetrics.webhookTestInvoked(tenantSlug, outcome);
  } catch (metricErr) {
    logger.warn(
      {
        event: 'f6_metric_emit_failed',
        metricName: 'webhookTestInvoked',
        tenantSlug,
        err: metricErr instanceof Error ? metricErr.message : String(metricErr),
      },
      '[F6] metric emit failed (suppressed) — counter undercount possible',
    );
  }
}

// ---------------------------------------------------------------------------
// POST disable (admin kill-switch toggle per FR-033)
// ---------------------------------------------------------------------------

/**
 * Round 3 M-type-5 (2026-05-13) — operator-supplied explanation is a
 * branded `BoundedReason` (1-500 chars, non-empty after trim).
 * Previously typed as a free `string` — the 1-500 invariant lived
 * only in the JSDoc + the route's zod schema. The brand lifts the
 * invariant into the type system so a future caller bypassing the
 * route-layer validation (test helpers, internal admin scripts) gets
 * a compile error instead of corrupting the audit row.
 */
export type BoundedReason = string & { readonly __brand: 'BoundedReason' };

export function asBoundedReason(raw: string): BoundedReason {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    throw new Error(
      `asBoundedReason: length must be 1-500 after trim, got ${trimmed.length}`,
    );
  }
  return trimmed as BoundedReason;
}

/**
 * Canonical name is `ToggleIngestInput` (the surface handles BOTH
 * enable and disable).
 */
export interface ToggleIngestInput {
  readonly enabled: boolean;
  /** 1-500 char operator-supplied explanation captured in the audit row. */
  readonly reason: BoundedReason;
}

export type ToggleIngestError =
  | TenantWebhookConfigRepositoryError
  | { readonly kind: 'audit_emit_failed'; readonly message: string };

export async function runToggleIngest(
  tenantSlug: string,
  actorUserId: string,
  input: ToggleIngestInput,
): Promise<Result<{ enabled: boolean }, ToggleIngestError>> {
  const ctx: TenantContext = asTenantContext(tenantSlug);
  // Round-6 verify-fix 2026-05-13 (H3 metric drift) — captured outside
  // the tx callback so we can correctly emit the FR-036 #9 gauge in
  // BOTH the all-good path AND the "DB committed but audit emit
  // failed" path. The previous version only emitted on `result.ok`,
  // which meant audit-emit failure left the gauge stuck at the prior
  // value while the DB state had actually flipped — a real
  // observability/state-truth gap.
  let dbStateMutated = false;
  let mutatedEnabledState = input.enabled;

  const result = await runInTenant(ctx, async (tx) => {
    const repo = makeDrizzleTenantWebhookConfigRepository(tx);
    const audit = makePinoAuditPort(tx);

    const before = await repo.findByTenantSource(
      asTenantId(tenantSlug),
      'eventcreate',
    );
    if (!before.ok) return before;
    if (before.value === null) {
      return err({
        kind: 'not_found' as const,
        tenantId: asTenantId(tenantSlug),
        source: 'eventcreate' as const,
      });
    }
    const enabledBefore = before.value.enabled;

    const update = await repo.setEnabled(
      asTenantId(tenantSlug),
      'eventcreate',
      input.enabled,
    );
    if (!update.ok) return update;
    // Row mutated successfully. Even if audit emit fails below and the
    // outer Result becomes Result.err, the DB row WILL commit at tx-end
    // (Drizzle commits unless we throw). The gauge therefore must
    // reflect the post-mutation state regardless of audit outcome.
    dbStateMutated = true;
    mutatedEnabledState = update.value.enabled;

    const auditRes = await audit.emit({
      eventType: 'ingest_disabled_tenant_admin',
      tenantId: asTenantId(tenantSlug),
      actorType: 'admin',
      actorUserId: asUserId(actorUserId),
      occurredAt: new Date(),
      summary: `tenant ingest ${enabledBefore ? 'enabled' : 'disabled'} → ${input.enabled ? 'enabled' : 'disabled'}: ${input.reason}`,
      payload: {
        severity: 'warn',
        actorUserId: asUserId(actorUserId),
        enabledBefore,
        enabledAfter: input.enabled,
        reason: input.reason,
      },
    });
    if (!auditRes.ok) {
      logger.fatal(
        {
          event: 'f6_disable_ingest_audit_emit_failed',
          tenantSlug,
          enabledBefore,
          enabledAfter: input.enabled,
        },
        '[F6] CRITICAL: ingest toggled but audit emit failed',
      );
      return err({
        kind: 'audit_emit_failed' as const,
        message: 'audit emit failed',
      });
    }

    return ok({ enabled: update.value.enabled });
  });
  // FR-036 #9 — emit ingest-disabled gauge after the DB row mutated
  // (regardless of audit emit outcome) so the dashboard + alert reflect
  // the actual DB state. Wrap in try/catch so a metric-port throw
  // (e.g. Prometheus gateway unreachable) never crashes the route —
  // gauge emission is observability, NOT a correctness invariant.
  if (dbStateMutated) {
    try {
      eventcreateMetrics.ingestDisabledTenant(
        tenantSlug,
        mutatedEnabledState,
      );
    } catch (metricErr) {
      logger.warn(
        {
          event: 'f6_metric_emit_failed',
          metricName: 'ingestDisabledTenant',
          tenantSlug,
          err: metricErr instanceof Error ? metricErr.message : String(metricErr),
        },
        '[F6] metric emit failed (suppressed) — dashboard drift possible until next state change',
      );
    }
  }
  return result;
}

// Round 2 simplifier P3 (2026-05-13) — the `runDisableIngest`
// deprecated alias was dropped this round (zero source-side callers;
// F6 unshipped). Single canonical name `runToggleIngest`.

// ---------------------------------------------------------------------------
// Note on nav-visibility (T081): the integration nav entry is shown
// unconditionally when `FEATURE_F6_EVENTCREATE=true` (see
// `contracts/admin-integration-eventcreate-api.md` § "Navigation
// visibility (R1, revised 2026-05-13)"). The earlier `isEventcreate
// NavVisible()` resolver was removed in verify-fix round 2 (G2) per
// Constitution Principle X (Simplicity / YAGNI) — speculative
// "future per-tenant opt-out config" code with zero current callers.
// The extension points that DO remain (and are sufficient if a real
// opt-out requirement materialises later):
//   - `NavVisibilityFlag` typed union (src/config/nav.ts)
//   - `visibilityFlag` field on `NavItem`
//   - `filterNavConfig()` in `src/components/layout/staff-sidebar.tsx`
// A future resolver would be ~30 lines to add against those hooks,
// shaped by the real requirement at that time (admin toggle, DB
// column, super-admin override, etc.) rather than the Phase 5
// strict-R1 freshness logic that this file used to host.
// ---------------------------------------------------------------------------

// Phase 5 review-fix S-07 (2026-05-13) — the `tenantWebhookConfigs`
// raw-table re-export was removed. Tests that probe the table
// directly import from `@/modules/events/infrastructure/schema` (the
// canonical location); the public surface should NOT widen to
// production callers via the barrel. The barrel's "no raw Drizzle
// adapters" rule is now consistent across all F6 tables.
