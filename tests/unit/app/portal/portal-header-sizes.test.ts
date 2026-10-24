/**
 * Spec 122 US12d-1 (the user, 24 Oct) — one page-header size across the
 * member portal: only the Dashboard (the welcome page) and the centred
 * renewal-success card keep the larger `hero` header. Every other portal page
 * takes the ordinary header, so the title sits the same distance down.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HERO_ALLOWED = [
  'src/app/(member)/portal/(home)/page.tsx',
  'src/app/(member)/portal/renewal/[memberId]/success/page.tsx',
  'src/app/(member)/portal/renewal/[memberId]/success/loading.tsx',
];

// Forward slashes on every checkout (Windows returns backslashes).
const ROOT = 'src/app/(member)/portal';
const files = readdirSync(ROOT, { recursive: true, encoding: 'utf8' })
  .filter((f) => f.endsWith('.tsx'))
  .map((f) => `${ROOT}/${f.replace(/\\/g, '/')}`);
const heroFiles = files.filter((f) => /size=["']hero(-lg)?["']/.test(readFileSync(f, 'utf8')));

describe('portal page-header sizes', () => {
  it('scans the portal (positive control: the Dashboard carries the hero)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(heroFiles).toContain('src/app/(member)/portal/(home)/page.tsx');
  });

  it('only the Dashboard and the renewal-success card use the hero header', () => {
    expect(heroFiles.filter((f) => !HERO_ALLOWED.includes(f))).toEqual([]);
  });
});
