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
 *   - Paste handler runs `isomorphic-dompurify` on pasted HTML and emits
 *     a `sanitiser-strip-warn` toast when the sanitiser strips content
 *     (R2-NEW-2; signals user that some formatting was removed)
 *   - ARIA-live region announces editor state changes (CHK029)
 */
import { useCallback, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import DOMPurify from 'isomorphic-dompurify';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { TiptapToolbar, type AnnounceKey } from './tiptap-toolbar';

const SANITIZER_CONFIG = Object.freeze({
  ALLOWED_TAGS: [
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
  ],
  ALLOWED_ATTR: ['href'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  FORBID_TAGS: [
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
    'img',
  ],
  FORBID_ATTR: ['style'],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
});

export interface TiptapEditorProps {
  readonly initialHtml: string;
  readonly onChange: (html: string) => void;
  readonly disabled?: boolean;
  /** id of the visible <Label> for the editor — wires aria-labelledby on the editable region. */
  readonly labelledById?: string;
}

export default function TiptapEditor({
  initialHtml,
  onChange,
  disabled = false,
  labelledById,
}: TiptapEditorProps): React.ReactElement {
  const tEditor = useTranslations('portal.broadcasts.compose.editor');
  const tToast = useTranslations('portal.broadcasts.compose.toast');
  const [announcement, setAnnouncement] = useState<string>('');
  const lastSanitiseWarnAt = useRef<number>(0);

  const editor = useEditor({
    extensions: [StarterKit],
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
        const sanitised = DOMPurify.sanitize(html, SANITIZER_CONFIG) as string;
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

  if (!editor) {
    return <div className="min-h-[280px] rounded-md border bg-muted/40" />;
  }

  return (
    <div
      className="rounded-md border focus-within:ring-2 focus-within:ring-ring"
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
  );
}
