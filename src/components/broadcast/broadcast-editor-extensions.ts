/**
 * F119 T088/T098/T102 (FR-038, SC-011) — the ONE Tiptap extension set the
 * E-Blast writing tool runs with, on every surface that uses it (member
 * compose, staff compose-on-behalf, the template screens — FR-039).
 *
 * It lives beside the editor rather than inside it so the guarantee below can
 * be asserted headlessly, without mounting React:
 *
 *   **Nothing typeable can produce a node the platform later removes.**
 *
 * An input rule can only build a node the SCHEMA has, so the rule is enforced
 * by what is registered, not by intercepting keystrokes:
 *
 *   - `heading: { levels: [2, 3] }` — the subject is the email's title, so H1
 *     is never offered AND `# ` matches no input rule (FR-038). `<h1>` in a
 *     paste falls back to a paragraph.
 *   - `code: false`, `codeBlock: false`, `strike: false` — the shared
 *     sanitiser (`src/lib/broadcast-content-policy.ts`) keeps none of
 *     `<code>`, `<pre>` or `<s>`, so " ``` " and "~~strike~~" must not be able
 *     to make them in the first place.
 *   - `italic` STAYS registered even though the control is hidden under `th`
 *     (FR-044): hiding a control is presentational, removing the mark would
 *     silently drop `<em>` a member pasted or a template carried.
 *
 * The image node and the banner block are registered only when the image flag
 * is on, mirroring `makeBroadcastSanitizerConfig({ images })`, which forbids
 * `<img>` outright while it is off.
 */
import type { Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
// Through the `src/lib` composition layer, never `@/modules/broadcasts` (whose
// barrel would pull Drizzle into the browser bundle) and never a deep import
// from a component — see `src/lib/broadcast-editor-extensions.ts`.
import {
  broadcastBannerImageExtension,
  broadcastBracketPlaceholderExtension,
  broadcastCtaButtonExtension,
  broadcastImageExtension,
} from '@/lib/broadcast-editor-extensions';
import { DESIGN_BLOCK_ATTR } from '@/lib/broadcast-content-policy';

/**
 * Spec 122 US12d-2 round 2 (#6) — in the editor the button block is ONE unit:
 * its words are drawn, not typeable, so they change only through the button
 * dialog and its 1–60 bound (typing in place let an author empty the button or
 * run it past 60 characters and learn only at submit). The schema's
 * `renderHTML` is untouched, so the saved HTML is byte-identical to the
 * server's node (asserted in `editor-blocks-edit.test.tsx`).
 */
const ctaButtonAsUnit = broadcastCtaButtonExtension.extend({
  atom: true,
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('a');
      dom.setAttribute(DESIGN_BLOCK_ATTR, 'cta');
      const href: unknown = node.attrs['href'];
      if (typeof href === 'string') dom.setAttribute('href', href);
      dom.setAttribute('contenteditable', 'false');
      dom.textContent = node.textContent;
      return { dom };
    };
  },
});

export function makeBroadcastEditorExtensions(opts: {
  readonly images: boolean;
}): Extensions {
  const base: Extensions = [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      code: false,
      codeBlock: false,
      strike: false,
      // A click in a link places the caret (and selects the link) instead of
      // opening the page in a new tab, so an author can edit or remove it
      // (spec 122 US12d-2 round 2). The exported HTML is unchanged.
      link: { openOnClick: false, enableClickSelection: true },
    }),
    // [bracketed text] decoration is style-only — no schema mutation, so it is
    // always on (admins author placeholders in templates; members replace them).
    broadcastBracketPlaceholderExtension,
    ctaButtonAsUnit,
  ];
  return opts.images
    ? [...base, broadcastImageExtension, broadcastBannerImageExtension]
    : base;
}
