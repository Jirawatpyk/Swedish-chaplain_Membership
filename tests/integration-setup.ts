/**
 * Vitest integration setup — runs before tests/integration/**.
 *
 * Integration tests require a real Postgres instance. If DATABASE_URL is
 * missing we skip the entire suite via a top-level error, surfacing the
 * reason clearly rather than silently passing.
 */
import { beforeAll, vi } from 'vitest';
import { assertDbHostNotBlocklisted } from './helpers/db-host-guard';

// No integration test sends real transactional email. The outbox dispatcher
// (`/api/cron/outbox-dispatch`) drains up to 50 pending rows from the WHOLE
// database per call, so one suite calling it sent every row that e2e runs had
// queued on the shared dev branch through the real Resend key (80 sends to
// test.example.com / swecham.test on 2026-10-20): quota spent, and bounces
// against the sender domain. A suite that needs to see or fail sends mocks
// this module itself; its own `vi.mock` replaces this default.
vi.mock('@/modules/auth/infrastructure/email/resend-client', () => ({
  emailSender: {
    send: vi.fn(async () => ({
      ok: true,
      value: { messageId: `integration-mock-${crypto.randomUUID()}` },
    })),
  },
}));
// Senders that build their own client (the F8 renewal gateway) go through the
// SDK directly: replace `emails.send` / `batch.send` on every `Resend`, and
// keep the rest of the SDK (Broadcasts, contacts) as it is.
vi.mock('resend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('resend')>();
  const fakeSend = vi.fn(async () => ({
    data: { id: `integration-mock-${crypto.randomUUID()}` },
    error: null,
  }));
  class Resend extends actual.Resend {
    constructor(...args: ConstructorParameters<typeof actual.Resend>) {
      super(...args);
      Object.assign(this.emails, { send: fakeSend });
      Object.assign(this.batch, { send: fakeSend });
    }
  }
  return { ...actual, Resend };
});

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

// Mirror tests/setup.ts:89-91 — FORCE the feature flags the integration suite
// asserts the flag-ON wiring for, rather than inheriting a per-developer
// `.env.local` (a test whose result depends on the contents of one machine's
// `.env.local` is not a test). This gap silently reddened the F8 at-risk
// event-attendance / cultural-quota factor integration tests whenever
// `.env.local` carried `FEATURE_F6_EVENTCREATE=false` (renewals-deps binds the
// no-op event-attendees stub, so those factors never fire). Must run BEFORE
// `src/lib/env.ts` is imported transitively (top-level executes first). A test
// that wants a flag-OFF path mocks `@/lib/env` for itself.
process.env['FEATURE_F4_INVOICING'] = 'true';
process.env['FEATURE_F8_RENEWALS'] = 'true';
process.env['FEATURE_F6_EVENTCREATE'] = 'true';
// F114 — same reason, one feature later. `broadcasts-gauges-cron.test.ts`
// asserts `membersGaugesSkipped === null`, i.e. that the members half of the
// gauges tick actually SCANNED; the route skips that scan with `'flag_off'`
// when this flag is absent. It passed on every workstation (`.env.local`
// carries the flag from the F114 dev work) and reddened the nightly sweep the
// first time the rotation reached `broadcasts` afterwards — run 36064329707.
process.env['FEATURE_MEMBER_CHANGE_APPROVAL'] = 'true';

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

  // Production-safety guard. Integration tests CREATE + mutate data (test
  // tenants, members, export jobs) — they must NEVER run against the
  // production database. `TEST_DB_HOST_BLOCKLIST` is a comma-separated list
  // of host substrings (the prod Neon endpoint id) — set it in `.env.local` +
  // CI. The shared helper fails CLOSED on a match AND on an unset/empty list
  // (108 PR-D review MEDIUM-12). See docs/runbooks/db-environment-branching.md.
  assertDbHostNotBlocklisted(dbUrl, process.env.TEST_DB_HOST_BLOCKLIST, 'integration');
});
