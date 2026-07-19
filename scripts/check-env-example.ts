#!/usr/bin/env tsx
/**
 * `check:env-example` CI gate — fails when a key declared in the
 * `src/lib/env.ts` zod schema is absent from `.env.example`.
 *
 * Thin CLI wrapper: reads the two real repo files and delegates every
 * pass/fail decision to `scripts/lib/env-example-core.ts` (pure, unit-tested
 * in `tests/unit/scripts/check-env-example.test.ts`). See that module's
 * docstring for the rationale, the exemption list, and the documented limits
 * of the source parse.
 *
 * Exit codes (mirroring `scripts/check-portal-guard.ts`):
 *   0 — every schema key is documented or exempted (stale keys warn only)
 *   1 — drift: one or more schema keys are undocumented
 *   2 — the gate could not do its job (file unreadable, schema block
 *       unparseable). Deliberately distinct from 0: a gate that cannot parse
 *       its input must NOT report success.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXEMPT_KEYS,
  SCHEMA_BLOCK_START,
  findStaleKeys,
  findUndocumentedKeys,
  parseDocumentedKeys,
  parseSchemaKeys,
} from './lib/env-example-core';

const ENV_TS = 'src/lib/env.ts';
const ENV_EXAMPLE = '.env.example';

function read(relPath: string): string {
  try {
    return readFileSync(resolve(relPath), 'utf8');
  } catch {
    console.error(`check:env-example — ${relPath} not found or unreadable. Check the path.`);
    process.exit(2);
  }
}

function main(): void {
  const schemaKeys = parseSchemaKeys(read(ENV_TS));
  if (schemaKeys.length === 0) {
    console.error(
      `check:env-example — parsed 0 keys from ${ENV_TS}. Expected to find a ` +
        `\`${SCHEMA_BLOCK_START}\` block terminated by a column-0 \`});\`. ` +
        'The schema was probably restructured (.extend()/.merge()/a second ' +
        'z.object) — update parseSchemaKeys in scripts/lib/env-example-core.ts ' +
        'rather than deleting this gate.',
    );
    process.exit(2);
    return;
  }

  const documentedKeys = parseDocumentedKeys(read(ENV_EXAMPLE));
  if (documentedKeys.length === 0) {
    console.error(
      `check:env-example — parsed 0 keys from ${ENV_EXAMPLE}. Expected lines ` +
        'of the form `KEY="value"` (a leading `#` is fine). Check the file.',
    );
    process.exit(2);
    return;
  }

  const undocumented = findUndocumentedKeys(schemaKeys, documentedKeys);
  const stale = findStaleKeys(schemaKeys, documentedKeys);

  if (stale.length > 0) {
    console.warn(
      `check:env-example — WARNING: ${stale.length} key(s) documented in ` +
        `${ENV_EXAMPLE} are not declared in the ${ENV_TS} schema:`,
    );
    for (const key of stale) console.warn(`  ${key}`);
    console.warn(
      'These may be stale docs for a removed feature (delete them), or vars ' +
        'read only by a script / the test harness rather than by the app at ' +
        'boot (fine to keep). Warning only — this does not fail the gate.\n',
    );
  }

  if (undocumented.length > 0) {
    console.error('check:env-example — env-var documentation coverage FAILED.\n');
    console.error(
      `${undocumented.length} key(s) declared in ${ENV_TS} are missing from ${ENV_EXAMPLE}:`,
    );
    for (const key of undocumented) console.error(`  ${key}`);
    console.error(
      `\nEvery key in the ${ENV_TS} zod schema must appear in ${ENV_EXAMPLE} as ` +
        'an assignment line (a commented-out `# KEY="value"` counts, for ' +
        'optional vars that should stay unset), with a comment saying what ' +
        'the var does and what its default is. Secrets are listed with a ' +
        'PLACEHOLDER value — never a real one. If a key genuinely must stay ' +
        'undocumented, add it to EXEMPT_KEYS in ' +
        'scripts/lib/env-example-core.ts with an accurate reason.',
    );
    process.exit(1);
    return;
  }

  console.log(
    `check:env-example — OK (${schemaKeys.length} schema key(s) scanned, ` +
      `${documentedKeys.length} documented, ${EXEMPT_KEYS.length} documented exemption(s)).`,
  );
}

const invokedDirectly =
  (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) ||
  process.argv[1]?.endsWith('check-env-example.ts') === true ||
  process.argv[1]?.endsWith('check-env-example.js') === true;

if (invokedDirectly) {
  main();
}
