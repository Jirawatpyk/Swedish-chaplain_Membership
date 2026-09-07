/**
 * 108 PR-C review (2026-09-07, tests BLOCKER + code H-2) — the composition
 * root's audience mapping, pinned against an EXPLICIT flag matrix.
 *
 * `currentAudienceMode()` / `currentAudienceCeiling()` / the three deps
 * makers in `broadcasts-deps.ts` are the entire mechanism behind two
 * guarantees:
 *   - SC-004: the count a member sees at compose equals the set dispatched,
 *     because every call site reads the SAME two functions;
 *   - ship-dark / rollback: with `FEATURE_CONTACT_MARKETING_RECIPIENTS` OFF,
 *     prod behaves exactly as before the branch — the primary-only leg AND
 *     the 5,000 ceiling.
 *
 * Neither was tested: every resolver test passes `audienceMode` and
 * `audienceCeiling` explicitly, and the only live assertion
 * (`recipient-count-routes.test.ts`) compared the route's ceiling against
 * `currentAudienceCeiling()` itself — a tautology. Invert the ternary and
 * 13,768 tests stay green while prod, flag OFF, emails every secondary
 * contact.
 *
 * The ceiling case is the H-2 decision: the 50,000 ceiling was raised FOR
 * the 1:N audience, so it moves WITH the 108 flag. `FEATURE_F71A_US1_PAGINATION`
 * is already ON in prod; without the 108 gate, deploying this branch flag-OFF
 * would have silently accepted audiences of 5,001–50,000, opened the
 * never-exercised batch path, and changed every compose page's copy to
 * "up to 50,000".
 *
 * Pattern: stub env, `vi.resetModules()`, fresh import — the same as
 * `tests/unit/lib/env-contact-marketing-recipients.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `makeDispatchScheduledBroadcastDeps` reads the tenant display name from
// the DB (a stubbed DATABASE_URL would hang the case); the name is not what
// this file pins, so answer it locally. Everything else in the graph is real.
vi.mock('@/lib/broadcasts-route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/broadcasts-route-helpers')>();
  return { ...actual, resolveTenantDisplayName: async () => 'SweCham (fixture)' };
});

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@h:5432/d',
  KV_REST_API_URL: 'https://kv.example.com',
  KV_REST_API_TOKEN: 'kv-token-with-enough-length',
  RESEND_API_KEY: 're_0000000000',
  RESEND_WEBHOOK_SIGNING_SECRET: 'whsigningsecret',
  AUTH_COOKIE_SIGNING_SECRET: 'a'.repeat(48),
  APP_BASE_URL: 'http://localhost:3100',
  APP_ALLOWED_ORIGINS: 'http://localhost:3100',
  TENANT_SLUG: 'swecham',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_public_store',
  CRON_SECRET: 'cron-secret-with-enough-length',
  STRIPE_SECRET_KEY: 'sk_test_0000000000',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_0000000000',
  STRIPE_WEBHOOK_SECRET: 'whsec_0000000000',
  STRIPE_API_VERSION: '2025-09-30.clover',
  STRIPE_ACCOUNT_ID_SWECHAM: 'acct_TEST0000',
  STRIPE_LIVE_MODE: 'false',
  FEATURE_F5_ONLINE_PAYMENT: 'false',
  // F7 surface — needed so the batching flag can be turned ON in a case.
  RESEND_BROADCASTS_API_KEY: 're_broadcasts_0000000000',
  RESEND_BROADCASTS_WEBHOOK_SECRET: 'b'.repeat(40),
  BROADCASTS_FROM_EMAIL: 'noreply@swecham-fixture.com',
  UNSUBSCRIBE_TOKEN_SECRET: 'c'.repeat(48),
};

type Flags = {
  readonly contactMarketing: 'true' | 'false' | undefined;
  readonly batching: boolean;
};

function stubEnv(flags: Flags): void {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  // Stub to `undefined` so vitest DELETES the key — a real .env.local value
  // (loaded by tests/setup.ts) would otherwise leak into the "unset" case.
  vi.stubEnv('FEATURE_CONTACT_MARKETING_RECIPIENTS', flags.contactMarketing);
  const b = flags.batching ? 'true' : 'false';
  vi.stubEnv('FEATURE_F7_BROADCASTS', b);
  vi.stubEnv('FEATURE_F71A_BROADCAST_ADVANCED', b);
  vi.stubEnv('FEATURE_F71A_US1_PAGINATION', b);
}

async function loadDeps() {
  return import('@/modules/broadcasts/infrastructure/broadcasts-deps');
}

describe('broadcasts-deps — audience mode + ceiling from the flag matrix (108 PR-C review)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each<[Flags, 'primary_only' | 'all_contacts', number]>([
    [{ contactMarketing: undefined, batching: false }, 'primary_only', 5_000],
    [{ contactMarketing: 'false', batching: false }, 'primary_only', 5_000],
    [{ contactMarketing: 'true', batching: false }, 'all_contacts', 5_000],
    // The H-2 case: batching ON (as prod is today) with the 108 flag OFF
    // must keep the pre-branch 5,000 — the ceiling belongs to the audience.
    [{ contactMarketing: undefined, batching: true }, 'primary_only', 5_000],
    [{ contactMarketing: 'false', batching: true }, 'primary_only', 5_000],
    // Both ON: the wide ceiling and the wide audience, as one unit.
    [{ contactMarketing: 'true', batching: true }, 'all_contacts', 50_000],
  ])('flags %j → mode %s, ceiling %d', async (flags, mode, ceiling) => {
    stubEnv(flags);
    const deps = await loadDeps();
    expect(deps.currentAudienceMode()).toBe(mode);
    expect(deps.currentAudienceCeiling()).toBe(ceiling);
  });

  it('SC-004 — the count, submit and dispatch deps carry the SAME mode and ceiling under one env', async () => {
    stubEnv({ contactMarketing: 'true', batching: true });
    const deps = await loadDeps();
    const count = deps.makeResolveSegmentDeps('swecham');
    const submit = deps.makeSubmitBroadcastDeps('swecham');
    const dispatch = await deps.makeDispatchScheduledBroadcastDeps('swecham');
    expect(count.audienceMode).toBe('all_contacts');
    expect(count.audienceCeiling).toBe(50_000);
    expect(submit.audienceMode).toBe(count.audienceMode);
    expect(submit.audienceCeiling).toBe(count.audienceCeiling);
    expect(dispatch.audienceMode).toBe(count.audienceMode);
    expect(dispatch.audienceCeiling).toBe(count.audienceCeiling);
  }, 30_000);

  it('the mode is read per call, not cached at module load (a Vercel env flip takes effect next tick)', async () => {
    stubEnv({ contactMarketing: 'false', batching: false });
    const deps = await loadDeps();
    expect(deps.currentAudienceMode()).toBe('primary_only');
    // The env module memoises its parse, so a flip needs a fresh env module;
    // what this pins is that broadcasts-deps holds NO copy of its own.
    vi.resetModules();
    stubEnv({ contactMarketing: 'true', batching: true });
    const fresh = await loadDeps();
    expect(fresh.currentAudienceMode()).toBe('all_contacts');
    expect(fresh.currentAudienceCeiling()).toBe(50_000);
  });
});
