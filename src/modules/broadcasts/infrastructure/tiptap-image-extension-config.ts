/**
 * T073 (F7.1a US2) — Tiptap `<img>` extension config for the F7.1a
 * compose surface. Imported by the F7 MVP Tiptap editor wiring in
 * `src/app/(member)/portal/broadcasts/new/page.tsx` (T078).
 *
 * Configuration (FR-009 / FR-010 / FR-014):
 *   - inline: false      — `<img>` is a block-level node (matches the
 *                          sanitiser tag semantics; no inline wrapping
 *                          weirdness in the editor)
 *   - allowBase64: false — REJECT data: URIs from paste/drop. Inline
 *                          uploads go through `uploadInlineImage`
 *                          (POST /api/member/broadcasts/inline-image-
 *                          upload) which returns a Vercel Blob URL
 *                          the editor then inserts via setImage()
 *   - HTMLAttributes:
 *       loading="lazy"   — Modern mail clients respect; reduces inbox
 *                          render bandwidth for long broadcasts
 *
 * The extension itself does NOT enforce the source allowlist — that's
 * the server-side `validateImageSourceAllowlist` use-case (T070).
 * Client-side enforcement would only catch friendly paste; an attacker
 * can always edit the HTML in DevTools.
 */
import Image from '@tiptap/extension-image';

export const broadcastImageExtension = Image.configure({
  inline: false,
  allowBase64: false,
  HTMLAttributes: {
    loading: 'lazy',
  },
});
