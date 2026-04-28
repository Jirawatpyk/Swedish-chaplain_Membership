/**
 * Vitest integration setup — runs before tests/integration/**.
 *
 * Integration tests require a real Postgres instance. If DATABASE_URL is
 * missing we skip the entire suite via a top-level error, surfacing the
 * reason clearly rather than silently passing.
 */
import { beforeAll } from 'vitest';

// Pin STRIPE_API_VERSION for F5 webhook integration tests so the
// fixture `api_version: '2024-06-20'` in tests/integration/payments/*
// matches what the webhook route compares against. Must run BEFORE
// src/lib/env.ts is imported transitively (top-level executes first).
process.env['STRIPE_API_VERSION'] = '2024-06-20';

// R1-I3 — enable T166 async receipt PDF flag for integration tests
// covering the dispatcher's `receipt_pdf_render` branch + reconcile
// cron + email gate. Default in env.ts is `false` (1-release safety
// margin), but the integration tests assume the worker pipeline is
// live. Tests that specifically validate the kill-switch off-state
// can override via `process.env['FEATURE_F5_ASYNC_RECEIPT_PDF']='false'
// + vi.resetModules()` (mirrors `feature-flag-kill-switch.test.ts`).
process.env['FEATURE_F5_ASYNC_RECEIPT_PDF'] = 'true';

beforeAll(() => {
  const dbUrl =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error(
      'Integration tests require DATABASE_URL (or DATABASE_URL_UNPOOLED). ' +
        'Set it in .env.local or your CI environment. See specs/001-auth-rbac/quickstart.md.',
    );
  }
});
