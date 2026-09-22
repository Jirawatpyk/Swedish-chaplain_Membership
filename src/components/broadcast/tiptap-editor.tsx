'use client';

/**
 * T082 — Tiptap rich-text editor for F7 broadcast compose surface.
 *
 * Browser-only — MUST be loaded via `loadTiptapEditor()` from
 * `@/components/ui/tiptap-loader` so SSR is disabled.
 *
 * Configuration:
 *   - Extensions come from the ONE shared factory
 *     (`broadcast-editor-extensions.ts`, F119 T088/T098/T102): H2/H3 only, no
 *     code / codeBlock / strike, plus the CTA and banner design-block nodes.
 *     Nothing typeable can produce a node the sanitiser later removes.
 *   - F7.1a US2 (T078): when `imagesEnabled` is true, the
 *     `broadcastImageExtension` (T073) and the banner node are registered and
 *     the paste sanitiser permits `<img src,alt>` for http(s) only — mirroring
 *     the server DOMPurify policy. The inline-image uploader +
 *     ClamAV-unreachable banner render inside the editor wrapper when enabled.
 *   - F119 T099 (FR-040): an image — inline or banner — is inserted only once
 *     a 1–125-character description has been collected by `ImageAltDialog`.
 *   - F119 T101 (FR-038): the paste handler drops unsupported content and
 *     tells the author ONCE per mounted editor, in a non-blocking toast.
 *   - ARIA-live region announces editor state changes (CHK029)
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Info } from 'lucide-react';
import {
  IMAGE_DISABLED_HINT_ID,
  TiptapToolbar,
  type AnnounceKey,
} from './tiptap-toolbar';
import { makeBroadcastEditorExtensions } from './broadcast-editor-extensions';
import { makeBroadcastPasteTransform } from './broadcast-paste-transform';
import { ImageAltDialog, type ImageAltVariant } from './image-alt-dialog';
import {
  ComposeInlineImageUploader,
  type ComposeInlineImageUploaderHandle,
} from './compose-inline-image-uploader';
import { ClamavUnreachableBanner } from './clamav-unreachable-banner';

// F119 T013/T014 — the paste sanitiser reads the ONE shared policy
// (`src/lib/broadcast-content-policy.ts`, SC-011) so a paste can never keep
// content the server later strips, nor strip content the server keeps. The
// editor narrows to `images: false` while the F7.1a US2 flag is off.

/**
 * An image in flight. It carries whichever half arrived first — the
 * description (toolbar path) or the uploaded URL (uploader-button path) — and
 * the node is inserted only once both are present (FR-040).
 */
interface PendingImage {
  readonly kind: ImageAltVariant;
  readonly alt?: string;
  readonly src?: string;
}

export interface TiptapEditorProps {
  readonly initialHtml: string;
  readonly onChange: (html: string) => void;
  readonly disabled?: boolean;
  /** id of the visible <Label> for the editor — wires aria-labelledby on the editable region. */
  readonly labelledById?: string;
  /**
   * R3.5 M-13 — id(s) of help-text + error elements that describe
   * the editor's current state. Forwarded as `aria-describedby` on
   * the inner contenteditable so SR users hear the description when
   * focus lands on the editor (template-form's body-field error path
   * pre-R3.5 placed aria-invalid on a wrapper div, which AT couldn't
   * associate with the editable region).
   */
  readonly describedById?: string;
  /**
   * R3.5 M-13 — when true, sets `aria-invalid="true"` on the inner
   * contenteditable so SR users hear the invalid state on focus.
   * Pre-R3.5 the form wrapped the editor in a `<div aria-invalid>`
   * which AT did not propagate to the editable region.
   */
  readonly invalid?: boolean;
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
  /**
   * F119 T145 (FR-039) — the upload endpoint for `draftId`'s images. Omitted
   * on the member form (the uploader's own member default applies); the staff
   * compose-on-behalf form passes its `/api/admin/broadcasts/[id]/images` URL
   * so both forms drive ONE uploader.
   */
  readonly imageUploadUrl?: string;
}

