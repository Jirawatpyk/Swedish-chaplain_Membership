'use client';

/**
 * T082 — Tiptap rich-text editor for F7 broadcast compose surface.
 *
 * Browser-only — MUST be loaded via `loadTiptapEditor()` from
 * `@/components/ui/tiptap-loader` so SSR is disabled.
 *
 * Configuration:
 *   - `StarterKit` is loaded as-is (Image extension is NOT registered
 *     by default in StarterKit ≥ 3.x, so no explicit disable required —
 *     verified against package.json @tiptap/starter-kit@3.22.5).
 *   - F7.1a US2 (T078): when `imagesEnabled` is true, the
 *     `broadcastImageExtension` (T073) is registered and the paste
 *     sanitiser permits `<img src,alt>` for http(s) only — mirroring
 *     the server DOMPurify policy. The inline-image uploader +
 *     ClamAV-unreachable banner render inside the editor wrapper
 *     when enabled.
 *   - Paste handler runs `isomorphic-dompurify` on pasted HTML and emits
 *     a `sanitiser-strip-warn` toast when the sanitiser strips content
 *     (R2-NEW-2; signals user that some formatting was removed)
 *   - ARIA-live region announces editor state changes (CHK029)
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import DOMPurify from 'isomorphic-dompurify';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { TiptapToolbar, type AnnounceKey } from './tiptap-toolbar';
import { broadcastImageExtension } from '@/modules/broadcasts/infrastructure/tiptap-image-extension-config';
import { ComposeInlineImageUploader } from './compose-inline-image-uploader';
import { ClamavUnreachableBanner } from './clamav-unreachable-banner';

const SANITIZER_BASE_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'hr',
];

const SANITIZER_FORBID_BASE = [
  'script',
  'style',
  'iframe',
  'form',
  'link',
  'meta',
  'base',
  'object',
  'embed',
  'svg',
];

/**
 * Two frozen paste-sanitiser configs — the editor picks one at mount
 * time based on `imagesEnabled`. The paste sanitiser MUST mirror the
 * server-side DOMPurify policy (`dompurify-sanitizer.ts`) so users
 * don't see content survive paste only to be stripped at submit.
 */
function makeSanitizerConfig(imagesEnabled: boolean): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ALLOWED_TAGS: imagesEnabled
      ? [...SANITIZER_BASE_TAGS, 'img']
      : [...SANITIZER_BASE_TAGS],
    ALLOWED_ATTR: imagesEnabled
      ? ['href', 'src', 'alt']
      : ['href'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
    FORBID_TAGS: imagesEnabled
      ? [...SANITIZER_FORBID_BASE]
      : [...SANITIZER_FORBID_BASE, 'img'],
    FORBID_ATTR: ['style'],
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });
}

export interface TiptapEditorProps {
  readonly initialHtml: string;
  readonly onChange: (html: string) => void;
  readonly disabled?: boolean;
  /** id of the visible <Label> for the editor — wires aria-labelledby on the editable region. */
  readonly labelledById?: string;
  /**
   * F7.1a US2 (T078) — when true, registers `broadcastImageExtension`,
   * relaxes the paste sanitiser to allow `<img src,alt>`, and renders
   * the inline-image uploader + ClamAV-unreachable banner. Wired from
   * the server page via `isF71aUs2Enabled()` so the toolbar surface
   * only appears when the kill-switch is fully ON.
   */
  readonly imagesEnabled?: boolean;
  /**
   * Required to upload inline images (the API ties uploads to a draft
   * for ownership + retention scope). When null and `imagesEnabled` is
   * true, the uploader renders in a disabled state with a "save draft
   * first" hint so the member knows what to do.
   */
  readonly draftId?: string | null;
}

export default function TiptapEditor({
  initialHtml,
  onChange,
  disabled = false,
  labelledById,
  imagesEnabled = false,
  draftId = null,
}: TiptapEditorProps): React.ReactElement {
  const tEditor = useTranslations('portal.broadcasts.compose.editor');
  const tToast = useTranslations('portal.broadcasts.compose.toast');
  const tImage = useTranslations('portal.broadcasts.compose.imageUpload');
  const [announcement, setAnnouncement] = useState<string>('');
  const lastSanitiseWarnAt = useRef<number>(0);

  const sanitizerConfig = useMemo(
    () => makeSanitizerConfig(imagesEnabled),
    [imagesEnabled],
  );
  const extensions = useMemo(
    () =>
      imagesEnabled ? [StarterKit, broadcastImageExtension] : [StarterKit],
    [imagesEnabled],
  );

  const editor = useEditor({
    extensions,
    content: initialHtml,
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'prose prose-sm dark:prose-invert max-w-none min-h-[240px] px-3 py-2 focus:outline-none',
        role: 'textbox',
        'aria-multiline': 'true',
        ...(labelledById !== undefined && { 'aria-labelledby': labelledById }),
      },
      transformPastedHTML(html: string): string {
        const sanitised = DOMPurify.sanitize(html, sanitizerConfig) as string;
        if (sanitised !== html) {
          const now = Date.now();
          if (now - lastSanitiseWarnAt.current > 1500) {
            lastSanitiseWarnAt.current = now;
            toast.warning(tToast('sanitiserStripped'));
          }
        }
        return sanitised;
      },
    },
    onUpdate({ editor: ed }) {
      onChange(ed.getHTML());
    },
  });

  const announceState = useCallback(
    (key: AnnounceKey) => {
      setAnnouncement(tEditor(`announcements.${key}`));
      window.setTimeout(() => setAnnouncement(''), 1500);
    },
    [tEditor],
  );

  const handleUploaded = useCallback(
    (blobUrl: string): void => {
      if (!editor) return;
      // Tiptap's image extension `setImage` chain command inserts an
      // <img src=blobUrl> at the current cursor position. The server-
      // side sanitiser will preserve it (http(s) blob URL); the
      // `validateImageSourceAllowlist` use-case enforces tenant
      // hostname allowlist at submit time. The Vercel Blob default-
      // seed hostname is already in the allowlist (T072 seedDefaults).
      editor.chain().focus().setImage({ src: blobUrl }).run();
    },
    [editor],
  );

  if (!editor) {
    return <div className="min-h-[280px] rounded-md border bg-muted/40" />;
  }

  return (
    <div className="space-y-2">
      {imagesEnabled && <ClamavUnreachableBanner />}
      <div
        className="rounded-md border focus-within:ring-2 focus-within:ring-ring min-w-0 overflow-hidden"
        data-testid="tiptap-editor"
      >
        <TiptapToolbar editor={editor} onAnnounce={announceState} />
        <EditorContent editor={editor} />
        <span
          role="status"
          aria-live="polite"
          className="sr-only"
          data-testid="tiptap-aria-live"
        >
          {announcement}
        </span>
      </div>
      {imagesEnabled && (
        <div className="flex flex-col gap-1">
          {draftId !== null ? (
            <ComposeInlineImageUploader
              draftId={draftId}
              onUploaded={handleUploaded}
            />
          ) : (
            <p className="text-caption text-muted-foreground">
              {tImage('draftRequiredHint')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
