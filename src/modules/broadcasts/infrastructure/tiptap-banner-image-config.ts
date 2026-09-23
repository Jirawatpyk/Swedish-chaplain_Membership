/**
 * F119 T102 (FR-041) — the `bannerImage` design block as a Tiptap node.
 *
 * Serialised shape:  `<img data-eb="banner" src="…" alt="…">`
 *
 * A block-level atom, placeable anywhere in the body and rendered at the full
 * 600 px email width by the renderer that reads the marker. The author
 * supplies the uploaded `src` and the `alt` collected by the alt-text dialog
 * (FR-040) and nothing else — width, alignment and spacing belong to the
 * platform, and the shared sanitiser allows no other attribute on `<img>`
 * anyway.
 *
 * `priority: 100` on the parse rule (ProseMirror's default is 50) because the
 * inline-image extension also claims `img[src]`; without it a saved banner
 * would come back as an ordinary inline image and the block would be lost on
 * the next save.
 *
 * The node is registered ONLY when the image flag is on — see
 * `makeBroadcastEditorExtensions`. With images off the shared policy forbids
 * `<img>` outright, so a banner must be impossible there too.
 */
import { Node, mergeAttributes } from '@tiptap/core';
// Same shared policy the sanitiser reads — see the CTA config for why this is
// never a literal.
import { DESIGN_BLOCK_ATTR } from '@/lib/broadcast-content-policy';

export interface BannerImageAttributes {
  readonly src: string;
  readonly alt: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    broadcastBannerImage: {
      /** Insert a full-width banner. The description is required upstream (FR-040). */
      setBannerImage: (attributes: BannerImageAttributes) => ReturnType;
    };
  }
}

export const broadcastBannerImageExtension = Node.create({
  name: 'bannerImage',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('src'),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes['src'] === 'string' ? { src: attributes['src'] } : {},
      },
      alt: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('alt'),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes['alt'] === 'string' ? { alt: attributes['alt'] } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `img[${DESIGN_BLOCK_ATTR}="banner"]`, priority: 100 }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes({ [DESIGN_BLOCK_ATTR]: 'banner' }, HTMLAttributes)];
  },

  addCommands() {
    return {
      setBannerImage:
        (attributes: BannerImageAttributes) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { ...attributes } }),
    };
  },
});
