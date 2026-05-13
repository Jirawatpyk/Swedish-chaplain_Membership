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
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { env } from '@/lib/env';
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
} from '@/modules/events/application/use-cases/run-test-webhook';
import {
  signWebhookRequest,
  type WebhookSecret,
  type TenantWebhookConfigAggregate,
} from '@/modules/events';
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

export interface RateLimitOutcome {
  readonly success: boolean;
  readonly reset: number;
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
  return { success: result.success, reset: result.reset };
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
  return { success: result.success, reset: result.reset };
}

// ---------------------------------------------------------------------------
// GET config + recent deliveries
// ---------------------------------------------------------------------------

export interface RecentDelivery {
  readonly receivedAt: string;
  readonly requestId: string;
  readonly signatureOutcome: 'verified' | 'rejected' | 'unknown';
  readonly processingOutcome: string | null;
  readonly matchedMemberId: string | null;
  readonly registrationId: string | null;
}

export interface IntegrationConfigView {
  readonly webhookUrl: string;
  readonly secretConfigured: boolean;
  readonly secretLastFour?: string;
  readonly graceActiveUntil?: string | null;
  readonly ingestEnabled: boolean;
  readonly lastReceivedAt?: string | null;
  readonly recentDeliveries: ReadonlyArray<RecentDelivery>;
  readonly recentDeliveriesIncludeTests: boolean;
}

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

function lastFour(s: string): string {
  return s.slice(-4);
}

function mapSignatureOutcome(
  eventType: string,
): 'verified' | 'rejected' | 'unknown' {
  if (eventType === 'webhook_receipt_verified') return 'verified';
  if (eventType === 'webhook_test_invoked') return 'verified';
  if (eventType === 'webhook_signature_rejected') return 'rejected';
  return 'unknown';
}

function extractProcessingOutcome(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;
  return typeof p['processingOutcome'] === 'string'
    ? (p['processingOutcome'] as string)
    : null;
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
      logger.error(
        { event: 'f6_load_integration_config_failed', tenantSlug, errKind: cfgResult.error.kind },
        '[F6] config load failed — returning first-visit view',
      );
    }

    if (!cfg) {
      return {
        webhookUrl,
        secretConfigured: false,
        ingestEnabled: false,
        recentDeliveries: [],
        recentDeliveriesIncludeTests: options.includeTestDeliveries,
      } satisfies IntegrationConfigView;
    }

    // Recent deliveries query. RLS-scoped via runInTenant tx, so
    // tenant_id predicate is enforced by policy + index. Belt-and-
    // braces: explicit `eq(auditLog.tenantId, tenantSlug)` for index
    // utilisation.
    const rows = await tx
      .select({
        timestamp: auditLog.timestamp,
        eventType: auditLog.eventType,
        requestId: auditLog.requestId,
        payload: auditLog.payload,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantSlug),
          // `audit_event_type` Drizzle enum's union spans 130+ values.
          // Our 6-event subset is type-compatible at runtime but the
          // PgEnumColumn typing requires `as const` widening that
          // doesn't compose with a `readonly` tuple. Use a raw SQL
          // `IN (...)` template to bypass the overload picker.
          sql`${auditLog.eventType} IN (${sql.join(
            DELIVERY_EVENT_TYPES.map((t) => sql`${t}`),
            sql`, `,
          )})`,
        ),
      )
      .orderBy(desc(auditLog.timestamp))
      .limit(options.includeTestDeliveries ? RECENT_DELIVERIES_LIMIT * 2 : RECENT_DELIVERIES_LIMIT * 3);

    const recent: RecentDelivery[] = [];
    for (const row of rows) {
      const processingOutcome = extractProcessingOutcome(row.payload);
      const isShortCircuit = processingOutcome === 'short_circuited_test';
      if (!options.includeTestDeliveries && isShortCircuit) continue;
      recent.push({
        receivedAt: new Date(row.timestamp).toISOString(),
        requestId: row.requestId,
        signatureOutcome: mapSignatureOutcome(row.eventType),
        processingOutcome,
        matchedMemberId: extractMatchedMemberId(row.payload),
        registrationId: extractRegistrationId(row.payload),
      });
      if (recent.length >= RECENT_DELIVERIES_LIMIT) break;
    }

    const graceActiveUntil =
      cfg.graceRotatedAt !== null
        ? new Date(cfg.graceRotatedAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
        : null;

    return {
      webhookUrl,
      secretConfigured: true,
      secretLastFour: lastFour(cfg.activeSecret as unknown as string),
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
  Result<{ secret: string; secretLastFour: string }, GenerateWebhookSecretError>
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
    { secret: string; secretLastFour: string; graceActiveUntil: string },
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
  // (post-tx so a rollback never overcounts).
  if (result.ok) {
    eventcreateMetrics.webhookSecretRotated(tenantSlug);
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
        const res = await fetch(url, init);
        return {
          status: res.status,
          json: () => res.json(),
          text: () => res.text(),
        };
      },
    },
  );
}

