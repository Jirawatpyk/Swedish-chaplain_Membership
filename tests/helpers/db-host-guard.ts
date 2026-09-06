/**
 * Production-host guard shared by every test harness that WRITES to a
 * database: the integration setup (`tests/integration-setup.ts`) and the e2e
 * seed client (`tests/e2e/helpers/open-seed-client.ts`). One implementation so
 * the two cannot drift (108 PR-D review cycle 14, whole-branch MEDIUM-12).
 *
 * `TEST_DB_HOST_BLOCKLIST` is a comma-separated list of host fragments (the
 * production Neon endpoint id) kept in env, not in the repo — see
 * `.env.example` and docs/runbooks/db-environment-branching.md.
 *
 * Fails CLOSED in both directions:
 *   - a `DATABASE_URL` containing any listed fragment → throws;
 *   - an unset / empty list → throws. A guard with nothing to check is not a
 *     guard: on a machine whose `.env.local` lacks the key, a BYPASSRLS
 *     fixture writer must not run at all (108 security review LOW-5).
 */
export function assertDbHostNotBlocklisted(
  dbUrl: string,
  rawBlocklist: string | undefined,
  label: string,
): void {
  const blocklist = (rawBlocklist ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (blocklist.length === 0) {
    throw new Error(
      `[${label}] refusing to touch the database: TEST_DB_HOST_BLOCKLIST is unset or empty. ` +
        `Set it to the production Neon host fragment(s) (comma-separated) in .env.local / CI — ` +
        `the guard fails closed rather than trusting that DATABASE_URL is not prod.`,
    );
  }
  const blocked = blocklist.find((needle) => dbUrl.includes(needle));
  if (blocked) {
    throw new Error(
      `[${label}] refusing to touch a blocklisted database ` +
        `(host matched "${blocked}" from TEST_DB_HOST_BLOCKLIST). Point DATABASE_URL ` +
        `at a dev/test Neon branch — never production.`,
    );
  }
}
