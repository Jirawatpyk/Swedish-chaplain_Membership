/**
 * PR O — the public unsubscribe page and its error boundary are on AURA: a
 * `Card` (from `/server` on the server page), AURA's button / link classes
 * and fg tokens, and none of the legacy shadcn tokens the pages were built on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LEGACY = [
  'bg-card',
  'border-border',
  'text-muted-foreground',
  'text-foreground',
  'bg-primary',
  'text-primary-foreground',
  'focus:ring-ring',
  'focus-visible:ring-ring',
  'hover:bg-accent',
  'text-green-600',
  'text-yellow-600',
];

describe.each([
  ['src/app/unsubscribe/[token]/page.tsx', "@jirawatpyk/aura-react/server"],
  ['src/app/unsubscribe/[token]/error.tsx', "@jirawatpyk/aura-react"],
])('%s', (file, entry) => {
  const src = readFileSync(file, 'utf8');

  it(`builds its card from AURA (${entry})`, () => {
    expect(src).toMatch(new RegExp(`import \\{[^}]*\\bCard\\b[^}]*\\} from '${entry.replace('/', '\\/')}'`));
    expect(src).not.toMatch(/<article\b/);
  });

  it.each(LEGACY)('uses no legacy token %s', (token) => {
    expect(src).not.toContain(token);
  });
});
