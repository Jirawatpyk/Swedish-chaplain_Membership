/**
 * Spec 122 US1 (whole-branch review) — the server staff layout reads the rail
 * cookie by name. That name must come from a plain module: imported from a
 * `'use client'` file, a server component receives a client REFERENCE, not the
 * string, so `cookies().get(...)` never finds `sidebar_state` and a collapsed
 * rail re-expands on every hard load.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '');

describe('admin layout — rail cookie name', () => {
  it('comes from a module the server can read as a value (no "use client")', () => {
    const layout = read('src/app/(staff)/admin/layout.tsx');
    const from = layout.match(/import \{[^}]*\bSIDEBAR_COOKIE\b[^}]*\} from '@\/([^']+)'/)?.[1];
    expect(from, 'the layout imports SIDEBAR_COOKIE').toBeDefined();
    const source = [`src/${from}.ts`, `src/${from}.tsx`]
      .map((rel) => {
        try {
          return read(rel);
        } catch {
          return null;
        }
      })
      .find((s) => s !== null);
    expect(source, `src/${from} exists`).toBeTruthy();
    expect(source!.trimStart().startsWith("'use client'")).toBe(false);
    expect(source).toMatch(/export const SIDEBAR_COOKIE = 'sidebar_state'/);
  });
});