// ---------------------------------------------------------------------------
// POST disable (admin kill-switch toggle per FR-033)
// ---------------------------------------------------------------------------

export interface DisableInput {
  readonly enabled: boolean;
  readonly reason: string;
}

export type DisableError =
  | TenantWebhookConfigRepositoryError
  | { readonly kind: 'audit_emit_failed'; readonly message: string };

export async function runDisableIngest(
  tenantSlug: string,
  actorUserId: string,
  input: DisableInput,
): Promise<Result<{ enabled: boolean }, DisableError>> {
  const ctx: TenantContext = asTenantContext(tenantSlug);
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
  // FR-036 #9 — emit ingest-disabled gauge after successful state
  // change so dashboards + the "ingest-disabled tenant detected"
  // alert (docs/observability.md § 24) reflect the new state.
  if (result.ok) {
    eventcreateMetrics.ingestDisabledTenant(tenantSlug, result.value.enabled);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Nav-visibility resolver (T081) — round-2 R1
// ---------------------------------------------------------------------------

/**
 * Resolve whether `/admin/integrations/eventcreate` should appear in
 * the admin sidebar. Returns `true` when EITHER:
 *   - a `tenant_webhook_configs` row exists, OR
 *   - `last_received_at` is within the last 30 days
 *
 * Otherwise `false` — tenants with no integration history don't see
 * the entry. They can still reach it via direct URL or the
 * events-list empty-state CTA.
 *
 * **Currently unused by the active sidebar** (post-Phase-5 shakedown:
 * the integration entry now appears unconditionally when the F6 kill-
 * switch is on, since first-time admins struggled to discover the
 * setup wizard via the events-list empty-state alone). Retained as an
 * exported public helper for future per-tenant opt-out config (admins
 * who want to suppress the entry on CSV-only chambers) without
 * having to re-derive the freshness logic.
 *
 * Errors fail open (returns `false`) — a transient DB blip should
 * collapse the entry rather than 500 the entire sidebar.
 */
const NAV_FRESHNESS_DAYS = 30;

export async function isEventcreateNavVisible(
  tenantSlug: string,
): Promise<boolean> {
  // Kill-switch off → entry is never visible regardless of config.
  if (!env.features.f6EventCreate) return false;

  try {
    const ctx: TenantContext = asTenantContext(tenantSlug);
    return await runInTenant(ctx, async (tx) => {
      const repo = makeDrizzleTenantWebhookConfigRepository(tx);
      const cfg = await repo.findByTenantSource(
        asTenantId(tenantSlug),
        'eventcreate',
      );
      if (!cfg.ok || !cfg.value) return false;
      if (cfg.value.lastReceivedAt === null) {
        // Row exists but never received — still visible (admin needs
        // to finish setup).
        return true;
      }
      const ageMs = Date.now() - cfg.value.lastReceivedAt.getTime();
      return ageMs <= NAV_FRESHNESS_DAYS * 24 * 60 * 60 * 1000;
    });
  } catch (e) {
    logger.error(
      {
        event: 'f6_nav_visibility_resolve_failed',
        tenantSlug,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6] nav-visibility resolver threw — hiding entry (fail-safe)',
    );
    return false;
  }
}

// Re-export needed schema for tests that want to probe directly.
export { tenantWebhookConfigs };
