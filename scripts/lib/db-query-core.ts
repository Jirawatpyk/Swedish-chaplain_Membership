/**
 * The read-only SQL runner behind `pnpm db:query` (D-032).
 *
 * Claude may not read `.env*` (D-016), so an ad-hoc SELECT against the dev
 * branch had no sanctioned route: the connection string has to reach a child
 * process through `node --env-file`, as `db:migrate` and `db:verify` do. This
 * is that route, and it must not become a write path:
 *
 *   - the prod host is refused BEFORE a connection opens, with the same
 *     fail-closed `TEST_DB_HOST_BLOCKLIST` guard the integration harness uses;
 *   - every statement runs inside `BEGIN READ ONLY`, so Postgres refuses DDL,
 *     data writes and sequence advances;
 *   - the statement goes through the extended protocol, which takes ONE
 *     command, so `SELECT 1; COMMIT; DELETE …` cannot end the read-only
 *     transaction and write after it;
 *   - the session starts with `default_transaction_read_only = on` as a second
 *     layer, and a 30 s `statement_timeout`. Both go in the `options` startup
 *     parameter as `-c` flags, because Neon's proxy drops plain startup
 *     parameters. Verified on the unpooled endpoint, which the caller passes
 *     when there is one (the pooler drops `statement_timeout`).
 *
 * Not covered: functions with effects outside the transaction
 * (`pg_terminate_backend`, advisory locks). The role is `neondb_owner`, which
 * has BYPASSRLS, so the client sees every dev tenant; dev holds seed and test
 * data only. There is no `:prod` variant.
 */
import postgres from 'postgres';
import { assertDbHostNotBlocklisted } from '../../tests/helpers/db-host-guard';

export interface ReadOnlyClient {
  /** The host the client reads, never the URL. */
  readonly host: string;
  query(text: string): Promise<readonly Record<string, unknown>[]>;
  end(): Promise<void>;
}

export function openReadOnlyClient(url: string, blocklistRaw: string | undefined): ReadOnlyClient {
  assertDbHostNotBlocklisted(url, blocklistRaw, 'db:query');
  const sql = postgres(url, {
    max: 1,
    ssl: 'require',
    connection: { options: '-c default_transaction_read_only=on -c statement_timeout=30000' },
  });
  return {
    host: new URL(url).hostname,
    query: async (text) => {
      // `simple: false` is a runtime option the typings omit. Without it an
      // argument-less unsafe() uses the simple protocol, which runs every
      // `;`-separated command it is given.
      const extendedProtocol = { simple: false, prepare: false } as postgres.UnsafeQueryOptions;
      const rows = await sql.begin('read only', (tx) => tx.unsafe(text, [], extendedProtocol));
      return [...rows] as Record<string, unknown>[];
    },
    end: () => sql.end(),
  };
}

/** A column whose name says it holds a credential. Matches snake_case and camelCase. */
const CREDENTIAL_COLUMN = /(password|token|secret|session_?id|api_?key)/i;

/** Masks credential-shaped columns so a printed row cannot leak one. */
export function redactRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v !== null && CREDENTIAL_COLUMN.test(k) ? '[redacted]' : v]),
  );
}
