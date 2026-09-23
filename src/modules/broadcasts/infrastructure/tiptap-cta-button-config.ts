/**
 * F119 T102 (FR-041) — the `ctaButton` design block as a Tiptap node.
 *
 * Serialised shape:  `<a data-eb="cta" href="…">text</a>`
 *
 * That is an ordinary allow-listed anchor carrying the ONE marker attribute
 * the shared sanitiser keeps (`data-eb`, see `src/lib/broadcast-content-policy.ts`),
 * so the block survives every sanitise pass unchanged and the email renderer
 * finds it again through `findBlockMarkers` in the Domain. No new package: the
 * node is built on `@tiptap/core`, which the editor already depends on.
 *
 * The author supplies the href and the text and nothing else — the button's
 * colour, font and spacing come from the platform and the chamber's brand
 * settings (FR-041/FR-041c). `marks: ''` is what enforces that inside the
 * node: bold/italic/underline cannot be applied to the label, so a member
 * cannot style the button by way of its text.
 *
 * The parse rule is `priority: 100` (ProseMirror's default is 50) because
 * StarterKit's Link mark also claims `a[href]`. Without the bump a saved body
 * would parse a CTA back as a plain link with a stray `data-eb`, and the next
 * save would lose the block.
 */
import { Node, mergeAttributes } from '@tiptap/core';
// The marker attribute name comes from the ONE shared content policy, never a
// literal: the sanitiser's allow-list and this selector have to name the same
// attribute or the block is stripped on its way to the email.
import { DESIGN_BLOCK_ATTR } from '@/lib/broadcast-content-policy';

export interface CtaButtonAttributes {
  readonly href: string;
  readonly text: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    broadcastCtaButton: {
      /** Insert a CTA button at the cursor. Bounds are enforced by the dialog + Domain `validateBlocks`. */
      setCtaButton: (attributes: CtaButtonAttributes) => ReturnType;
    };
  }
}

export const broadcastCtaButtonExtension = Node.create({
  name: 'ctaButton',
  group: 'inline',
  inline: true,
  content: 'text*',
  marks: '',
  selectable: true,

  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('href'),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes['href'] === 'string' ? { href: attributes['href'] } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `a[${DESIGN_BLOCK_ATTR}="cta"]`, priority: 100 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes({ [DESIGN_BLOCK_ATTR]: 'cta' }, HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setCtaButton:
        (attributes: CtaButtonAttributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { href: attributes.href },
            content: [{ type: 'text', text: attributes.text }],
          }),
    };
  },
});
