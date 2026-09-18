/**
 * F119 T007 — the inputs behind the byte-identical wrapper baseline.
 *
 * Shared by the baseline test (which compares against the committed
 * fixtures) so the fixture inputs and the assertion inputs cannot drift
 * apart. Every case is the "no brand, no blocks" shape: no logo on file, no
 * brand colour, no postal address, no `data-eb` marker in the body — the
 * exact email every live SweCham send produced on 2026-09-18.
 */
import { join } from 'node:path';
import type { RenderBroadcastHtmlInput } from '@/modules/broadcasts/infrastructure/resend/email-template';

export const FIXTURE_DIR = join(__dirname, '__fixtures__', 'render-broadcast-html-baseline');

export interface BaselineCase {
  readonly name: string;
  readonly input: RenderBroadcastHtmlInput;
}

// Subject and tenant name carry every character `escapeHtml` touches; the
// body carries one of each construct the F7 sanitiser keeps today
// (paragraph, strong, em, link with target/rel, list, heading, blockquote,
// hr, image) so a wrapper change that touches the body cell is caught too.
const BODY_HTML =
  '<h2>Quarterly update</h2>' +
  '<p>Hello <strong>members</strong> &amp; <em>friends</em> — see <a href="https://example.org/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">the agenda</a>.</p>' +
  '<ul><li>One</li><li>Two</li></ul>' +
  '<ol><li>First</li></ol>' +
  '<blockquote>Quoted line</blockquote>' +
  '<hr>' +
  '<p><img src="https://cdn.example.org/pic.png" alt="A picture"></p>' +
  '<p><u>Underlined</u> and a line<br>break.</p>';

export const BASELINE_CASES: readonly BaselineCase[] = (['en', 'th', 'sv'] as const).map(
  (locale) => ({
    name: `no-brand-no-blocks-${locale}`,
    input: {
      subject: `Q3 news & <"quotes"> 'apostrophe'`,
      bodyHtml: BODY_HTML,
      tenantDisplayName: `Thai-Swedish Chamber & Co <TSCC>`,
      locale,
    },
  }),
);
