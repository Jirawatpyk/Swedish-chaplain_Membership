/**
 * Spec 141 — every `new Resend(…)` in src pins `baseUrl`.
 *
 * resend@6.35 reads `RESEND_BASE_URL` from the process env when a client is
 * built; a client without an explicit `baseUrl` would send the Bearer key (and,
 * on contact calls, a member's email) wherever that var points.
 * `tests/contract/resend/base-url-pinned.contract.test.ts` proves it for the
 * three clients it names; this scan catches the next one.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(path);
  }
  return out;
}

/** Each `new Resend(` call's argument list, up to its closing parenthesis. */
export function resendConstructions(source: string): string[] {
  // Comments mention `new Resend(…)` too; only code counts.
  const code = source
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const calls: string[] = [];
  const re = /\bnew\s+Resend\s*\(/g;
  for (let m = re.exec(code); m !== null; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < code.length && depth > 0; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') depth -= 1;
    }
    calls.push(code.slice(m.index, i));
  }
  return calls;
}

/**
 * Pinned = `baseUrl` set to the shared constant. Any other value — an env
 * read, `undefined` — lets 6.35 fall back to RESEND_BASE_URL again.
 */
export function isPinned(call: string): boolean {
  return /\bbaseUrl\s*:\s*RESEND_API_BASE_URL\b/.test(call);
}

describe('Resend clients pin baseUrl (spec 141)', () => {
  it('the parser finds a construction and tells a pinned one from an unpinned one (positive control)', () => {
    expect(
      resendConstructions(
        '/** every `new Resend(…)` */\nconst a = new Resend(key, { baseUrl: B });\r\n// new Resend(x)\nconst b = new Resend(key);',
      ),
    ).toEqual(['new Resend(key, { baseUrl: B })', 'new Resend(key)']);
  });

  it('only the shared constant counts as pinned (an env-driven baseUrl does not)', () => {
    expect(isPinned('new Resend(key, { baseUrl: RESEND_API_BASE_URL })')).toBe(true);
    expect(isPinned('new Resend(key, { baseUrl: process.env.RESEND_BASE_URL })')).toBe(false);
    expect(isPinned('new Resend(key, { baseUrl: undefined })')).toBe(false);
    expect(isPinned('new Resend(key)')).toBe(false);
  });

  it('every new Resend(…) in src passes baseUrl: RESEND_API_BASE_URL', () => {
    const all: Array<{ file: string; call: string }> = [];
    // scripts/ too: an operator script holds a live key just as src does.
    for (const file of [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))]) {
      for (const call of resendConstructions(readFileSync(file, 'utf8'))) {
        all.push({ file: relative(ROOT, file).replace(/\\/g, '/'), call });
      }
    }
    // A scan that finds nothing proves nothing: there are three clients today.
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.filter((c) => !isPinned(c.call))).toEqual([]);
  });
});