export default function TiptapEditor({
  initialHtml,
  onChange,
  disabled = false,
  labelledById,
  describedById,
  invalid = false,
  imagesEnabled = false,
  draftId = null,
  imageUploadUrl,
}: TiptapEditorProps): React.ReactElement {
  const tEditor = useTranslations('portal.broadcasts.compose.editor');
  const tChrome = useTranslations('broadcast.editor');
  const tImage = useTranslations('portal.broadcasts.compose.imageUpload');
  const [announcement, setAnnouncement] = useState<string>('');
  const [altOpen, setAltOpen] = useState<boolean>(false);
  const [altVariant, setAltVariant] = useState<ImageAltVariant>('inline');
  // A ref, not state: the confirm hands over to the file picker and the upload
  // resolves later, so the half already collected has to survive the dialog's
  // own close render without a re-render racing it.
  const pendingImageRef = useRef<PendingImage | null>(null);
  const uploaderRef = useRef<ComposeInlineImageUploaderHandle | null>(null);
  const altTriggerRef = useRef<HTMLElement | null>(null);

  // F119 T088/T098/T102 — the ONE extension set (H2/H3 only, no code, no
  // codeBlock, no strike, plus the two design-block nodes).
  const extensions = useMemo(
    () => makeBroadcastEditorExtensions({ images: imagesEnabled }),
    [imagesEnabled],
  );

  // F119 T101 — one transform instance per mounted editor, so the
  // "unsupported formatting was removed" notice fires ONCE per editing
  // session instead of once per 1.5 s as it used to.
  const pasteTransform = useMemo(
    () =>
      makeBroadcastPasteTransform({
        images: imagesEnabled,
        notify: () => toast.warning(tChrome('pasteNotice')),
      }),
    [imagesEnabled, tChrome],
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
        // R3.5 M-13 — describedby + invalid on the contenteditable
        // (not a wrapper) so SR users get the error + help-text on
        // focus.
        ...(describedById !== undefined && {
          'aria-describedby': describedById,
        }),
        ...(invalid && { 'aria-invalid': 'true' }),
      },
      transformPastedHTML(html: string): string {
        // F119 T013/T014/T101 — the same config and the same post-attribute
        // hook the server runs, so a paste can never keep what the server
        // later strips (SC-011), and the notice is announced ONCE per
        // editing session rather than once per 1.5 s.
        return pasteTransform(html);
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

  /**
   * Insert the node, now that BOTH halves exist. `setImage` / `setBannerImage`
   * put it at the cursor; the server sanitiser keeps it (an http(s) Blob URL)
   * and `validateImageSourceAllowlist` enforces the tenant's hostname
   * allow-list at submit time — the Vercel Blob default-seed hostname is
   * already in it (T072 seedDefaults).
   */
  const insertImage = useCallback(
    (kind: ImageAltVariant, src: string, alt: string): void => {
      if (!editor) return;
      if (kind === 'banner') {
        editor.chain().focus().setBannerImage({ src, alt }).run();
      } else {
        editor.chain().focus().setImage({ src, alt }).run();
      }
    },
    [editor],
  );

  /**
   * F119 T099 (FR-040) — the description is collected BEFORE the node can
   * exist, from whichever end the author started:
   *
   *   toolbar Image/Banner → describe → pick a file → upload → insert
   *   uploader button      → upload → describe → insert
   *
   * Either way the node is only created once an `alt` is in hand, so there is
   * no path that produces an undescribed image.
   */
  const rememberTrigger = (): void => {
    altTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const openAltDialog = useCallback((kind: ImageAltVariant): void => {
    rememberTrigger();
    pendingImageRef.current = { kind };
    setAltVariant(kind);
    setAltOpen(true);
  }, []);

  const handleAltConfirm = useCallback(
    (alt: string): void => {
      const pending = pendingImageRef.current;
      if (pending === null) return;
      if (pending.src !== undefined) {
        insertImage(pending.kind, pending.src, alt);
        pendingImageRef.current = null;
        return;
      }
      pendingImageRef.current = { ...pending, alt };
      uploaderRef.current?.openPicker();
    },
    [insertImage],
  );

  /**
   * Closing WITHOUT confirming abandons the insert — otherwise a cancelled
   * description would stay armed and silently attach itself to whatever the
   * author uploaded next. A pending entry that already carries an `alt` is
   * mid-flight (the picker is open), so it survives the close.
   */
  const handleAltOpenChange = useCallback((next: boolean): void => {
    setAltOpen(next);
    if (!next && pendingImageRef.current?.alt === undefined) {
      pendingImageRef.current = null;
    }
  }, []);

  const handleUploaded = useCallback(
    (blobUrl: string): void => {
      const pending = pendingImageRef.current;
      if (pending?.alt !== undefined) {
        insertImage(pending.kind, blobUrl, pending.alt);
        pendingImageRef.current = null;
        return;
      }
      // Started from the uploader's own button — collect the description now,
      // before anything is inserted.
      rememberTrigger();
      pendingImageRef.current = { kind: 'inline', src: blobUrl };
      setAltVariant('inline');
      setAltOpen(true);
    },
    [insertImage],
  );

  if (!editor) {
    return <div className="min-h-[280px] rounded-md border bg-muted/40" />;
  }

  return (
    <div className="space-y-2">
      {imagesEnabled && <ClamavUnreachableBanner />}
      <div
        className={
          invalid
            ? 'rounded-md border border-destructive focus-within:ring-2 focus-within:ring-destructive min-w-0 overflow-hidden'
            : 'rounded-md border focus-within:ring-2 focus-within:ring-ring min-w-0 overflow-hidden'
        }
        data-testid="tiptap-editor"
      >
        <TiptapToolbar
          editor={editor}
          onAnnounce={announceState}
          imagesEnabled={imagesEnabled}
          imageInsertEnabled={draftId !== null}
          onInsertImage={() => openAltDialog('inline')}
          onInsertBanner={() => openAltDialog('banner')}
        />
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
        <ImageAltDialog
          open={altOpen}
          onOpenChange={handleAltOpenChange}
          variant={altVariant}
          onConfirm={handleAltConfirm}
          finalFocus={() => altTriggerRef.current}
        />
      )}
      {imagesEnabled && (
        <div className="flex flex-col gap-1">
          {draftId !== null ? (
            <ComposeInlineImageUploader
              ref={uploaderRef}
              draftId={draftId}
              {...(imageUploadUrl !== undefined ? { uploadUrl: imageUploadUrl } : {})}
              onUploaded={handleUploaded}
            />
          ) : (
            // PR-review fix 2026-05-20 UX-M3 — pair the hint with an
            // Info icon + alert styling (was plain <p>, blended into
            // surrounding body text). Matches F7 quota-warning pattern.
            // T155 finding U6 — the id is what the aria-disabled Image and
            // Banner controls point their `aria-describedby` at. This branch
            // renders on the SAME condition that disables them (`draftId ===
            // null`), so the target exists whenever it is referenced.
            <div className="flex items-start gap-2 text-muted-foreground text-sm">
              <Info className="w-4 h-4 mt-0.5 shrink-0" aria-hidden />
              <p id={IMAGE_DISABLED_HINT_ID}>{tImage('draftRequiredHint')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
