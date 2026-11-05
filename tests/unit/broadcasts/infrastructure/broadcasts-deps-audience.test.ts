/**
 * The composition root's audience mapping: the leg from the 108 flag, the
 * ceiling from `BROADCAST_AUDIENCE_CEILING` (spec 140 s4, DR3).
 *
 * `currentAudienceMode()` / `currentAudienceCeiling()` / the deps makers in
 * `broadcasts-deps.ts` are the entire mechanism behind two guarantees:
 *   - SC-004 / FR-042: the count a member sees at compose equals the set
 *     dispatched, because every call site reads the SAME two functions;
 *   - ship-dark / rollback: with `FEATURE_CONTACT_MARKETING_RECIPIENTS` OFF the
 *     resolver keeps the primary-only leg.
 *
 * Every resolver test passes `audienceMode` and `audienceCeiling` explicitly,
 * so this file is the only place the env → deps wiring is pinned. It is pinned
 * against literals and env values, never against the function under test.
 *
 * Until s4 the ceiling was a flag matrix: 5,000, 50,000 with the import AND the
 * 1:N flag on, clamped to 500 with the import off. The import leg is now the
 * only leg, so the ceiling is one env value and no flag moves it. The cases
 * below flip both old flags to prove that.
 *
 * Pattern: stub env, `vi.resetModules()`, fresh import — the same as
 * `tests/unit/lib/env-contact-marketing-recipients.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeMarketingDirectory } from '../../../helpers/eblast-approval-fakes';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { MemberRecipient } from '@/modules/broadcasts/application/ports/members-bridge-port';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';

// The members the stub bridge answers for a member-based segment. Hoisted so
// the mocked module and the assertions hold the SAME object across
// `vi.resetModules()`.
const bridgeState = vi.hoisted(() => ({
  members: [] as ReadonlyArray<unknown>,
  getMembersBySegmentCalls: 0,
}));

const rawBridge = vi.hoisted(
  () =>
    ({
      async getMembersBySegment() {
        bridgeState.getMembersBySegmentCalls++;
        return bridgeState.members;
      },
      async getContactsBySegment() {
        return [];
      },
      async countOptedOutContactsBySegment() {
        return 0;
      },
      async filterMarketingOptedOut() {
        return new Set();
      },
      async getMembersHaltedInTenant() {
        return [];
      },
    }) as unknown,
);

// The raw module bridge reads F3 over the DB; a stubbed DATABASE_URL would
// hang the case. Identity matters here: the memo assertions compare against it.
vi.mock('@/modules/broadcasts/infrastructure/members-bridge', () => ({
  membersBridge: rawBridge,
}));

// The resolver's suppression step (`lookupBatch`) reads the DB too.
vi.mock(
  '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo')
      >();
    return {
      ...actual,
      makeDrizzleMarketingUnsubscribesRepo: () => ({
        async upsert() {
          throw new Error('not used');
        },
        async findByEmailLower() {
          return null;
        },
        async lookupBatch() {
          return new Set();
        },
        async setMemberIdNull() {
          return { affected: 0 };
        },
      }),
    };
  },
);

// `makeBuildAudienceTickDeps` reads the tenant display name from the DB; the name is not what this file pins.
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
  RESEND_BROADCASTS_API_KEY: 're_broadcasts_0000000000',
  RESEND_BROADCASTS_WEBHOOK_SECRET: 'b'.repeat(40),
  BROADCASTS_FROM_EMAIL: 'noreply@swecham-fixture.com',
  UNSUBSCRIBE_TOKEN_SECRET: 'c'.repeat(48),
};

type Env = {
  readonly contactMarketing: 'true' | 'false' | undefined;
  readonly ceiling: string | undefined;
};

function stubEnv(e: Env): void {
  for (const [k, v] of Object.entries(BASE_ENV)) vi.stubEnv(k, v);
  // `undefined` makes vitest DELETE the key — a real .env.local value (loaded
  // by tests/setup.ts) would otherwise leak into the "unset" case.
  vi.stubEnv('FEATURE_CONTACT_MARKETING_RECIPIENTS', e.contactMarketing);
  vi.stubEnv('BROADCAST_AUDIENCE_CEILING', e.ceiling);
  // The F7 master flag stays ON — the kill switch is not what this file pins.
  vi.stubEnv('FEATURE_F7_BROADCASTS', 'true');
  vi.stubEnv('FEATURE_F71A_BROADCAST_ADVANCED', 'true');
}

async function loadDeps() {
  return import('@/modules/broadcasts/infrastructure/broadcasts-deps');
}

function makeMembers(count: number): ReadonlyArray<MemberRecipient> {
  return Array.from({ length: count }, (_, i) => ({
    memberId: `m-${i}`,
    displayName: `Member ${i}`,
    primaryContactEmail: unsafeBrandEmailLower(`m${i}@example.com`),
    tierCode: null,
    broadcastsHaltedUntilAdminReview: false,
  }));
}

/** Only the fields `resolveRecipients` reads; the rest of the row is not in play. */
const ALL_MEMBERS_ROW = {
  segmentType: 'all_members',
  segmentParams: null,
  customRecipientEmails: null,
  requestedByMemberId: 'm-requester',
} as unknown as Broadcast;

