/**
 * F6 admin-integration composition adapter (Phase 5 T074).
 *
 * Bridges `src/app/api/admin/integrations/eventcreate/**` route handlers
 * to the Application use-cases + Infrastructure adapters. Mirrors F6
 * Phase 4 `events-admin-deps.ts` precedent.
 *
 * Exposed factories:
 *   - `runLoadIntegrationConfig`   — GET config view + recent deliveries
 *   - `runGenerateWebhookSecret`   — POST generate-secret
 *   - `runRotateWebhookSecret`     — POST rotate-secret
 *   - `runRunTestWebhook`          — POST test-webhook
 *   - `runDisableIngest`           — POST disable
 *   - `rotateSecretRateLimitCheck` — 3/hr/(tenant,actor) gate
 *   - `testWebhookRateLimitCheck`  — 10/hr/(tenant,actor) gate
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
import {
  generateWebhookSecret,
  type GenerateWebhookSecretError,
} from '@/modules/events/application/use-cases/generate-webhook-secret';
import {
  rotateWebhookSecret,
  type RotateWebhookSecretError,
} from '@/modules/events/application/use-cases/rotate-webhook-secret';
import {
  runTestWebhook,
  type RunTestWebhookError,
  type RunTestWebhookOutcome,
  type ProcessingOutcomeLabel,
} from '@/modules/events/application/use-cases/run-test-webhook';
import {
  signWebhookRequest,
  type WebhookSecret,
  type TenantWebhookConfigAggregate,
} from '@/modules/events';
import { asSecretLastFour, type SecretLastFour } from '@/modules/events/domain/secret-last-four';
import { makeDrizzleTenantWebhookConfigRepository } from '@/modules/events/infrastructure/drizzle-tenant-webhook-config-repository';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import { tenantWebhookConfigs } from '@/modules/events/infrastructure/schema';
import type { TenantWebhookConfigRepositoryError } from '@/modules/events/application/ports/tenant-webhook-config-repository';

// ---------------------------------------------------------------------------
// Rate limits (FR-008, FR-023)
// ---------------------------------------------------------------------------

const ROTATE_MAX_PER_HOUR = 3;
const TEST_WEBHOOK_MAX_PER_HOUR = 10;
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

export async function rotateSecretRateLimitCheck(
  tenantSlug: string,
  actorUserId: string,
): Promise<RateLimitOutcome> {
  const result = await authRateLimiter.check(
    `f6-rotate-secret:${tenantSlug}:${actorUserId}`,
    ROTATE_MAX_PER_HOUR,
    WINDOW_SECONDS,
  );
  return { success: result.success, resetAtUnixMs: result.reset };
}

export async function testWebhookRateLimitCheck(
  tenantSlug: string,
  actorUserId: string,
): Promise<RateLimitOutcome> {
  const result = await authRateLimiter.check(
    `f6-test-webhook:${tenantSlug}:${actorUserId}`,
    TEST_WEBHOOK_MAX_PER_HOUR,
    WINDOW_SECONDS,
  );
  return { success: result.success, resetAtUnixMs: result.reset };
}

// ---------------------------------------------------------------------------
// GET config + recent deliveries
// ---------------------------------------------------------------------------

/**
 * One row of the recent-deliveries panel. The `processingOutcome` is
 * typed as the closed `ProcessingOutcomeLabel` union (with `'unknown'`
 * for non-matching receiver-side enum extensions) plus `null` when the
 * underlying audit event carries no `processingOutcome` (e.g. a
 * `webhook_signature_rejected` row).
 *
 * Round-6 verify-fix 2026-05-13 (type-design C3) — was previously
 * `string | null` which let the UI sneak past compile-time checks by
 * receiving a free-form receiver-side string. The typed enum forces
 * a deliberate widening when a new processing outcome is added.
 */
export type RecentDeliveryProcessingOutcome =
  | ProcessingOutcomeLabel
  | 'duplicate'
  | 'malformed'
  | 'rolled_back'
  | 'rate_limited'
  | 'ingest_disabled'
  | 'unknown';

export interface RecentDelivery {
  readonly receivedAt: string;
  readonly requestId: string;
  readonly signatureOutcome: 'verified' | 'rejected' | 'unknown';
  readonly processingOutcome: RecentDeliveryProcessingOutcome | null;
  readonly matchedMemberId: string | null;
  readonly registrationId: string | null;
}

/**
 * Discriminated view of the F6 integration config — Round-6 verify-fix
 * 2026-05-13 (type-design C4) replaced a flat-bag `interface` with two
 * mutually-exclusive variants keyed on `secretConfigured`. Prior shape
 * allowed `{secretConfigured: false, secretLastFour: 'abcd'}` to
 * compile even though the runtime code never produced such a row;
 * the discriminant now makes that representation illegal.
 *
 * Consumers (page server component + `<WebhookConfigWizard>`) narrow
 * on `secretConfigured` before accessing the post-config fields.
 */
