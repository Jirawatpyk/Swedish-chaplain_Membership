/**
 * Pure helpers for the `check:env-example` CI gate, shared by
 * `scripts/check-env-example.ts` (CLI) and
 * `tests/unit/scripts/check-env-example.test.ts`.
 *
 * ── WHY THIS GATE EXISTS ──────────────────────────────────────────────────
 * `src/lib/env.ts` is the single zod schema every environment variable must
 * pass at boot. `.env.example` is the template an operator copies to
 * `.env.local` and the only inventory of what Vercel env must contain. The
 * two files had NOTHING comparing them, and by 2026-07-19 they had drifted by
 * 14 keys — including `EVENTCREATE_PII_PSEUDONYM_SALT`, whose absence made
 * `.env.example` non-bootable when copied verbatim (the file ships
 * `FEATURE_F6_EVENTCREATE=true`, and a cross-field validator refuses to boot
 * without the salt).
 *
 * A missing key is an onboarding failure regardless of what the key holds:
 * an undocumented `RESEND_API_KEY` breaks a new checkout exactly as hard as
 * an undocumented feature flag, and an undocumented flag additionally hides a
 * shipped feature from every operator who never reads `env.ts`. So this gate
 * covers ALL keys, not just `FEATURE_*`. Secrets are listed with a
 * PLACEHOLDER value — the file's long-standing convention (`re_your_api_key`,
 * `whsec_...`) — never a real one.
 *
 * ── WHAT THE PARSER CANNOT SEE ────────────────────────────────────────────
 * `parseSchemaKeys` is a regex over source text, matching the same way the
 * repo's other `check:*` gates do. Deliberate limits, so the next person
 * knows where the gate stops helping:
 *   - It reads ONLY the `const schema = z.object({ … });` block. Keys added
 *     via `.extend()` / `.merge()`, a second `z.object`, an object spread, or
 *     a computed property name are INVISIBLE to it.
 *   - It matches a key by its own 2-space-indented `KEY:` line, so a
 *     multi-line VALUE (`KEY: z\n  .string()\n  .min(32)`) is handled fine,
 *     but a declaration whose key and colon are not on one line is not.
 *   - It cannot model CONDITIONAL requirement. Several keys are `.optional()`
 *     in the schema and made mandatory by a cross-field validator further
 *     down the file (`EVENTCREATE_PII_PSEUDONYM_SALT` when F6 is on,
 *     `EXPORT_DOWNLOAD_TOKEN_SECRET` when F9 is on). The gate proves such a
 *     key is DOCUMENTED; it cannot prove the docs describe the condition.
 * Failing loud on an unparseable schema block (exit 2, not 0) is what keeps
 * these limits from degrading into a gate that silently always passes.
 */

export interface ExemptEnvKey {
  readonly key: string;
  readonly reason: string;
}

/**
 * Keys intentionally absent from `.env.example`. Every entry needs an
 * accurate, specific reason — a key that was merely FORGOTTEN must never be
 * added here, because that is precisely the drift this gate exists to catch.
 *
 * All 4 entries were verified against `src/lib/env.ts` on 2026-07-19.
 */
export const EXEMPT_KEYS: readonly ExemptEnvKey[] = [
  {
    key: 'NODE_ENV',
    reason:
      'Provided by the runtime (Next.js / Vercel / vitest), never authored in ' +
      'a .env file. Documenting it would invite an operator to pin it by hand ' +
      'and, e.g., boot a production deployment as "development".',
  },
  {
    key: 'POSTGRES_URL_NON_POOLING',
    reason:
      'Vercel/Neon-integration ALIAS for DATABASE_URL_UNPOOLED, which IS ' +
      'documented. env.ts accepts either and normalises; documenting both ' +
      'halves of an either/or pair reads as "set both".',
  },
  {
    key: 'UPSTASH_REDIS_REST_URL',
    reason:
      'Plain-Upstash ALIAS for KV_REST_API_URL, which IS documented (and the ' +
      'alias is already named in that entry\'s prose). env.ts accepts either.',
  },
  {
    key: 'UPSTASH_REDIS_REST_TOKEN',
    reason:
      'Plain-Upstash ALIAS for KV_REST_API_TOKEN, which IS documented (and ' +
      'the alias is already named in that entry\'s prose). env.ts accepts either.',
  },
];

