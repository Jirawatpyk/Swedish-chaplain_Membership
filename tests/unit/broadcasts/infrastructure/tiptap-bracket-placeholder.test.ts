/**
 * Phase 5 Round 1 R2.1 H-test-3 — Unit tests for the ProseMirror
 * `broadcastBracketPlaceholderExtension` (T116).
 *
 * Verifies the decoration plugin via a headless Tiptap editor: we
 * mount the extension with StarterKit, set HTML content, and inspect
 * the ProseMirror plugin's `props.decorations(state)` output for the
 * decoration count + positions.
 *
 * Cases:
 *   1. Two bracket placeholders on a single text node → 2 decorations
 *      at the correct char offsets.
 *   2. Newline-spanning bracket (`[a\nb]`) → 0 decorations (the regex
 *      rejects `\n` inside brackets).
 *   3. Empty document → 0 decorations.
 *   4. Bracket-like text without closing `]` → 0 decorations.
 */
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import type { DecorationSet } from '@tiptap/pm/view';
import { broadcastBracketPlaceholderExtension } from '@/modules/broadcasts/infrastructure/tiptap-bracket-placeholder-config';

interface DecorationRange {
  from: number;
  to: number;
}

/**
 * Spin up a headless Editor + StarterKit + the extension under test,
 * load HTML, then ask the plugin for its current DecorationSet and
 * flatten to {from,to} ranges.
 *
 * Tiptap's headless mode requires no DOM (`element: undefined`).
 */
function decorationsFor(html: string): DecorationRange[] {
  const editor = new Editor({
    extensions: [StarterKit, broadcastBracketPlaceholderExtension],
    content: html,
  });
  // R3.6 L-3 — try/finally ensures editor.destroy() runs even on
  // exception (was bare destroy after return; future malformed-HTML
  // tests would leak jsdom state on throw).
  try {
    const state = editor.state;
    // Each plugin's `decorations` prop is queried by ProseMirror at
    // render time. Call EVERY plugin's decorations() (if defined) and
    // collect those that target our `bracket-placeholder` class. This
    // sidesteps PluginKey identity comparisons (Tiptap re-wraps the
    // key internally) and keeps the test future-proof against StarterKit
    // re-ordering its own plugins.
    const ranges: DecorationRange[] = [];
    for (const plugin of state.plugins) {
      const decFn = plugin.spec.props?.decorations as
        | ((s: typeof state) => DecorationSet | null | undefined)
        | undefined;
      if (!decFn) continue;
      const set = decFn(state);
      if (!set) continue;
      for (const d of set.find()) {
        // Decoration carries a `type` with `spec` for inline decorations.
        // Inline decorations made with Decoration.inline({class: '...'})
        // expose the class via `spec.class` (ProseMirror internal shape).
        const type = (d as unknown as {
          type: { attrs?: { class?: string }; spec?: { class?: string } };
        }).type;
        const cls = type.attrs?.class ?? type.spec?.class;
        if (cls === 'bracket-placeholder') {
          ranges.push({ from: d.from, to: d.to });
        }
      }
    }
    return ranges;
  } finally {
    editor.destroy();
  }
}

describe('broadcastBracketPlaceholderExtension — R2.1 H-test-3', () => {
  it('two single-line brackets → 2 decorations with monotonic offsets', () => {
    const decorations = decorationsFor(
      '<p>Hello [member name], the event [event name] is here.</p>',
    );
    expect(decorations).toHaveLength(2);
    const [first, second] = decorations;
    if (first === undefined || second === undefined) {
      throw new Error('precondition: decorations[0] + [1] defined');
    }
    // Decoration positions don't need to assert ABSOLUTE values (those
    // are ProseMirror schema-dependent); assert ordering + range shape.
    expect(first.from).toBeLessThan(first.to);
    expect(second.from).toBeLessThan(second.to);
    expect(first.to).toBeLessThan(second.from);
    // First placeholder covers exactly `[member name]` (13 chars)
    expect(first.to - first.from).toBe(13);
    // Second placeholder covers exactly `[event name]` (12 chars)
    expect(second.to - second.from).toBe(12);
  });

  it('newline-spanning bracket → 0 decorations (regex excludes \\n)', () => {
    // Multi-paragraph: bracket starts in paragraph 1 + closes in paragraph 2.
    // ProseMirror splits text nodes across paragraphs so the regex never
    // sees both halves in a single text node.
    const decorations = decorationsFor(
      '<p>Hello [open</p><p>close] world</p>',
    );
    expect(decorations).toHaveLength(0);
  });

  it('empty document → 0 decorations', () => {
    const decorations = decorationsFor('<p></p>');
    expect(decorations).toHaveLength(0);
  });

  it('bracket-like text without closing ] → 0 decorations', () => {
    const decorations = decorationsFor('<p>Hello [unclosed</p>');
    expect(decorations).toHaveLength(0);
  });

  it('text with no brackets → 0 decorations', () => {
    // Documents the negative case — plain prose without `[` anywhere
    // produces zero decorations even with surrounding markup.
    const decorations = decorationsFor(
      '<p>Hello world, this is a plain message.</p>',
    );
    expect(decorations).toHaveLength(0);
  });
});
