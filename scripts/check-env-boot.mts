#!/usr/bin/env tsx
/**
 * `check:env-boot` CI gate — fails when `.env.example`, copied verbatim,
 * cannot satisfy the `src/lib/env.ts` zod schema.
 *
 * Why this exists ALONGSIDE `check:env-example`, not instead of it:
 *
 *   `check:env-example` verifies a schema key is DOCUMENTED. It says nothing
 *   about whether the documented VALUE is valid. Five keys once shipped
 *   placeholders shorter than their own `.min(32)` validators
 *   (AUTH_COOKIE_SIGNING_SECRET, RESEND_BROADCASTS_WEBHOOK_SECRET,
 *   UNSUBSCRIBE_TOKEN_SECRET, RENEWAL_LINK_TOKEN_SECRET_PRIMARY,
 *   EVENTCREATE_PII_PSEUDONYM_SALT). Every one was fully documented, so
 *   `check:env-example` was green the entire time — on a template that could
 *   not boot. Presence and validity are two different contracts; this gate
 *   owns the second one. Run both.
 *
 * The contract enforced here is VERBATIM: `cp .env.example .env.local` must
 * be enough to boot. No fill-in pass, no substitution list. A new developer
 * gets a running app before provisioning a single third-party account; the
 * obviously-fake DATABASE_URL / API keys then fail at the point of actual
 * use, which is the correct onboarding order. If a future key genuinely has
 * no valid placeholder, the fix is to make the key optional or give it a
 * valid placeholder — not to weaken this gate into a substitution table that
 * silently rots.
 *
 * How it reproduces the real boot path rather than approximating it:
 *   1. Copies `.env.example` to a scratch `.env.local` in the OS temp dir —
 *      OUTSIDE the repo, so no `.env.local` is ever written where it could be
 *      staged, and so Next's loader cannot pick up the repo's own `.env*`.
 *   2. Strips `process.env` down to an OS allowlist FIRST, so the developer's
 *      real environment cannot supply a value the template omits and mask the
 *      failure. A gate that passes only on the author's machine is worse than
 *      no gate; `tests/unit/scripts/check-env-boot.test.ts` asserts this
 *      immunity directly by exporting a valid value for a deliberately broken
 *      key and requiring the gate to fail anyway.
 *   3. Loads the scratch file with the loader Next.js itself uses
 *      (`@next/env`), not a hand-rolled parser, so quoting and expansion
 *      semantics match the real boot.
 *   4. Imports the real `src/lib/env.ts`, which throws synchronously (never
 *      `process.exit`) listing every offending key at once.
 *
 * Because step 2 destroys this process's own environment, the gate must run
 * in a dedicated process — it cannot be imported into a test runner. Its
 * tests spawn it.
 *
 * `.mts` rather than `.ts` (unlike its `check:*` siblings) because the repo has
 * no `"type": "module"`, so a plain `.ts` script is transformed to CJS — which
 * rejects the top-level `await` and the dynamic ESM `import()` of `env.ts` that
 * this gate is built on. `scripts/check-outbox.mjs` is the existing precedent.
 *
 * Usage: tsx scripts/check-env-boot.mts [--template <path>]
 *   --template  validate a different template file. Exists so the gate can be
 *               pointed at a deliberately-broken copy to prove it still
 *               fails; the shipped `.env.example` is the default.
 *
 * Exit codes (mirroring `scripts/check-env-example.ts`):
 *   0 — the copied template satisfies the schema
 *   1 — it does not: the template cannot be copied into a working dev env
 *   2 — the gate could not do its job (template or schema missing, `@next/env`
 *       unresolvable, loader produced nothing). Deliberately distinct from 0:
 *       a gate that cannot run must NOT report success.
 */
import { createRequire } from 'node:module';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENV_TS = 'src/lib/env.ts';
const ENV_EXAMPLE = '.env.example';

/**
 * The only variables allowed to survive from the ambient environment. These
 * are OS/toolchain plumbing that the schema never reads; everything the
 * schema could possibly read must come from the copied template.
 */
const OS_ALLOWLIST = new Set([
  'PATH', 'Path', 'SystemRoot', 'SystemDrive', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'OS', 'WINDIR',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'HOMEDRIVE', 'HOMEPATH',
]);

/**
 * Thrown for "the gate could not do its job" (exit 2), as distinct from "the
 * template does not boot" (exit 1). Thrown rather than `process.exit`ed so the
 * scratch directory's `finally` cleanup still runs — `process.exit` skips it.
 */
