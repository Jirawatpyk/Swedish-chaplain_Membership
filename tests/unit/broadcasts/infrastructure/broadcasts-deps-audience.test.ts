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

  // `configured` is what the FLAGS say the system would accept — the H-2
  // decision, still pinned here because it is the only thing that catches an
  // inverted or mis-spelled flag expression. `enforced` is what call sites
  // actually compare against: `min(configured, DELIVERABLE_RECIPIENTS_PER_TICK)`
  // since T095 (2026-09-08), i.e. 800 in every row, because the push cannot
  // deliver more than ~830 in one 300 s tick at the measured 3.4 req/s.
  //
  // Keeping BOTH columns is deliberate. Capping the enforced value alone would
  // have made every row read 800 and quietly retired the H-2 guard: the flag
  // expression could then be inverted with no assertion noticing, which is the
  // exact failure this file was written for.
  it.each<[Flags, 'primary_only' | 'all_contacts', number, number]>([
    [{ contactMarketing: undefined, batching: false }, 'primary_only', 5_000, 800],
    [{ contactMarketing: 'false', batching: false }, 'primary_only', 5_000, 800],
    [{ contactMarketing: 'true', batching: false }, 'all_contacts', 5_000, 800],
    // The H-2 case: batching ON (as prod is today) with the 108 flag OFF
    // must keep the pre-branch 5,000 — the ceiling belongs to the audience.
    [{ contactMarketing: undefined, batching: true }, 'primary_only', 5_000, 800],
    [{ contactMarketing: 'false', batching: true }, 'primary_only', 5_000, 800],
    // Both ON: the wide ceiling and the wide audience, as one unit.
    [{ contactMarketing: 'true', batching: true }, 'all_contacts', 50_000, 800],
  ])(
    'flags %j → mode %s, configured ceiling %d, enforced ceiling %d',
    async (flags, mode, configured, enforced) => {
      stubEnv(flags);
      const deps = await loadDeps();
      expect(deps.currentAudienceMode()).toBe(mode);
      expect(deps.configuredAudienceCeiling()).toBe(configured);
      expect(deps.currentAudienceCeiling()).toBe(enforced);
    },
  );

  it('the enforced ceiling is never above what one dispatch tick can push', async () => {
    // The invariant, stated independently of the numbers above so that raising
    // a configured ceiling can never silently raise what is accepted. If the
    // push is ever made faster (batched multi-tick dispatch, or Resend's
    // Contacts Import API — T086/T087/T106), raise
    // DELIVERABLE_RECIPIENTS_PER_TICK and this stays true by construction.
    const { DELIVERABLE_RECIPIENTS_PER_TICK } = await import(
      '@/modules/broadcasts/domain/audience-ceiling'
    );
    for (const flags of [
      { contactMarketing: 'false', batching: false },
      { contactMarketing: 'true', batching: true },
    ] as const) {
      vi.resetModules();
      stubEnv(flags);
      const deps = await loadDeps();
      expect(deps.currentAudienceCeiling()).toBeLessThanOrEqual(
        DELIVERABLE_RECIPIENTS_PER_TICK,
      );
      expect(deps.currentAudienceCeiling()).toBeLessThanOrEqual(
        deps.configuredAudienceCeiling(),
      );
    }
  });

  it('SC-004 — the count, submit and dispatch deps carry the SAME mode and ceiling under one env', async () => {
    stubEnv({ contactMarketing: 'true', batching: true });
    const deps = await loadDeps();
    const count = deps.makeResolveSegmentDeps('swecham');
    const submit = deps.makeSubmitBroadcastDeps('swecham');
    const dispatch = await deps.makeDispatchScheduledBroadcastDeps('swecham');
    expect(count.audienceMode).toBe('all_contacts');
    // 800, not 50,000: what compose shows must be what submit and dispatch
    // enforce, and since T095 that is the deliverable bound, not the
    // configured one.
    expect(count.audienceCeiling).toBe(800);
    expect(submit.audienceMode).toBe(count.audienceMode);
    expect(submit.audienceCeiling).toBe(count.audienceCeiling);
    expect(dispatch.audienceMode).toBe(count.audienceMode);
    expect(dispatch.audienceCeiling).toBe(count.audienceCeiling);
  }, 30_000);

  // Review round 2 (tests L-1): renamed — `vi.resetModules()` re-evaluates the
  // module, so this case cannot observe "per call vs module load" (a
  // module-level constant would pass too). What it DOES pin is that
  // `broadcasts-deps` holds no copy of its own: a fresh env parse yields a
  // fresh answer. `env` memoises, so a flip lands on the next cold start.
  it('broadcasts-deps holds no copy of the flags: a fresh env parse yields a fresh mode and ceiling', async () => {
    stubEnv({ contactMarketing: 'false', batching: false });
    const deps = await loadDeps();
    expect(deps.currentAudienceMode()).toBe('primary_only');
    vi.resetModules();
    stubEnv({ contactMarketing: 'true', batching: true });
    const fresh = await loadDeps();
    expect(fresh.currentAudienceMode()).toBe('all_contacts');
    expect(fresh.configuredAudienceCeiling()).toBe(50_000);
    expect(fresh.currentAudienceCeiling()).toBe(800);
  });
});