const TICK = { tickStartedAt: 0 };

beforeEach(() => {
  vi.resetModules();
  bridgeState.members = [];
  bridgeState.getMembersBySegmentCalls = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('broadcasts-deps — audience mode from FEATURE_CONTACT_MARKETING_RECIPIENTS', () => {
  it.each<[Env['contactMarketing'], 'primary_only' | 'all_contacts']>([
    [undefined, 'primary_only'],
    ['false', 'primary_only'],
    ['true', 'all_contacts'],
  ])('FEATURE_CONTACT_MARKETING_RECIPIENTS=%s → mode %s', async (contactMarketing, mode) => {
    stubEnv({ contactMarketing, ceiling: undefined });
    const deps = await loadDeps();
    expect(deps.currentAudienceMode()).toBe(mode);
  });
});

describe('broadcasts-deps — the ceiling is BROADCAST_AUDIENCE_CEILING (spec 140 s4, DR3)', () => {
  // The retired ceiling input is flipped: the 1:N flag keeps its
  // recipient-scope role and no longer moves the number. (The import flag, the
  // other retired input, was deleted in spec 140 s4.)
  it.each<[Env['contactMarketing']]>([[undefined], ['false'], ['true']])(
    'the ceiling is BROADCAST_AUDIENCE_CEILING, default 900, independent of FEATURE_CONTACT_MARKETING_RECIPIENTS (%s)',
    async (contactMarketing) => {
      stubEnv({ contactMarketing, ceiling: undefined });
      const deps = await loadDeps();
      expect(deps.currentAudienceCeiling()).toBe(900);
      expect(deps.makeResolveSegmentDeps('swecham').audienceCeiling).toBe(900);
    },
  );

  it('an env value of N is the ceiling for count, submit and dispatch', async () => {
    stubEnv({ contactMarketing: 'false', ceiling: '3' });
    const deps = await loadDeps();
    expect(deps.currentAudienceCeiling()).toBe(3);
    // Count and submit expose the number they compare against.
    expect(deps.makeResolveSegmentDeps('swecham').audienceCeiling).toBe(3);
    expect(deps.makeSubmitBroadcastDeps('swecham', makeFakeMarketingDirectory([])).audienceCeiling).toBe(3);

    // Dispatch (the import leg) closes the ceiling inside its resolver, so it
    // is read by behaviour: N + 1 members refuse with cap N, N members resolve.
    const dispatch = await deps.makeBuildAudienceTickDeps('swecham', TICK);
    bridgeState.members = makeMembers(4);
    const over = await dispatch.resolveRecipients(ALL_MEMBERS_ROW);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error).toMatchObject({ kind: 'broadcast_audience_too_large', cap: 3, count: 4 });
    }

    const atCap = await deps.makeBuildAudienceTickDeps('swecham', TICK);
    bridgeState.members = makeMembers(3);
    const fits = await atCap.resolveRecipients(ALL_MEMBERS_ROW);
    expect(fits.ok).toBe(true);
    if (fits.ok) expect(fits.value.estimatedCount).toBe(3);
  });

  it('SC-004 — the count, submit and dispatch deps carry the SAME mode and ceiling under one env', async () => {
    stubEnv({ contactMarketing: 'true', ceiling: undefined });
    const deps = await loadDeps();
    const count = deps.makeResolveSegmentDeps('swecham');
    const submit = deps.makeSubmitBroadcastDeps('swecham', makeFakeMarketingDirectory([]));
    expect(count.audienceMode).toBe('all_contacts');
    expect(count.audienceCeiling).toBe(900);
    expect(submit.audienceMode).toBe(count.audienceMode);
    expect(submit.audienceCeiling).toBe(count.audienceCeiling);
  });

  // `vi.resetModules()` re-evaluates the module, so this cannot observe "per
  // call vs module load". What it pins is that `broadcasts-deps` holds no copy
  // of its own: a fresh env parse yields a fresh answer. `env` memoises, so a
  // change lands on the next cold start.
  it('broadcasts-deps holds no copy of the env: a fresh parse yields a fresh mode and ceiling', async () => {
    stubEnv({ contactMarketing: 'false', ceiling: undefined });
    const deps = await loadDeps();
    expect(deps.currentAudienceMode()).toBe('primary_only');
    expect(deps.currentAudienceCeiling()).toBe(900);
    vi.resetModules();
    stubEnv({ contactMarketing: 'true', ceiling: '1200' });
    const fresh = await loadDeps();
    expect(fresh.currentAudienceMode()).toBe('all_contacts');
    expect(fresh.currentAudienceCeiling()).toBe(1200);
  });
});

