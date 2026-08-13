/**
 * `scripts/lib/seed-target-guard.ts` — the refusal that stands between
 * `seed-e2e-user.ts` and a real database.
 *
 * The seeder mints an ACTIVE `super_admin` whose password is a string literal
 * in this repository, and it had no guard at all: not a host check, not a
 * NODE_ENV check, not a confirmation, not an audit event. `.env.production`
 * lives in the same checkout, so `--env-file=.env.production` was the entire
 * distance between a routine seed and a publicly-credentialed super_admin in
 * production holding `users.manage`, `audit.read` and the erasure surfaces.
 *
 * Each case below is one way that happens.
 */
import { describe, expect, it } from 'vitest';
import { seedTargetRefusal } from '../../../scripts/lib/seed-target-guard';

const SAFE_EMAILS = ['e2e-admin@swecham.test', 'e2e-super-admin@swecham.test'];
const PROD_NEEDLE = 'ep-prod-endpoint-999';
const DEV_URL = 'postgres://u:p@ep-dev-branch-123.ap-southeast-1.aws.neon.tech/db';
const PROD_URL = 'postgres://u:p@ep-prod-endpoint-999.ap-southeast-1.aws.neon.tech/db';

const base = {
  databaseUrl: DEV_URL,
  blocklistRaw: 'ep-prod-endpoint-999',
  nodeEnv: 'development',
  emails: SAFE_EMAILS,
};

describe('seedTargetRefusal', () => {
  it('allows a dev branch with the blocklist configured', () => {
    expect(seedTargetRefusal(base)).toBeNull();
  });

  it('REFUSES a blocklisted host — the production seed', () => {
    const refusal = seedTargetRefusal({ ...base, databaseUrl: PROD_URL });
    expect(refusal).toMatch(/TEST_DB_HOST_BLOCKLIST/);
  });

  it('still refuses when the blocklist has EMPTY entries around the real one', () => {
    // `,ep-prod` splits to `['', 'ep-prod']`. Without `.filter(Boolean)` the
    // `''` entry matches first, `find` returns a FALSY string, `if (blocked)`
    // is skipped — and a positively-identified production host sails through.
    // A stray comma or trailing separator in an env file is all it takes.
    for (const raw of [`,${PROD_NEEDLE}`, `${PROD_NEEDLE},`, `${PROD_NEEDLE}, ,`]) {
      expect(
        seedTargetRefusal({ ...base, databaseUrl: PROD_URL, blocklistRaw: raw }),
        raw,
      ).toMatch(/TEST_DB_HOST_BLOCKLIST/);
    }
  });

  it('REFUSES NODE_ENV=production even when the blocklist is unset', () => {
    // The blocklist is env-supplied, so a fresh checkout has none — which is
    // exactly when someone is most likely to reach for the wrong env file.
    const refusal = seedTargetRefusal({
      ...base,
      databaseUrl: PROD_URL,
      blocklistRaw: undefined,
      nodeEnv: 'production',
    });
    expect(refusal).toMatch(/NODE_ENV=production/);
  });

  /**
   * THE CASE THE FIRST VERSION GOT BACKWARDS, and the shape of a real command.
   *
   * `.env.production` in this repo carries a DATABASE_URL and neither NODE_ENV
   * nor TEST_DB_HOST_BLOCKLIST. So `node --env-file=.env.production --import tsx
   * scripts/seed-e2e-user.ts` reached the guard with every arm inert and was
   * ALLOWED THROUGH. The safe target, `.env.local`, is the only env file that
   * sets the blocklist — so the guard fired precisely where it was unnecessary.
   *
   * The `@swecham.test` arm did not save it: against the seeder's own six
   * literals that arm is constant-true and can never fire.
   */
  it('REFUSES when the blocklist is unset — an unknown target is not a safe one', () => {
    const refusal = seedTargetRefusal({
      ...base,
      databaseUrl: PROD_URL,
      blocklistRaw: undefined,
      nodeEnv: undefined,
    });
    expect(refusal).toMatch(/TEST_DB_HOST_BLOCKLIST is unset/);
  });

  it('REFUSES an unset blocklist even for a URL that LOOKS like dev', () => {
    // The guard cannot tell; that is the whole point. Recognising "dev" by
    // eye is the mistake the blocklist exists to remove.
    expect(seedTargetRefusal({ ...base, blocklistRaw: undefined })).toMatch(/cannot be/);
  });

  it('--confirm-target is the ONLY way past an unset blocklist', () => {
    expect(
      seedTargetRefusal({ ...base, blocklistRaw: undefined, confirmedTarget: true }),
    ).toBeNull();
  });

  it('--confirm-target does NOT override a POSITIVE blocklist match', () => {
    // A confirmation flag that can wave through a host we positively identified
    // as production would make the blocklist advisory.
    expect(
      seedTargetRefusal({ ...base, databaseUrl: PROD_URL, confirmedTarget: true }),
    ).toMatch(/TEST_DB_HOST_BLOCKLIST/);
  });

  it('--confirm-target does NOT override NODE_ENV=production', () => {
    expect(
      seedTargetRefusal({ ...base, nodeEnv: 'production', confirmedTarget: true }),
    ).toMatch(/NODE_ENV=production/);
  });

  it('REFUSES an email outside @swecham.test, independently of the host', () => {
    // A guard on FUTURE edits to the seeded list — not a layer protecting the
    // current target, because against today's six literals it cannot fire.
    const refusal = seedTargetRefusal({
      ...base,
      emails: [...SAFE_EMAILS, 'secretary@swecham.com'],
    });
    expect(refusal).toContain('secretary@swecham.com');
  });

  it('the email arm outranks --confirm-target', () => {
    expect(
      seedTargetRefusal({
        ...base,
        blocklistRaw: undefined,
        confirmedTarget: true,
        emails: ['secretary@swecham.com'],
      }),
    ).toContain('secretary@swecham.com');
  });

  it('a lookalike suffix is NOT accepted', () => {
    expect(
      seedTargetRefusal({ ...base, emails: ['x@swecham.test.attacker.com'] }),
    ).toContain('x@swecham.test.attacker.com');
  });

  it('names EVERY foreign address, not just the first', () => {
    const refusal = seedTargetRefusal({
      ...base,
      emails: ['a@real.com', 'b@real.com'],
    });
    expect(refusal).toContain('a@real.com');
    expect(refusal).toContain('b@real.com');
  });

  it('REFUSES a missing DATABASE_URL rather than letting the client decide', () => {
    expect(seedTargetRefusal({ ...base, databaseUrl: undefined })).toMatch(/DATABASE_URL/);
  });

  it('a blank blocklist is treated as UNSET, not as a match on every host', () => {
    // Two different wrongs to avoid. `''.split(',')` yields `['']` and
    // `url.includes('')` is always true, so an unfiltered list would refuse
    // every seed with a message blaming a host that never matched — noise that
    // gets "fixed" by deleting the guard. The right answer is the unset one:
    // refuse, and say the blocklist is missing.
    for (const raw of ['', ' , ', '   ']) {
      expect(seedTargetRefusal({ ...base, blocklistRaw: raw }), raw).toMatch(/is unset/);
    }
  });
});
