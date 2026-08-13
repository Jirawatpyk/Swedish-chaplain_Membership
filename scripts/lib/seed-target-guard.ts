/**
 * Refuse to point a destructive dev seeder at a real database.
 *
 * `seed-e2e-user.ts` mints an ACTIVE `super_admin` whose password is a literal
 * in the repo, and it reads `DATABASE_URL` from whatever env file it is handed.
 * `.env.production` sits in the same checkout, so the only thing between a
 * routine seed and a production super_admin with a public credential was typing
 * `.env.local` rather than `.env.production` — no host check, no NODE_ENV
 * check, no confirmation, and no audit event.
 *
 * Its siblings all guard: `seed-bootstrap-admin.ts` refuses when an admin
 * already exists, and `tests/integration-setup.ts` blocks on
 * `TEST_DB_HOST_BLOCKLIST`. This is that same blocklist, reused so the prod
 * endpoint identifier stays OUT of the repo and there is one place to update.
 *
 * Pure so it can be tested without a database. Returns a refusal message, or
 * `null` when the target is safe.
 */

export interface SeedTargetInput {
  /** `process.env.DATABASE_URL`. */
  readonly databaseUrl: string | undefined;
  /** `process.env.TEST_DB_HOST_BLOCKLIST` — comma-separated host substrings. */
  readonly blocklistRaw: string | undefined;
  /** `process.env.NODE_ENV`. */
  readonly nodeEnv: string | undefined;
  /** Every account the seeder is about to write. */
  readonly emails: readonly string[];
  /**
   * `--confirm-target` on the command line: the operator states they have read
   * DATABASE_URL themselves. Only consulted when the blocklist is unset, and
   * deliberately NOT an env var — an env var would be inherited from the same
   * file that left the target ambiguous.
   */
  readonly confirmedTarget?: boolean;
}

/** Accounts a dev seeder may create. Anything else is a real person's address. */
const ALLOWED_EMAIL_SUFFIX = '@swecham.test';

export function seedTargetRefusal(input: SeedTargetInput): string | null {
  if (!input.databaseUrl) {
    return 'seed refused: DATABASE_URL is not set. Pass an env file, e.g. `node --env-file=.env.local --import tsx scripts/seed-e2e-user.ts`.';
  }

  if (input.nodeEnv === 'production') {
    return (
      'seed refused: NODE_ENV=production. This script creates an ACTIVE ' +
      'super_admin whose password is a literal in the repository.'
    );
  }

  const blocklist = (input.blocklistRaw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const blocked = blocklist.find((needle) => input.databaseUrl!.includes(needle));
  if (blocked) {
    return (
      `seed refused: DATABASE_URL matches "${blocked}" from ` +
      `TEST_DB_HOST_BLOCKLIST. Point it at a dev Neon branch — never ` +
      `production (docs/runbooks/db-environment-branching.md).`
    );
  }

  // NO BLOCKLIST = NO ANSWER, so refuse. The first version read an unset
  // blocklist as "not blocked" and proceeded — which inverted the guard exactly
  // where it was needed. `.env.production` in this repo carries a DATABASE_URL
  // and neither NODE_ENV nor TEST_DB_HOST_BLOCKLIST, so
  // `node --env-file=.env.production --import tsx scripts/seed-e2e-user.ts`
  // passed all three arms and would have written an ACTIVE super_admin, with a
  // password that is a literal in this repository, into production. `.env.local`
  // — the SAFE target — is the only env file that sets the blocklist, so the
  // guard fired only where it was unnecessary and stayed silent where it
  // mattered.
  //
  // Fail-closed, matching `scripts/backfill-membership-coverage.ts`
  // (`blocklist.length === 0 || blocklist.some(...)` → demand explicit
  // confirmation). The escape hatch is a CLI FLAG, not an env var: an env var
  // can be inherited from the very file that made the target ambiguous.
  if (blocklist.length === 0 && input.confirmedTarget !== true) {
    return (
      'seed refused: TEST_DB_HOST_BLOCKLIST is unset, so this target cannot be ' +
      'ruled out as production. Set it in the env file you are passing (see ' +
      'docs/runbooks/db-environment-branching.md), or re-run with ' +
      '--confirm-target once you have checked DATABASE_URL yourself.'
    );
  }

  // Independent of every check above, and deliberately so — including of
  // `--confirm-target`, which is a human assertion and therefore the weakest
  // link here. A seeder that can only ever write `@swecham.test` rows cannot
  // touch a real account even when it is pointed somewhere it should not be.
  //
  // Against TODAY's caller this arm is constant-true: `SEEDED_EMAILS` is six
  // literals that all end in the suffix, so it can never fire. It is a guard on
  // FUTURE edits to that list, not on the current target — which is precisely
  // why it cannot be counted as one of the layers protecting production, and
  // why the blocklist arm above had to become fail-closed instead.
  const foreign = input.emails.filter((e) => !e.endsWith(ALLOWED_EMAIL_SUFFIX));
  if (foreign.length > 0) {
    return (
      `seed refused: ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} ` +
      `outside ${ALLOWED_EMAIL_SUFFIX}. This script resets passwords and roles ` +
      `— it must never be able to name a real account.`
    );
  }

  return null;
}