/** Marks the start of the one schema object `parseSchemaKeys` reads. */
export const SCHEMA_BLOCK_START = 'const schema = z.object({';
/** Column-0 terminator of that object. */
const SCHEMA_BLOCK_END = '\n});';

/**
 * Pure parse: extract the env keys declared in `src/lib/env.ts`'s single
 * `const schema = z.object({ … });` block. Returns them sorted; returns an
 * empty array when the block cannot be located (the CLI treats that as a
 * hard error, NOT as "no keys to check").
 */
export function parseSchemaKeys(envTsSource: string): string[] {
  const start = envTsSource.indexOf(SCHEMA_BLOCK_START);
  if (start === -1) return [];
  const bodyStart = start + SCHEMA_BLOCK_START.length;
  const end = envTsSource.indexOf(SCHEMA_BLOCK_END, bodyStart);
  if (end === -1) return [];

  const keys = new Set<string>();
  for (const line of envTsSource.slice(bodyStart, end).split(/\r?\n/)) {
    // Top-level entries only: exactly 2 spaces of indent, SCREAMING_SNAKE
    // name, then a colon. Comment lines start with `//` and never match.
    const match = /^ {2}([A-Z][A-Z0-9_]*):/.exec(line);
    if (match?.[1] !== undefined) keys.add(match[1]);
  }
  return [...keys].sort();
}

/**
 * Pure parse: extract the env keys documented in `.env.example`. A key counts
 * as documented when the file carries an assignment line for it — including a
 * COMMENTED-OUT one (`# DATABASE_POOL_MAX="10"`), which the file already uses
 * as its idiom for optional vars that should stay unset by default.
 *
 * A bare prose mention (`# Set ZAPIER_DPA_EXECUTED=true in Vercel env`) does
 * NOT count: the key must open its line, so mid-sentence references cannot
 * satisfy the gate.
 */
export function parseDocumentedKeys(envExampleSource: string): string[] {
  const keys = new Set<string>();
  for (const line of envExampleSource.split(/\r?\n/)) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match?.[1] !== undefined) keys.add(match[1]);
  }
  return [...keys].sort();
}

/**
 * Keys declared in the zod schema but absent from `.env.example` and not on
 * the exemption list. Non-empty ⇒ the gate FAILS. Sorted for stable output.
 */
export function findUndocumentedKeys(
  schemaKeys: readonly string[],
  documentedKeys: readonly string[],
  exemptKeys: readonly ExemptEnvKey[] = EXEMPT_KEYS,
): string[] {
  const documented = new Set(documentedKeys);
  const exempt = new Set(exemptKeys.map((e) => e.key));
  return schemaKeys.filter((k) => !documented.has(k) && !exempt.has(k)).sort();
}

/**
 * The reverse direction: keys documented in `.env.example` that the schema no
 * longer declares — stale docs pointing at a removed feature, which an
 * operator may still be setting in Vercel env.
 *
 * This WARNS rather than fails. A documented key that env.ts does not declare
 * is not necessarily wrong: a var consumed only by a script, a migration
 * runner, or the test harness (rather than by the app at boot) legitimately
 * belongs in the template while being absent from the app's schema. Failing
 * on that would push people to delete accurate documentation to get a green
 * build. Drift in THIS direction misleads; drift in the other direction
 * breaks the app, which is why only the other direction blocks.
 */
export function findStaleKeys(
  schemaKeys: readonly string[],
  documentedKeys: readonly string[],
): string[] {
  const schema = new Set(schemaKeys);
  return documentedKeys.filter((k) => !schema.has(k)).sort();
}
