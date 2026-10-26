'use client';

/**
 * T082 — Tiptap rich-text editor for F7 broadcast compose surface.
 *
 * Browser-only — MUST be loaded via `loadTiptapEditor()` from
 * `@/components/shell/tiptap-loader` so SSR is disabled.
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
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { NodeSelection, type EditorState } from '@tiptap/pm/state';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { TiptapLoadingSkeleton } from '@/components/shell/tiptap-loader';
import { Info } from 'lucide-react';
import { TiptapToolbar, type AnnounceKey } from './tiptap-toolbar';
import { makeBroadcastEditorExtensions } from './broadcast-editor-extensions';
import { makeBroadcastPasteTransform } from './broadcast-paste-transform';
import { ImageAltDialog, type ImageAltVariant } from './image-alt-dialog';
import {
  ComposeInlineImageUploader,
  MEMBER_INLINE_IMAGE_UPLOAD_URL,
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
  /**
   * Where to release the uploaded row if its description is cancelled (spec
   * 131), fixed at upload time: the host's draft or URL may change before
   * the author answers (#658 reliability L2).
   */
  readonly releaseUrl?: string;
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

/** A new message: one empty paragraph. */
function isEmptyDoc(state: EditorState): boolean {
  const first = state.doc.firstChild;
  return state.doc.childCount === 1 && first !== null && first.type.name === 'paragraph' && first.content.size === 0;
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
  // Round 2, #4 — an upload in flight: Image and Banner wait for it.
  const [imageBusy, setImageBusy] = useState<boolean>(false);
  // Round 2, #20 — per editor, so two editors on a page never share it.
  const imageHintId = useId();
  const uploadButtonId = useId();
  const altConfirmedRef = useRef<boolean>(false);
  // Round 3 (a11y review): how far below the top the caret must stay — the
  // sticky toolbar plus the shell bar, measured; a 64px guess until then.
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [caretClearance, setCaretClearance] = useState<number>(64);
  const [altOpen, setAltOpen] = useState<boolean>(false);
  const [altVariant, setAltVariant] = useState<ImageAltVariant>('inline');
  // Round 2, #6 — an inserted image selected when Image / Banner is used: the
  // dialog edits its description instead of starting a new image.
  const [altEdit, setAltEdit] = useState<{ readonly typeName: string; readonly alt: string } | null>(null);
  // A ref, not state: the confirm hands over to the file picker and the upload
  // resolves later, so the half already collected has to survive the dialog's
  // own close render without a re-render racing it.
  const pendingImageRef = useRef<PendingImage | null>(null);
  const uploaderRef = useRef<ComposeInlineImageUploaderHandle | null>(null);
  const altTriggerRef = useRef<HTMLElement | null>(null);

  // F119 T088/T098/T102 — the ONE extension set (H2/H3 only, no code, no
  // codeBlock, no strike, plus the two design-block nodes).
  const extensions = useMemo(
    () =>
      makeBroadcastEditorExtensions({
        images: imagesEnabled,
        describeCta: (href) => tChrome('ctaBlockDescription', { href }),
      }),
    [imagesEnabled, tChrome],
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
      // Round 3 (a11y review): ProseMirror scrolls the caret clear of the
      // sticky toolbar and shell bar, not just the window edge.
      scrollMargin: { top: caretClearance, bottom: 8, left: 0, right: 0 },
      scrollThreshold: { top: caretClearance, bottom: 8, left: 0, right: 0 },
      attributes: (state: EditorState) => ({
        // `eblast-editor-content` (globals.css) draws the headings, lists,
        // quote, divider, button and banner as the email sends them.
        class: 'eblast-editor-content min-h-[240px] px-3 py-2 focus:outline-none',
        role: 'textbox',
        'aria-multiline': 'true',
        // Round 2, #13 — a placeholder without a new dependency: globals.css
        // draws `--eblast-placeholder` in the empty first paragraph, and
        // `aria-placeholder` gives it to assistive technology, only while the
        // message is empty (round 3).
        ...(isEmptyDoc(state) && { 'aria-placeholder': tChrome('placeholder') }),
        style: `--eblast-placeholder: ${JSON.stringify(tChrome('placeholder'))}`,
        // Round 2, #3 — read-only while the host saves or submits.
        ...(disabled && { 'aria-readonly': 'true' }),
        ...(labelledById !== undefined && { 'aria-labelledby': labelledById }),
        // R3.5 M-13 — describedby + invalid on the contenteditable
        // (not a wrapper) so SR users get the error + help-text on
        // focus.
        ...(describedById !== undefined && {
          'aria-describedby': describedById,
        }),
        ...(invalid && { 'aria-invalid': 'true' }),
      }),
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

  useEffect(() => {
    const frame = frameRef.current;
    const bar = frame?.querySelector<HTMLElement>('[role="toolbar"]');
    if (!frame || !bar || typeof ResizeObserver === 'undefined') return undefined;
    const measure = (): void => {
      const shell = Number.parseFloat(getComputedStyle(frame).getPropertyValue('--shell-bar-height')) || 0;
      const height = bar.getBoundingClientRect().height;
      if (height > 0) setCaretClearance(Math.round(height + shell + 8));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [editor]);

  // Round 2, #3 — Tiptap reads `editable` once and keeps it on every
  // re-render, so a host's `disabled` (submitting / pending) that turned on
  // after mount left the text typeable. Follow the prop.
  useEffect(() => {
    // `false`: no update event. Emitting one ran the host's onChange when a
    // refused submit re-enabled the editor, and wiped the server's error
    // (round 3, UX review B1).
    if (editor && editor.isEditable === disabled) editor.setEditable(!disabled, false);
  }, [editor, disabled]);

  // Round 2, #14 — one clear timer at a time: a second toggle within 1.5 s
  // was cut short by the first one's clear.
  const announceTimerRef = useRef<number | null>(null);
  const announceState = useCallback(
    (key: AnnounceKey) => {
      // Cleared, then set on the next frame: the same message twice in a row
      // is a change to the live region, so it is announced again (round 3).
      const message = tEditor(`announcements.${key}`);
      setAnnouncement('');
      window.requestAnimationFrame(() => setAnnouncement(message));
      if (announceTimerRef.current !== null) window.clearTimeout(announceTimerRef.current);
      announceTimerRef.current = window.setTimeout(() => {
        announceTimerRef.current = null;
        setAnnouncement('');
      }, 1500);
    },
    [tEditor],
  );
  useEffect(
    () => () => {
      if (announceTimerRef.current !== null) window.clearTimeout(announceTimerRef.current);
    },
    [],
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
      const done =
        kind === 'banner'
          ? editor.chain().focus().setBannerImage({ src, alt }).run()
          : editor.chain().focus().setImage({ src, alt }).run();
      // Round 2, #5 — "Image added." is said here, once the image is in the
      // message, not when the file reached storage; by the toast alone, so it
      // is heard once (round 3).
      if (done) toast.success(tImage('uploadedToast'));
    },
    [editor, tImage],
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

  const openAltDialog = useCallback(
    (kind: ImageAltVariant): void => {
      rememberTrigger();
      altConfirmedRef.current = false;
      const selection = editor?.state.selection;
      const selected = selection instanceof NodeSelection ? selection.node : null;
      // Image edits a selected image, Banner a selected banner (round 3): Banner
      // on an inline image starts a new banner, it does not edit the image.
      const editable = kind === 'banner' ? 'bannerImage' : 'image';
      if (selected !== null && selected.type.name === editable) {
        const alt: unknown = selected.attrs['alt'];
        pendingImageRef.current = null;
        setAltEdit({ typeName: selected.type.name, alt: typeof alt === 'string' ? alt : '' });
        setAltVariant(selected.type.name === 'bannerImage' ? 'banner' : 'inline');
        setAltOpen(true);
        return;
      }
      setAltEdit(null);
      pendingImageRef.current = { kind };
      setAltVariant(kind);
      setAltOpen(true);
    },
    [editor],
  );

  const handleAltConfirm = useCallback(
    (alt: string): void => {
      if (altEdit !== null) {
        altConfirmedRef.current = true;
        editor?.chain().focus().updateAttributes(altEdit.typeName, { alt }).run();
        setAltEdit(null);
        return;
      }
      const pending = pendingImageRef.current;
      if (pending === null) return;
      if (pending.src !== undefined) {
        altConfirmedRef.current = true;
        insertImage(pending.kind, pending.src, alt);
        pendingImageRef.current = null;
        return;
      }
      pendingImageRef.current = { ...pending, alt };
      uploaderRef.current?.openPicker();
    },
    [insertImage, altEdit, editor],
  );

  /**
   * Closing WITHOUT confirming abandons the insert — otherwise a cancelled
   * description would stay armed and silently attach itself to whatever the
   * author uploaded next. A pending entry that already carries an `alt` is
   * mid-flight (the picker is open), so it survives the close.
   */
  /**
   * Spec 131 — release an upload that never made it into the message: the
   * endpoint beside the host's upload route stamps its row, and the next daily
   * sweep removes it. Fire and forget, `keepalive` so a page left at once
   * still sends it. A failure is logged and changes nothing the author sees:
   * on an E-Blast the sweep's "unused" arm reclaims the image once it closes.
   */
  const releaseUpload = useCallback((url: string): void => {
    void fetch(url, { method: 'DELETE', keepalive: true })
      .then((res) => {
        if (!res.ok) console.error({ status: res.status }, 'broadcasts.image_release.refused');
      })
      .catch((err: unknown) => {
        console.error({ err: String(err) }, 'broadcasts.image_release.failed');
      });
  }, []);

  // #658 reliability L3 — leaving the page while an uploaded image's
  // description is still open abandons it too, so release it then.
  useEffect(() => {
    return () => {
      const pending = pendingImageRef.current;
      if (pending?.src !== undefined && pending.alt === undefined && pending.releaseUrl !== undefined) {
        releaseUpload(pending.releaseUrl);
      }
    };
  }, [releaseUpload]);

  const handleAltOpenChange = useCallback((next: boolean): void => {
    setAltOpen(next);
    // A closed edit is over, confirmed or not: a later upload's description
    // must never be written onto the image that was being edited.
    if (!next) setAltEdit(null);
    if (!next && pendingImageRef.current?.alt === undefined) {
      // Uploaded, then the description was cancelled: the file is stored but
      // nothing is in the message, so say so (round 2, #5) and release it
      // (spec 131).
      const pending = pendingImageRef.current;
      if (pending?.src !== undefined) {
        toast.info(tImage('notInserted'));
        if (pending.releaseUrl !== undefined) releaseUpload(pending.releaseUrl);
      }
      pendingImageRef.current = null;
    }
  }, [tImage, releaseUpload]);

  /**
   * The author dismissed the file picker the description opened. The pending
   * `{ kind, alt }` would otherwise stay armed and be attached — without
   * asking — to whatever the uploader's own button uploads next, carrying the
   * abandoned description and kind (banner vs inline).
   */
  const handlePickerCancel = useCallback((): void => {
    if (pendingImageRef.current?.alt !== undefined) {
      pendingImageRef.current = null;
    }
  }, []);

  const handleUploaded = useCallback(
    (blobUrl: string, imageId?: string): void => {
      const pending = pendingImageRef.current;
      if (pending?.alt !== undefined) {
        insertImage(pending.kind, blobUrl, pending.alt);
        pendingImageRef.current = null;
        return;
      }
      // Started from the uploader's own button — collect the description now,
      // before anything is inserted.
      rememberTrigger();
      altConfirmedRef.current = false;
      setAltEdit(null);
      const releaseUrl =
        imageId !== undefined && draftId !== null
          ? `${imageUploadUrl ?? MEMBER_INLINE_IMAGE_UPLOAD_URL}/${encodeURIComponent(imageId)}?draftId=${encodeURIComponent(draftId)}`
          : undefined;
      pendingImageRef.current = { kind: 'inline', src: blobUrl, ...(releaseUrl !== undefined ? { releaseUrl } : {}) };
      setAltVariant('inline');
      setAltOpen(true);
    },
    [insertImage, draftId, imageUploadUrl],
  );

  if (!editor) {
    // The same pulse skeleton the loader shows while the chunk arrives, so
    // loading reads as one state rather than a skeleton then a blank box.
    return <TiptapLoadingSkeleton />;
  }

  return (
    <div className="space-y-2">
      {imagesEnabled && <ClamavUnreachableBanner />}
      <div
        // Spec 122 US12d-2 — the frame draws as an AURA input: its edge, fill,
        // radius, hover edge and focus outline (`.aura-input`), danger edge
        // when invalid. The outline follows the writing area only, so a focused
        // toolbar control shows its own ring, not two.
        className={cn(
          // `overflow-clip`, not `hidden`: it rounds the corners without making
          // a scroll box, so the toolbar can stay sticky (round 2, #11).
          'min-w-0 overflow-clip rounded-[var(--aura-radius-md)] border bg-[var(--aura-bg-input)]',
          'has-[.ProseMirror:focus]:outline-[length:var(--aura-focus-ring-width)] has-[.ProseMirror:focus]:outline-offset-1 has-[.ProseMirror:focus]:outline-[var(--aura-focus-ring)] has-[.ProseMirror:focus]:outline-solid',
          invalid
            ? 'border-[var(--aura-border-danger)]'
            : 'border-[var(--aura-border-control)] hover:border-[var(--aura-fg-secondary)] has-[.ProseMirror:focus]:border-[var(--aura-border-strong)]',
        )}
        ref={frameRef}
        data-testid="tiptap-editor"
      >
        <TiptapToolbar
          disabled={disabled}
          editor={editor}
          onAnnounce={announceState}
          imagesEnabled={imagesEnabled}
          imageInsertEnabled={draftId !== null}
          imageBusy={imageBusy}
          imageHintId={imageHintId}
          imageBusyId={uploadButtonId}
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
          editing={altEdit !== null}
          initialValue={altEdit?.alt ?? ''}
          onConfirm={handleAltConfirm}
          // Saved or inserted: back to the text, as the link and button
          // dialogs do; cancelled: back to the control (round 3).
          finalFocus={() => (altConfirmedRef.current && editor ? editor.view.dom : altTriggerRef.current)}
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
              onPickerCancel={handlePickerCancel}
              onUploadingChange={setImageBusy}
              buttonId={uploadButtonId}
              disabled={disabled}
            />
          ) : (
            // PR-review fix 2026-05-20 UX-M3 — pair the hint with an
            // Info icon + alert styling (was plain <p>, blended into
            // surrounding body text). Matches F7 quota-warning pattern.
            // T155 finding U6 — the id is what the aria-disabled Image and
            // Banner controls point their `aria-describedby` at. This branch
            // renders on the SAME condition that disables them (`draftId ===
            // null`), so the target exists whenever it is referenced.
            <div className="flex items-start gap-2 aura-text-caption text-[var(--aura-fg-secondary)]">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p id={imageHintId}>{tImage('draftRequiredHint')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
