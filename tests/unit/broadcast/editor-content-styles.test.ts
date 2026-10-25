/**
 * Spec 122 US12d-2 — the E-Blast editor draws its content: H2 and H3 look
 * like headings, lists carry bullets and numbers, a quote and a divider show,
 * and the button and banner blocks look like what the email will send.
 *
 * Before this the editable area carried `prose prose-sm dark:prose-invert`,
 * but `@tailwindcss/typography` was never installed, so those classes did
 * nothing and Tailwind's preflight left every construct as plain text. The
 * styles are the app's own (AURA tokens, no new dependency), scoped to
 * `.eblast-editor-content` in `globals.css`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../..');
const css = readFileSync(join(root, 'src/app/globals.css'), 'utf8').replace(/\r/g, '');
const editor = readFileSync(join(root, 'src/components/broadcast/tiptap-editor.tsx'), 'utf8');

/** The declarations of the first rule whose selector list names `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|[,}\\s])${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'm').exec(css);
  return match?.[1] ?? '';
}

describe('the E-Blast editor styles its own content', () => {
  it('the editable area uses the app class, not the uninstalled typography plugin', () => {
    expect(editor).toContain('eblast-editor-content');
    expect(editor).not.toMatch(/\bprose\b/);
  });

  it.each([
    ['.eblast-editor-content h2', /font-size/],
    ['.eblast-editor-content h3', /font-size/],
    ['.eblast-editor-content ul', /list-style:\s*disc/],
    ['.eblast-editor-content ol', /list-style:\s*decimal/],
    ['.eblast-editor-content blockquote', /border-left/],
    ['.eblast-editor-content hr', /border-top/],
    ['.eblast-editor-content a', /text-decoration:\s*underline/],
    ['.eblast-editor-content a[data-eb="cta"]', /background/],
    ['.eblast-editor-content img[data-eb="banner"]', /width:\s*100%/],
  ])('%s is styled', (selector, declaration) => {
    expect(rule(selector)).toMatch(declaration);
  });
});
