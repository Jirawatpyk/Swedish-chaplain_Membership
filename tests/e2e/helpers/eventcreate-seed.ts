/**
 * E2E seed/reset helper for F6 EventCreate integration.
 *
 * Provides two operations used by F6 Playwright specs:
 *
 *   1. `resetEventcreateState(tenantSlug)` — wipes the F6 surface for a
 *      tenant so wizard specs start from a "fresh tenant" state:
 *        • deletes `tenant_webhook_configs` row
 *        • deletes all `events` + `event_registrations` rows for tenant
 *        • deletes `eventcreate_idempotency_receipts` rows for tenant
 *      Audit-log entries are LEFT IN PLACE (forensic-trail integrity per
 *      Constitution Principle I — never DELETE from `audit_log`); they
 *      are filtered out at the recent-deliveries panel level when stale.
 *
 *   2. `seedKnownWebhookSecret(tenantSlug, secret)` — UPSERTs a webhook
 *      config row with a CALLER-KNOWN secret so webhook-ingest spec
 *      (Phase 3 US1 AS1-AS5) can sign payloads. The secret should be
 *      strong (≥32 bytes base64url) — production verifier still
 *      enforces 64-char hex signature shape + timing-safe compare.
 *
 * Both operations connect via `neondb_owner` (bypasses RLS) — same
 * pattern as `tests/e2e/helpers/renewals-seed.ts` and `scripts/seed-*`.
 *
 * No-op when `DATABASE_URL` is missing (returns early with warning).
 */
import postgres from 'postgres';

const TENANT_ID = process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

/**
 * Default fixture secret used by webhook-ingest spec. Hardcoded so the
 * spec + seed are byte-aligned without an extra env var. Strong enough
 * to satisfy `WebhookSecret` brand validation (≥40 chars).
 */
export const F6_E2E_FIXTURE_SECRET =
  'whsec_F6E2EFixtureSecretForLocalAndCIRuns2026';

interface SeedClient {
  sql: ReturnType<typeof postgres>;
  end: () => Promise<void>;
}

function openClient(): SeedClient | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[e2e seed F6] skipped — DATABASE_URL missing');
    return null;
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  return { sql, end: () => sql.end() };
}

/**
 * Wipe F6 state for a tenant. Use in `test.beforeAll` of wizard +
 * webhook-ingest specs so each run starts from a known empty state.
 */
export async function resetEventcreateState(
  tenantSlug: string = TENANT_ID,
): Promise<void> {
  const client = openClient();
  if (!client) return;
  try {
    // Order matters: registrations FK → events; receipts independent.
    // Webhook config last because verifier reads it on next webhook hit.
    await client.sql`DELETE FROM event_registrations WHERE tenant_id = ${tenantSlug}`;
    await client.sql`DELETE FROM events WHERE tenant_id = ${tenantSlug}`;
    await client.sql`DELETE FROM eventcreate_idempotency_receipts WHERE tenant_id = ${tenantSlug}`;
    await client.sql`DELETE FROM tenant_webhook_configs WHERE tenant_id = ${tenantSlug}`;
  } finally {
    await client.end();
  }
}

/**
 * UPSERT a webhook config row with a known secret. Used by webhook-
 * ingest spec to pre-seed the tenant so signed POSTs verify. Caller
 * passes the secret it will use to sign — keeps spec + seed in sync.
 */
export async function seedKnownWebhookSecret(
  tenantSlug: string = TENANT_ID,
  secret: string = F6_E2E_FIXTURE_SECRET,
): Promise<void> {
  const client = openClient();
  if (!client) return;
  try {
    await client.sql`
      INSERT INTO tenant_webhook_configs
        (tenant_id, source, webhook_secret_active, enabled, created_at)
      VALUES
        (${tenantSlug}, 'eventcreate', ${secret}, TRUE, NOW())
      ON CONFLICT (tenant_id, source) DO UPDATE SET
        webhook_secret_active = ${secret},
        webhook_secret_grace = NULL,
        grace_rotated_at = NULL,
        enabled = TRUE,
        last_rotated_at = NOW()
    `;
  } finally {
    await client.end();
  }
}

/**
 * Convenience: full reset then seed known secret. Used by webhook-
 * ingest spec which needs both a clean slate AND a known secret.
 */
export async function resetAndSeedKnownSecret(
  tenantSlug: string = TENANT_ID,
  secret: string = F6_E2E_FIXTURE_SECRET,
): Promise<void> {
  await resetEventcreateState(tenantSlug);
  await seedKnownWebhookSecret(tenantSlug, secret);
}
