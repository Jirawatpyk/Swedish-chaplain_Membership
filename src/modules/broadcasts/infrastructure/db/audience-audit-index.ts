/**
 * Spec 143 (TT1) — the one TS source for the text of migration 0328's partial
 * unique index `audit_log_audience_deleted_once`, the arbiter of
 * `f7AuditAdapter.emitOnce`.
 *
 * Every value is literal SQL, spliced with `sql.raw` (or into a plain query
 * string), never a bound parameter: a parameter in the `ON CONFLICT` target or
 * its WHERE is a 42P10 (Postgres cannot prove the index predicate), and a
 * bound key expression would cost the existence read its index.
 *
 * Callers: the adapter's `ON CONFLICT`, the repo's `hasAudienceDeletedAuditInTx`,
 * `scripts/verify-schema.ts`'s 0328 canary and `audience-audit-rows.test.ts`.
 * The `.sql` migration cannot import TS, so it keeps a copy; that test pins the
 * migration's CREATE and its `v_expected` to these constants, and
 * `audience-audit-sites.test.ts` fails if the adapter or the repo spells the
 * text inline.
 *
 * Its one import is relative and has only type imports of its own: the
 * verify-schema script loads this module under plain tsx, with no path alias.
 */
import { AUDIENCE_AUDIT_PAYLOAD_KEYS } from '../../application/ports/audit-port';

/** The deleted row's segment key, as the index expression reads it. */
export const AUDIENCE_DELETED_ID_EXPR_SQL = `payload->>'${AUDIENCE_AUDIT_PAYLOAD_KEYS.resendAudienceId}'`;

/** The index key, and so the `ON CONFLICT` target. */
export const AUDIENCE_DELETED_KEY_SQL = `(tenant_id, (${AUDIENCE_DELETED_ID_EXPR_SQL}))`;

/** The index predicate, and so the `ON CONFLICT ... WHERE`. */
export const AUDIENCE_DELETED_PREDICATE_SQL = "event_type = 'broadcast_audience_deleted'";

/**
 * The index's definition as `pg_get_indexdef` prints it on dev (read 7 Nov
 * 2026), the value of 0328's `v_expected`. Compared only through
 * `normaliseIndexDefSql`.
 */
export const AUDIENCE_DELETED_INDEX_DEF =
  "CREATE UNIQUE INDEX audit_log_audience_deleted_once ON public.audit_log USING btree (tenant_id, ((payload ->> 'resend_audience_id'::text))) WHERE (event_type = 'broadcast_audience_deleted'::audit_event_type)";

/**
 * The normalisation 0328 applies to both sides of its comparison: the
 * `public.` schema qualifier dropped, whitespace collapsed. `[[:space:]]`, not
 * `\s`, so the text survives a template literal unchanged. `expr` is SQL.
 */
export function normaliseIndexDefSql(expr: string): string {
  return `btrim(regexp_replace(replace(${expr}, 'public.', ''), '[[:space:]]+', ' ', 'g'))`;
}

/** `text` as a SQL string literal (quotes doubled), for a constant spliced into a query string. */
export function sqlStringLiteral(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** The index's name, as migration 0328 creates it. */
export const AUDIENCE_DELETED_INDEX_NAME = 'audit_log_audience_deleted_once';

/**
 * Review round 1 (code-review #5) — `scripts/verify-schema.ts`'s 0328 canary,
 * the whole query: one row when the index exists, is VALID (an invalid index
 * is not used for ON CONFLICT inference) and its normalised definition is
 * `AUDIENCE_DELETED_INDEX_DEF`. The script runs it as it is, and
 * `audience-audit-rows.test.ts` executes this same text on dev.
 */
export const AUDIENCE_DELETED_INDEX_CANARY_SQL =
  `SELECT 1 AS hit FROM pg_index i WHERE i.indexrelid = to_regclass(${sqlStringLiteral(`public.${AUDIENCE_DELETED_INDEX_NAME}`)}) ` +
  `AND i.indisvalid AND ${normaliseIndexDefSql('pg_get_indexdef(i.indexrelid)')} = ${normaliseIndexDefSql(sqlStringLiteral(AUDIENCE_DELETED_INDEX_DEF))}`;
