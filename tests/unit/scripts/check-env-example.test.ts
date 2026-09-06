/**
 * `check:env-example` CI gate.
 *
 * Pure fixture tests against `scripts/lib/env-example-core.ts` (no filesystem
 * I/O — the CLI wrapper `scripts/check-env-example.ts` is the only piece that
 * touches disk) plus a "production wiring" regression guard that reads the
 * REAL `src/lib/env.ts` + `.env.example` and asserts they currently pass.
 *
 * The fixture suite deliberately leads with the FAILING direction. A
 * documentation gate that can only be observed passing is indistinguishable
 * from a gate that always passes, so every helper is exercised with input it
 * must reject before it is exercised with input it must accept.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  EXEMPT_KEYS,
  SCHEMA_BLOCK_START,
  findStaleKeys,
  findUndocumentedKeys,
  parseDocumentedKeys,
  parseSchemaKeys,
  HARNESS_ONLY_KEYS,
} from '../../../scripts/lib/env-example-core';

const FIXTURE_ENV_TS = `import { z } from 'zod';

const schema = z.object({
  // Runtime
  NODE_ENV: z.enum(['development', 'production']).default('development'),

  DATABASE_URL: z.string().url(),
  // A multi-line declaration — the key is still on its own line.
  SOME_SECRET: z
    .string()
    .min(32)
    .optional(),
  FEATURE_EXAMPLE: z.union([z.boolean(), z.string()]).default(false),
});

const parsed = schema.safeParse(process.env);
`;

const FIXTURE_ENV_EXAMPLE = `# --- Database ---
DATABASE_URL="postgresql://user:pass@host/db"

# A secret, listed with a PLACEHOLDER value.
SOME_SECRET="base64-of-32-random-bytes"

# Optional — commented out on purpose.
# FEATURE_EXAMPLE="false"
`;

describe('findUndocumentedKeys — the failing direction', () => {
  it('flags a schema key that has no line in .env.example', () => {
    const schemaKeys = ['DATABASE_URL', 'FEATURE_UNDOCUMENTED'];
    const documented = ['DATABASE_URL'];
    expect(findUndocumentedKeys(schemaKeys, documented, [])).toEqual([
      'FEATURE_UNDOCUMENTED',
    ]);
  });

  it('MUTATION GUARD — removing a documented key from the template makes the gate fail', () => {
    const schemaKeys = parseSchemaKeys(FIXTURE_ENV_TS);
    const intact = parseDocumentedKeys(FIXTURE_ENV_EXAMPLE);
    const exempt = [{ key: 'NODE_ENV', reason: 'runtime-provided, not authored in a .env file' }];

    // Baseline: the intact fixture pair passes.
    expect(findUndocumentedKeys(schemaKeys, intact, exempt)).toEqual([]);

    // Mutate: drop the DATABASE_URL assignment line, exactly as a careless
    // edit to the real file would.
    const mutated = FIXTURE_ENV_EXAMPLE.split('\n')
      .filter((line) => !line.startsWith('DATABASE_URL='))
      .join('\n');
    // Prove the mutation actually landed before asserting on its effect —
    // a mutant that never applied looks identical to a surviving one.
    expect(mutated).not.toBe(FIXTURE_ENV_EXAMPLE);
    const mutatedKeys = parseDocumentedKeys(mutated);
    expect(mutatedKeys).not.toContain('DATABASE_URL');

    expect(findUndocumentedKeys(schemaKeys, mutatedKeys, exempt)).toEqual([
      'DATABASE_URL',
    ]);
  });

  it('reports multiple undocumented keys, sorted lexicographically', () => {
    expect(findUndocumentedKeys(['B_KEY', 'A_KEY', 'C_KEY'], ['C_KEY'], [])).toEqual([
      'A_KEY',
      'B_KEY',
    ]);
  });

  it('a key exempted under a DIFFERENT name is still flagged', () => {
    const exempt = [{ key: 'OTHER_KEY', reason: 'not the same key' }];
    expect(findUndocumentedKeys(['GAP_KEY'], [], exempt)).toEqual(['GAP_KEY']);
  });

  it('passes a key that is on the exemption list', () => {
    const exempt = [{ key: 'NODE_ENV', reason: 'runtime-provided, not authored in a .env file' }];
    expect(findUndocumentedKeys(['NODE_ENV'], [], exempt)).toEqual([]);
  });

  it('passes when every schema key is documented', () => {
    expect(findUndocumentedKeys(['A_KEY', 'B_KEY'], ['A_KEY', 'B_KEY'], [])).toEqual([]);
  });
});

describe('parseSchemaKeys', () => {
  it('extracts every top-level key from the schema block, sorted', () => {
    expect(parseSchemaKeys(FIXTURE_ENV_TS)).toEqual([
      'DATABASE_URL',
      'FEATURE_EXAMPLE',
      'NODE_ENV',
      'SOME_SECRET',
    ]);
  });

  it('returns [] when the schema block is absent — the CLI turns this into exit 2, not a pass', () => {
    expect(parseSchemaKeys('export const nothing = 1;\n')).toEqual([]);
  });

  it('returns [] when the schema block is never terminated at column 0', () => {
    expect(parseSchemaKeys(`${SCHEMA_BLOCK_START}\n  DATABASE_URL: z.string(),\n`)).toEqual([]);
  });

  it('ignores commented-out declarations inside the schema block', () => {
    const src = `${SCHEMA_BLOCK_START}\n  // LEGACY_KEY: z.string(),\n  REAL_KEY: z.string(),\n});\n`;
    expect(parseSchemaKeys(src)).toEqual(['REAL_KEY']);
  });

  it('ignores keys nested inside a sub-object (deeper than 2-space indent)', () => {
    const src = `${SCHEMA_BLOCK_START}\n  OUTER: z.object({\n    INNER: z.string(),\n  }),\n});\n`;
    expect(parseSchemaKeys(src)).toEqual(['OUTER']);
  });

  it('ignores anything after the schema block ends', () => {
    const src = `${SCHEMA_BLOCK_START}\n  REAL_KEY: z.string(),\n});\n\nconst other = {\n  NOT_A_KEY: 1,\n};\n`;
    expect(parseSchemaKeys(src)).toEqual(['REAL_KEY']);
  });
});

describe('parseDocumentedKeys', () => {
  it('extracts assignment lines, including commented-out ones, sorted', () => {
    expect(parseDocumentedKeys(FIXTURE_ENV_EXAMPLE)).toEqual([
      'DATABASE_URL',
      'FEATURE_EXAMPLE',
      'SOME_SECRET',
    ]);
  });

  it('does NOT count a mid-sentence prose mention as documentation', () => {
    const src = '# Set ZAPIER_DPA_EXECUTED=true in Vercel env once the DPA is signed.\n';
    expect(parseDocumentedKeys(src)).toEqual([]);
  });

  it('counts an empty-string assignment', () => {
    expect(parseDocumentedKeys('CLAMAV_SCAN_URL=""\n')).toEqual(['CLAMAV_SCAN_URL']);
  });

  it('returns [] for a file with no assignment lines', () => {
    expect(parseDocumentedKeys('# just a comment\n\n')).toEqual([]);
  });
});

describe('findStaleKeys — the reverse direction (warn-only)', () => {
  it('reports a documented key the schema no longer declares', () => {
    expect(findStaleKeys(['KEPT_KEY'], ['KEPT_KEY', 'REMOVED_KEY'])).toEqual([
      'REMOVED_KEY',
    ]);
  });

  it('is empty when the template documents only schema keys', () => {
    expect(findStaleKeys(['A_KEY', 'B_KEY'], ['A_KEY'])).toEqual([]);
  });
});

describe('production wiring (regression guard for the real files)', () => {
  const envTs = readFileSync(resolve(process.cwd(), 'src/lib/env.ts'), 'utf8');
  const envExample = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');

  it('the REAL src/lib/env.ts schema block parses to a plausible number of keys', () => {
    // Guards the "parser silently matched nothing, so the gate passes
    // vacuously" failure mode. The floor is well below the real count (70 as
    // of 2026-07-19) and only has to be high enough that an empty or
    // near-empty parse cannot slip through.
    expect(parseSchemaKeys(envTs).length).toBeGreaterThan(50);
  });

  it('every REAL src/lib/env.ts schema key is documented in .env.example or exempted', () => {
    const schemaKeys = parseSchemaKeys(envTs);
    const documentedKeys = parseDocumentedKeys(envExample);
    expect(documentedKeys.length).toBeGreaterThan(50);
    expect(findUndocumentedKeys(schemaKeys, documentedKeys)).toEqual([]);
  });

  it('the REAL .env.example documents no key the schema has dropped', () => {
    expect(findStaleKeys(parseSchemaKeys(envTs), parseDocumentedKeys(envExample))).toEqual([]);
  });

  it('every EXEMPT_KEYS entry names a key the schema really declares', () => {
    // An exemption for a key that no longer exists is dead weight that hides
    // the fact the gate is no longer covering anything.
    const schemaKeys = new Set(parseSchemaKeys(envTs));
    for (const entry of EXEMPT_KEYS) {
      expect(schemaKeys.has(entry.key), `${entry.key} is exempted but not in the schema`).toBe(true);
    }
  });

  it('every EXEMPT_KEYS entry carries a substantive documented reason', () => {
    expect(EXEMPT_KEYS.length).toBeGreaterThan(0);
    for (const entry of EXEMPT_KEYS) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });
});

/**
 * 108 PR-D review cycle 11 (security LOW-5) — `HARNESS_ONLY_KEYS`: keys the
 * template documents for the test harness only. The allow-list must be REAL
 * in both directions, or the stale-key pin above goes vacuous.
 */
