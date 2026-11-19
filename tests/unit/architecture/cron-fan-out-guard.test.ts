/**
 * #97 — every cron route that fans out over HTTP to `APP_BASE_URL` calls the
 * shared origin guard (`refuseCrossOriginFanOut(`) before it fetches. R162
 * showed what a coordinator does without it: run on :3400 with `.env.local`
 * pointing at prod, its per-tenant calls ran on prod.
 *
 * Positive control: the scan must find at least MIN_FAN_OUT routes, so a scan
 * that silently matches nothing fails. Comments are stripped and `\r` removed
 * before matching (CRLF checkouts).
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const CRON_DIR = join(ROOT, 'src/app/api/cron');
const MIN_FAN_OUT = 7;

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === 'route.ts' ? [p] : [];
  });
}

function stripComments(src: string): string {
  return src
    .replace(/\r/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FAN_OUT = /\$\{(?:baseUrl|env\.app\.baseUrl)\}\/api\/cron\//;

describe('cron fan-out origin guard coverage (#97)', () => {
  const files = routeFiles(CRON_DIR).map((p) => ({ p, src: stripComments(readFileSync(p, 'utf8')) }));
  const fanOut = files.filter((f) => FAN_OUT.test(f.src));

  it('the matcher sees both spellings of a fan-out (fixture control)', () => {
    expect(FAN_OUT.test('fetch(`${baseUrl}/api/cron/renewals/x/${t}`)')).toBe(true);
    expect(FAN_OUT.test('fetch(`${env.app.baseUrl}/api/cron/renewals/x/${t}`)')).toBe(true);
    expect(FAN_OUT.test('fetch(`${baseUrl}/api/members`)')).toBe(false);
  });

  it('finds the fan-out routes (positive control)', () => {
    expect(fanOut.length).toBeGreaterThanOrEqual(MIN_FAN_OUT);
  });

  it('every fan-out route calls refuseCrossOriginFanOut before its first fetch', () => {
    const missing = fanOut
      .filter(({ src }) => {
        const guard = src.indexOf('refuseCrossOriginFanOut(');
        const firstFetch = src.search(FAN_OUT);
        return guard === -1 || guard > firstFetch;
      })
      .map(({ p }) => p.slice(ROOT.length + 1));
    expect(missing).toEqual([]);
  });
});
