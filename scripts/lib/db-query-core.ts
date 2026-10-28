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
 *   - on the unpooled endpoint the session starts with
 *     `default_transaction_read_only = on` as a second layer, and a 30 s
 *     `statement_timeout`. Both go in the `options` startup parameter as `-c`
 *     flags, because Neon's proxy drops plain startup parameters; the pooler
 *     refuses `options` outright, so a pooled URL gets neither and relies on
 *     the two layers above.
 *
 * Printed output is masked on a best-effort basis, to keep credentials out of
 * a session transcript by ACCIDENT; it is not a boundary against a deliberate
 * query. A statement naming a table that holds sessions or link tokens is
 * refused, credential-named columns are masked, and so are 40+ hex runs and
 * the token part of reset / invite links and token-named query parameters.
 * An alias or an expression over another table can still print a secret.
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
  const options = sessionOptions(url);
  const sql = postgres(url, { max: 1, ssl: 'require', ...(options ? { connection: { options } } : {}) });
  return {
    host: new URL(url).hostname,
    query: async (text) => {
      const refusal = secretTableRefusal(text);
      if (refusal !== null) throw new Error(refusal);
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

const SESSION_FLAGS = '-c default_transaction_read_only=on -c statement_timeout=30000';

/**
 * The `options` startup parameter: the URL's own value (Neon's
 * `endpoint=…` for clients without SNI) followed by the read-only flags, or
 * nothing on the pooler, which refuses the parameter.
 */
export function sessionOptions(url: string): string {
  const parsed = new URL(url);
  if (parsed.hostname.includes('-pooler')) return '';
  const own = parsed.searchParams.get('options');
  return own ? `${own} ${SESSION_FLAGS}` : SESSION_FLAGS;
}

/** Tables whose rows are sessions or link tokens (hashed or not). */
const SECRET_TABLES = [
  'sessions',
  'password_reset_tokens',
  'email_change_tokens',
  'consumed_link_tokens',
  'invitations',
] as const;

/** A refusal when the statement names a secret table as a whole word, else null. */
export function secretTableRefusal(text: string): string | null {
  const hit = SECRET_TABLES.find((t) => new RegExp(`\\b${t}\\b`, 'i').test(text));
  return hit === undefined
    ? null
    : `db:query refuses a statement naming ${hit}: its rows are sessions or link tokens. Count them instead in a test, or read them in the Neon console.`;
}

/** Masks token-shaped substrings in a printed line. */
export function redactText(text: string): string {
  return text
    .replace(/[0-9a-f]{40,}/gi, '[redacted]')
    .replace(/(\/(?:reset-password|invite)\/)[^/?#"\s]+/g, '$1[redacted]')
    .replace(/([?&](?:token|code|key|secret|sig)=)[^&#"\s]+/gi, '$1[redacted]');
}