describe('HARNESS_ONLY_KEYS (template keys the app schema never declares)', () => {
  const envTs = readFileSync(resolve(process.cwd(), 'src/lib/env.ts'), 'utf8');
  const envExample = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');

  it('every entry is documented in the REAL .env.example (not a dead allow-list line)', () => {
    const documented = new Set(parseDocumentedKeys(envExample));
    for (const entry of HARNESS_ONLY_KEYS) {
      expect(documented.has(entry.key), `${entry.key} is allow-listed but not in .env.example`).toBe(true);
    }
  });

  it('no entry is ALSO declared by src/lib/env.ts (then it is an app key, not a harness key)', () => {
    const schema = new Set(parseSchemaKeys(envTs));
    for (const entry of HARNESS_ONLY_KEYS) {
      expect(schema.has(entry.key), `${entry.key} is in the schema — drop it from HARNESS_ONLY_KEYS`).toBe(false);
    }
  });

  it('every entry carries a substantive reason', () => {
    expect(HARNESS_ONLY_KEYS.length).toBeGreaterThan(0);
    for (const entry of HARNESS_ONLY_KEYS) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it('the allow-list is what keeps the stale-key check green — an empty list reports the harness key', () => {
    // Positive control: prove the filter does work, so the "no stale keys"
    // pin above cannot pass because the parser matched nothing.
    const stale = findStaleKeys(parseSchemaKeys(envTs), parseDocumentedKeys(envExample), []);
    expect(stale).toEqual(HARNESS_ONLY_KEYS.map((e) => e.key).sort());
  });
});
