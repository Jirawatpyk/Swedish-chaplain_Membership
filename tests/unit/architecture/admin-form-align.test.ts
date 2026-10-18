/**
 * Spec 122 (maintainer, 18 Oct 2026) — every staff form page sits at the
 * content's start edge, not centred: `<FormContainer align="start">`, as the
 * plan, invoice and account forms already did. Member portal forms stay
 * centred (they are not scanned).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const STAFF = join(ROOT, 'src/app/(staff)');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

/** Every `<FormContainer …>` opening tag, comments excluded. */
function openingTags(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return code.match(/<FormContainer(?=[\s>])[^>]*>/g) ?? [];
}

describe('staff form pages align to the start edge', () => {
  const files = walk(STAFF);
  const tags = files.flatMap((file) =>
    openingTags(readFileSync(file, 'utf8')).map((tag) => ({ file: relative(ROOT, file), tag })),
  );

  it('positive control: the scan finds staff form containers', () => {
    expect(tags.length).toBeGreaterThan(20);
  });

  it('every FormContainer under (staff) passes align="start"', () => {
    const centred = tags.filter(({ tag }) => !/\balign="start"/.test(tag)).map(({ file }) => file);
    expect(centred).toEqual([]);
  });
});
