/**
 * The mouse wheel over a table scrolls the page (maintainer, 19 Oct 2026).
 * AURA 5.51 (#163) contains only the sideways axis of `.aura-table__scroll`,
 * so the app's stand-in override is gone and AURA's own rule holds.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');
const aura = readFileSync(join(process.cwd(), 'node_modules/@jirawatpyk/aura-react/dist/styles.css'), 'utf8');

describe('the wheel over a DataTable scrolls the page', () => {
  it('AURA contains only the sideways axis of the table box (#163)', () => {
    const at = aura.indexOf('.aura-table__scroll {');
    const rule = aura.slice(at, aura.indexOf('}', at));
    expect(rule).toMatch(/overscroll-behavior-x:\s*contain/);
    expect(rule).not.toMatch(/overscroll-behavior:\s*contain/);
  });

  it('the app no longer overrides it (stand-in removed)', () => {
    expect(css).not.toMatch(/\.aura-table__scroll\s*\{/);
  });
});