class GateBrokenError extends Error {}

function fail(message: string): never {
  throw new GateBrokenError(message);
}

function parseTemplateArg(argv: string[]): string {
  const index = argv.indexOf('--template');
  if (index === -1) return resolve(ENV_EXAMPLE);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    fail('--template requires a path argument.');
  }
  return resolve(value);
}

/** Resolves to the process exit code. Never calls `process.exit` itself. */
async function main(): Promise<number> {
  const templatePath = parseTemplateArg(process.argv.slice(2));
  const envModulePath = resolve(ENV_TS);

  // Resolve `@next/env` through `next` itself. It is a transitive dependency,
  // so under pnpm's strict layout it is NOT linked at the repo's top-level
  // node_modules — but it is always resolvable from next's own package.
  // Resolved before the environment is stripped, purely so a resolution
  // failure reports as "gate broken" rather than as a template failure.
  let nextEnvPath: string;
  try {
    const require = createRequire(import.meta.url);
    const nextPkg = require.resolve('next/package.json');
    nextEnvPath = createRequire(nextPkg).resolve('@next/env');
  } catch {
    fail(
      'could not resolve `@next/env` via `next`. Dependencies are probably ' +
        'not installed (run `pnpm install`), or Next.js changed how it ships ' +
        'its env loader. Fix the resolution rather than deleting this gate — ' +
        'using Next\'s own loader is what makes this gate match the real boot.',
    );
  }

  // Copy the template to a scratch `.env.local` OUTSIDE the repo. Never write
  // a `.env.local` into the working tree: it would be one `git add` away from
  // a committed secrets file.
  const scratchDir = mkdtempSync(join(tmpdir(), 'chamber-os-env-boot-'));

  try {
    try {
      copyFileSync(templatePath, join(scratchDir, '.env.local'));
    } catch {
      fail(`${templatePath} not found or unreadable. Check the path.`);
    }

    // --- Isolation. Everything below reads the copied template only. --------
    for (const key of Object.keys(process.env)) {
      if (!OS_ALLOWLIST.has(key)) delete process.env[key];
    }
    // Explicitly unset rather than allowlisted, so we exercise the schema's
    // own NODE_ENV default ('development') — what a fresh checkout gets, and
    // what decides whether the production-only validators fire.
    // Cast: Next.js augments ProcessEnv with a `readonly NODE_ENV`, which the
    // `delete` operator rejects. The runtime deletion is the whole point here.
    delete (process.env as Record<string, string | undefined>)['NODE_ENV'];

    const { loadEnvConfig } = (await import(pathToFileURL(nextEnvPath).href)) as {
      loadEnvConfig: (
        dir: string,
        dev: boolean,
        logger: { info: (msg: string) => void; error: (msg: string) => void },
      ) => unknown;
    };
    loadEnvConfig(scratchDir, true, { info: () => {}, error: () => {} });

    const loadedKeys = Object.keys(process.env).filter((k) => !OS_ALLOWLIST.has(k));
    if (loadedKeys.length === 0) {
      // The loader ran but produced nothing. Reporting this as a template
      // failure would be a lie, and reporting it as success would make the
      // gate vacuous — a schema of pure defaults would "boot".
      fail(
        `loaded 0 variables from ${templatePath}. Expected assignment lines ` +
          'of the form `KEY="value"`. Either the template is empty/malformed ' +
          'or the `@next/env` loader contract changed.',
      );
    }

    try {
      await import(pathToFileURL(envModulePath).href);
    } catch (error) {
      console.error(
        `check:env-boot — ${ENV_EXAMPLE} is NOT copyable into a working dev environment.\n`,
      );
      console.error(error instanceof Error ? error.message : String(error));
      console.error(
        `\nA developer running \`cp ${ENV_EXAMPLE} .env.local\` gets the error ` +
          'above instead of a running app. Every key listed is documented but ' +
          'carries a placeholder its own validator rejects (most often a ' +
          `secret shorter than \`.min(32)\`, or — see ${ENV_TS} — two secrets ` +
          'that must be DISTINCT sharing one value). Fix the placeholder in ' +
          `${ENV_EXAMPLE}; do NOT relax the validator.`,
      );
      return 1;
    }

    console.log(
      `check:env-boot — OK (${loadedKeys.length} variable(s) loaded from ` +
        `${ENV_EXAMPLE} verbatim; ${ENV_TS} parsed them and boots).`,
    );
    return 0;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  if (error instanceof GateBrokenError) {
    console.error(`check:env-boot — ${error.message}`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