export type IntegrationConfigView =
  | {
      readonly secretConfigured: false;
      readonly webhookUrl: string;
      readonly recentDeliveries: ReadonlyArray<RecentDelivery>;
      readonly recentDeliveriesIncludeTests: boolean;
    }
  | {
      readonly secretConfigured: true;
      readonly webhookUrl: string;
      readonly secretLastFour: SecretLastFour;
      readonly graceActiveUntil: string | null;
      readonly ingestEnabled: boolean;
      readonly lastReceivedAt: string | null;
      readonly recentDeliveries: ReadonlyArray<RecentDelivery>;
      readonly recentDeliveriesIncludeTests: boolean;
    };

export interface LoadConfigOptions {
  readonly includeTestDeliveries: boolean;
  readonly webhookBaseUrl: string;
}

const RECENT_DELIVERIES_LIMIT = 10;
const DELIVERY_EVENT_TYPES = [
  'webhook_receipt_verified',
  'webhook_signature_rejected',
  'webhook_test_invoked',
  'webhook_duplicate_rejected',
  'webhook_malformed_rejected',
  'webhook_rolled_back',
] as const;

const KNOWN_RECENT_PROCESSING_OUTCOMES: ReadonlySet<RecentDeliveryProcessingOutcome> = new Set<
  RecentDeliveryProcessingOutcome
>([
  'short_circuited_test',
  'matched_member_contact',
  'matched_member_domain',
  'matched_member_fuzzy',
  'non_member',
  'unmatched',
  'duplicate',
  'malformed',
  'rolled_back',
  'rate_limited',
  'ingest_disabled',
]);

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
  const p = payload as Record<string, unknown>;
  const raw = p['processingOutcome'];
  if (typeof raw !== 'string') return null;
  return KNOWN_RECENT_PROCESSING_OUTCOMES.has(
    raw as RecentDeliveryProcessingOutcome,
  )
    ? (raw as RecentDeliveryProcessingOutcome)
    : 'unknown';
}

function extractMatchedMemberId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const value = p['matchedMemberId'];
  return typeof value === 'string' ? value : null;
}

function extractRegistrationId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const value = p['registrationId'];
  return typeof value === 'string' ? value : null;
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
      secretLastFour: asSecretLastFour(cfg.activeSecret as unknown as string),
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
  return runInTenant(ctx, async (tx) => {
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
  // FR-036 #8 — emit secret-rotation counter ONLY on successful commit
  // (post-tx so a rollback never overcounts). Round-6 verify-fix (E5)
  // wraps in try/catch so a metric-port throw never crashes the route.
  if (result.ok) {
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
): Promise<Result<RunTestWebhookOutcome, RunTestWebhookError | { kind: 'config_missing' }>> {
  const ctx: TenantContext = asTenantContext(tenantSlug);

  // Load active secret outside the use-case (use-case is HTTP-bound,
  // no transactional reason to keep config read inside the same tx).
  const cfg = await runInTenant(ctx, async (tx) => {
    const repo = makeDrizzleTenantWebhookConfigRepository(tx);
    return repo.findByTenantSource(asTenantId(tenantSlug), 'eventcreate');
  });
  if (!cfg.ok) {
    logger.error(
      { event: 'f6_test_webhook_config_load_failed', tenantSlug, errKind: cfg.error.kind },
      '[F6] test-webhook config load failed',
    );
    return err({ kind: 'config_missing' });
  }
  if (cfg.value === null) {
    return err({ kind: 'config_missing' });
  }

  return runTestWebhook(
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
        try {
          const res = await fetch(url, init);
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
          logger.warn(
            {
              event: 'f6_test_webhook_fetch_threw',
              tenantSlug,
              url,
              err: e instanceof Error ? e.message : String(e),
              errName: e instanceof Error ? e.name : null,
            },
            '[F6] test-webhook outbound fetch threw — failureCategory=network_error will be returned',
          );
          throw e;
        }
      },
    },
  );
}

// ---------------------------------------------------------------------------
// POST disable (admin kill-switch toggle per FR-033)
// ---------------------------------------------------------------------------

/**
 * Round-6 verify-fix 2026-05-13 (type-design C7) — renamed from
 * `DisableInput` to `ToggleIngestInput` because the surface handles
 * BOTH enable and disable directions (calling `runDisableIngest(...,
 * { enabled: true, ... })` to re-enable reads contradictorily). The
 * old `DisableInput` + `runDisableIngest` names persist below as
 * `@deprecated` aliases so external callers see a single-cycle
 * migration window.
 */
export interface ToggleIngestInput {
  readonly enabled: boolean;
  /** 1-500 char operator-supplied explanation captured in the audit row. */
  readonly reason: string;
}

/**
 * @deprecated Use {@link ToggleIngestInput}. Removed in F6 v2.
 */
export type DisableInput = ToggleIngestInput;

export type ToggleIngestError =
  | TenantWebhookConfigRepositoryError
  | { readonly kind: 'audit_emit_failed'; readonly message: string };

/**
 * @deprecated Use {@link ToggleIngestError}. Removed in F6 v2.
 */
export type DisableError = ToggleIngestError;

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

/**
 * @deprecated Backwards-compat alias for {@link runToggleIngest}.
 * Removed in F6 v2 once all callers migrate.
 */
export const runDisableIngest = runToggleIngest;

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

// Re-export needed schema for tests that want to probe directly.
export { tenantWebhookConfigs };
