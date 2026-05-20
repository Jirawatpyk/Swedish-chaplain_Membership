/**
 * T116 (F7.1a US7) — Tiptap extension that visually styles
 * `[bracketed text]` placeholders in the broadcast body editor.
 *
 * Per critique P4 + FR-019: members starting a draft from a template
 * see `[event name]`, `[date]`, `[member name]` etc. as visual
 * placeholders (grey background + dashed border) so they instantly
 * know where to type their own content. The bracket characters are
 * NOT a special syntax — they ship verbatim in the dispatched
 * broadcast body if the member doesn't replace them.
 *
 * Implementation: ProseMirror plugin that scans text nodes for the
 * `\[[^\]\n]+\]` regex pattern and adds a `Decoration.inline` with
 * the CSS class `bracket-placeholder`. The visual styling lives in
 * `src/app/globals.css` so it's available to every Tiptap editor
 * surface (member compose + admin template form).
 *
 * No state — re-derives decorations from the document on every
 * transaction (cheap for the ≤200 KB body cap).
 *
 * Pure Tiptap extension — no React imports.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const PLUGIN_KEY = new PluginKey('bracketPlaceholder');
const BRACKET_RE = /\[[^\]\n]+\]/g;

export const broadcastBracketPlaceholderExtension = Extension.create({
  name: 'bracketPlaceholder',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: PLUGIN_KEY,
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (!node.isText || node.text === undefined) return;
              const text = node.text;
              // Reset regex state — global regexes are stateful between
              // exec() calls and would skip matches across nodes if
              // shared. Local re-init avoids that footgun.
              const re = new RegExp(BRACKET_RE.source, BRACKET_RE.flags);
              let match: RegExpExecArray | null;
              while ((match = re.exec(text)) !== null) {
                const start = pos + match.index;
                const end = start + match[0].length;
                decorations.push(
                  Decoration.inline(start, end, {
                    class: 'bracket-placeholder',
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
