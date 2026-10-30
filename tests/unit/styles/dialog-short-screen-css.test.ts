/**
 * Stand-in until AURA #194 (handoff addendum 95, found in PR N2): AURA's
 * Dialog scrolls only its body, with the head, description and footer
 * `flex: none`, so on a screen 480px tall or less (400% zoom; landscape
 * with the keyboard open) the body can shrink to nothing and its fields
 * can't be reached (WCAG 1.4.10). There the whole panel scrolls as one box.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\r/g, '');

function shortScreenBlock(): string {
  const at = css.indexOf('@media (max-height: 30rem)');
  if (at < 0) return '';
  // The media block up to its closing brace at the start of a line.
  const end = css.indexOf('\n  }', at);
  return css.slice(at, end < 0 ? undefined : end);
}

describe('Dialog on a very short screen (stand-in until AURA #194)', () => {
  it('is labelled with the open AURA item', () => {
    expect(css).toContain('stand-in until AURA #194');
  });

  it('under 30rem tall, the panel scrolls and the body no longer shrinks', () => {
    const block = shortScreenBlock();
    expect(block).toMatch(/\.aura-dialog\s*\{[^}]*overflow-y:\s*auto/);
    expect(block).toMatch(/\.aura-dialog__body\s*\{[^}]*flex:\s*none[^}]*min-height:\s*auto[^}]*overflow:\s*visible/);
  });
});
