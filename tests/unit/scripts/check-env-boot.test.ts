/**
 * `check:env-boot` CI gate.
 *
 * This gate has no pure core to fixture-test: its entire value is that it
 * boots the REAL `src/lib/env.ts` against the REAL `.env.example` in a
 * hermetic process. So it is tested the only way that means anything —
 * by running it and observing its exit code.
 *
 * The suite deliberately leads with the FAILING direction. A boot gate that
 * has only ever been observed passing is indistinguishable from a gate that
 * always passes (`check:env-example` was green for the entire life of five
 * placeholders that could not satisfy their own `.min(32)` validators — that
 * is precisely the defect this gate exists to catch, and precisely the shape
 * this suite must not reproduce).
 *
 * Three assertions, in order of how much they prove:
 *   1. A too-short placeholder makes the gate exit 1 AND name the key.
 *   2. The gate is immune to a leaking parent environment — the same broken
 *      template still fails even when a perfectly valid value for the broken
 *      key is exported into the gate's own process env. Without this, the
 *      gate would pass on the author's machine (which has a real `.env.local`
 *      loaded) and fail nowhere, which is worse than having no gate.
 *   3. The real, shipped `.env.example` currently boots (exit 0).
 *
 * Each case spawns the gate as a child process because the gate destroys its
 * own `process.env` by design; it cannot run inside the test runner.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const GATE = join('scripts', 'check-env-boot.mts');
const REAL_TEMPLATE = join(REPO_ROOT, '.env.example');

/** A key whose validator is `.min(32)` — see `src/lib/env.ts`. */
const BROKEN_KEY = 'AUTH_COOKIE_SIGNING_SECRET';
/** Shorter than 32 chars, so it cannot satisfy that validator. */
const TOO_SHORT = 'too-short';
/** 40 chars — long enough to satisfy `.min(32)` if it were ever honoured. */
const VALID_LENGTH_VALUE = 'leak-canary-value-that-is-long-enough-40';

let scratch: string;

/**
 * Runs the gate with `--template <path>` and returns its result.
 *
 * `extraEnv` is merged into the CHILD's environment. Case 2 uses it to
 * simulate the leak the gate must be immune to.
 */
function runGate(
  templatePath: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; output: string } {
  // Spawn node directly with the tsx loader rather than going through
  // `pnpm exec`: on Windows that needs `shell: true`, and a shell mangles the
  // repo's own path, which contains a space ("Swedish chaplain_membership").
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', GATE, '--template', templatePath],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** Copy of the real template with `BROKEN_KEY` reverted to a too-short value. */
function writeMutatedTemplate(): string {
  const original = readFileSync(REAL_TEMPLATE, 'utf8');
  const pattern = new RegExp(`^${BROKEN_KEY}=.*$`, 'm');

  // Prove the mutant landed before drawing any conclusion from it. An
  // unapplied mutation is indistinguishable from a passing gate.
  expect(
    pattern.test(original),
    `${BROKEN_KEY} must exist as an uncommented assignment in .env.example ` +
      'for this mutation test to mean anything',
  ).toBe(true);

  const mutated = original.replace(pattern, `${BROKEN_KEY}="${TOO_SHORT}"`);
  expect(mutated, 'the mutation must actually change the template').not.toBe(
    original,
  );

  const path = join(scratch, '.env.example.mutated');
  writeFileSync(path, mutated);
  return path;
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'env-boot-gate-test-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('check:env-boot — the failing direction', () => {
  it('exits non-zero and names the key when a placeholder is too short for its validator', () => {
    const { status, output } = runGate(writeMutatedTemplate());

    expect(status).toBe(1);
    expect(output).toContain(BROKEN_KEY);
    expect(output).toMatch(/at least 32 character/i);
  });

  it('is immune to a leaking parent environment', () => {
    // The parent exports a value that WOULD satisfy the validator. If the
    // gate let the ambient environment through, this would flip the previous
    // case green and the gate would be silently useless everywhere except a
    // pristine shell.
    const { status, output } = runGate(writeMutatedTemplate(), {
      [BROKEN_KEY]: VALID_LENGTH_VALUE,
    });

    expect(status).toBe(1);
    expect(output).toContain(BROKEN_KEY);
  });
});

describe('check:env-boot — production wiring', () => {
  it('the shipped .env.example boots the real src/lib/env.ts verbatim', () => {
    const { status, output } = runGate(REAL_TEMPLATE);

    expect(status, output).toBe(0);
    expect(output).toMatch(/boots/i);
  });
});
