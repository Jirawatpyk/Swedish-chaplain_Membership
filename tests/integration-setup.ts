/**
 * Vitest integration setup — runs before tests/integration/**.
 *
 * Integration tests require a real Postgres instance. If DATABASE_URL is
 * missing we skip the entire suite via a top-level error, surfacing the
 * reason clearly rather than silently passing.
 */
import { beforeAll } from 'vitest';

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