// Spec 140 s4 (row 2) — the import maker builds the tick memo itself, from the
// raw module bridge (moved here from the cron contract test, which can no longer
// see it: the route hands the maker no bridge).
describe('broadcasts-deps — the import maker builds its own tick memo (spec 140 s4)', () => {
  it('the resolver, membersBridge and sendStanding read one memo; haltReadFresh stays the raw bridge', async () => {
    stubEnv({ contactMarketing: 'false', ceiling: undefined });
    const deps = await loadDeps();
    const { membersBridge: raw } = await import('@/modules/broadcasts/infrastructure/members-bridge');
    const tick = await deps.makeBuildAudienceTickDeps('swecham', TICK);

    expect(tick.membersBridge).not.toBe(raw);
    // The SAME memo instance the resolver reads, so one tick = one cache.
    expect(tick.sendStanding.membersBridge).toBe(tick.membersBridge);
    // R2 — the re-read before a permanent `halted` refusal is uncached.
    expect(tick.sendStanding.haltReadFresh).toBe(raw);

    // The resolver reads the memo too, not just the exposed field: two rows on
    // one segment in one tick cost one F3 read.
    bridgeState.members = makeMembers(2);
    await tick.resolveRecipients(ALL_MEMBERS_ROW);
    await tick.resolveRecipients(ALL_MEMBERS_ROW);
    expect(bridgeState.getMembersBySegmentCalls).toBe(1);

    // A second call is a second tick: a fresh cache.
    const nextTick = await deps.makeBuildAudienceTickDeps('swecham', TICK);
    expect(nextTick.membersBridge).not.toBe(tick.membersBridge);
    await nextTick.resolveRecipients(ALL_MEMBERS_ROW);
    expect(bridgeState.getMembersBySegmentCalls).toBe(2);
  });
});

// Spec 140 s2a review round 2, CR#2 (maintainer decision, 1 Nov 2026): the
// dispatch tick keeps the default one-attempt gateway instance. (The legacy
// leg's retrying instance was deleted with that leg in spec 140 s4.)
describe('broadcasts-deps — the dispatch tick\'s gateway instance (spec 140 s2a)', () => {
  it('makeBuildAudienceTickDeps wires the default instance', async () => {
    stubEnv({ contactMarketing: 'false', ceiling: undefined });
    const deps = await loadDeps();
    const gateway = await import('@/modules/broadcasts/infrastructure/resend/resend-broadcasts-gateway');
    const importLeg = await deps.makeBuildAudienceTickDeps('swecham', TICK);
    expect(importLeg.broadcastsGateway).toBe(gateway.resendBroadcastsGateway);
  });
});
