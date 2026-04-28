/**
 * R3 S-5 (2026-04-28): shared DB URL resolution + unpooled-client
 * factory used by all migration / verify / sync scripts. Avoids
 * 3-fallback chain duplication across `run-migrations.ts`,
 * `sync-drizzle-bookkeeping.ts`, and `verify-schema.ts`.
 */
import postgres, { type Sql } from 'postgres';

/**
 * Resolves the unpooled DB URL from the standard environment variable
 * fallback chain. Calls `process.exit(1)` with a helpful error if
 * none is set.
 */
export function resolveUnpooledUrl(callerName: string): string {
  const url =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL;
  if (!url) {
    console.error(
      `${callerName}: DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.`,
    );
    process.exit(1);
  }
  return url;
}

/**
 * Standard pooled-off client config used by all schema-changing or
 * schema-inspecting scripts. `max:1` because we never want connection
 * pooling to interfere with DDL or inspection queries.
 */
export function makeUnpooledClient(
  url: string,
  options: { readonly statementTimeoutMs?: number } = {},
): Sql {
  return postgres(url, {
    max: 1,
    ssl: 'require',
    connection: {
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    } as Record<string, string | number>,
  });
}
