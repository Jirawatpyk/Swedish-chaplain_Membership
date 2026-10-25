'use client';

/**
 * T080 (F7.1a US2) — Member compose inline-image uploader.
 *
 * Triggers POST /api/broadcasts/inline-image-upload; on success calls
 * `onUploaded(blobUrl)` so the parent Tiptap editor can insert the
 * `<img src=blobUrl>` via `editor.chain().setImage()`.
 *
 * a11y:
 *   - the file input is `sr-only` and out of the Tab order; the visible
 *     Button opens it, carrying the help and public-link notice
 *   - an indeterminate AURA Progress (aria-label) while the upload runs
 *   - a refusal is announced once, by the toast; the inline Alert keeps it
 *     in view afterwards
 */
import { useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Image as ImageIcon } from 'lucide-react';
import { Alert, Button, Progress } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';

/**
 * F119 T099 — the editor's toolbar Image / Banner controls collect the
 * description FIRST (FR-040) and then need the file picker. They open it
 * through this handle rather than rendering a second uploader, so both entry
 * points share one upload path, one size pre-check and one error surface.
 */
export interface ComposeInlineImageUploaderHandle {
  openPicker(): void;
}

/** The member's own draft upload — the default, so the member form is untouched. */
export const MEMBER_INLINE_IMAGE_UPLOAD_URL = '/api/broadcasts/inline-image-upload';

interface Props {
  readonly draftId: string;
  readonly onUploaded: (blobUrl: string) => void;
  /**
   * F119 T145 (FR-039) — where the file goes. The staff compose-on-behalf form
   * uploads to `POST /api/admin/broadcasts/[id]/images`, which carries the
   * draft in the PATH and runs the identical 5 MB / MIME / ClamAV / allow-list
   * rules (`broadcasts-image-upload-route.ts`). One uploader, one size
   * pre-check, one error surface — never a second component.
   */
  readonly uploadUrl?: string;
  /**
   * The file picker was dismissed without a file — the input's `cancel`
   * event, or (where that event does not exist) the uploader's own button
   * being clicked afterwards — so a caller holding state for "the file about
   * to arrive" — the editor's pending description — can drop it.
   */
  readonly onPickerCancel?: () => void;
  /**
   * Round 2, #4 — told when an upload starts and ends, so the editor can make
   * Image and Banner unavailable meanwhile (a second upload or a banner
   * started mid-flight attached the wrong description).
   */
  readonly onUploadingChange?: (uploading: boolean) => void;
  /** While the host saves or submits (round 2, #3). */
  readonly disabled?: boolean;
  /** The upload button's id, so the editor can point Image and Banner at "Uploading…" while they wait. */
  readonly buttonId?: string;
  readonly ref?: React.Ref<ComposeInlineImageUploaderHandle>;
}

export function ComposeInlineImageUploader({
  draftId,
  onUploaded,
  uploadUrl = MEMBER_INLINE_IMAGE_UPLOAD_URL,
  onPickerCancel,
  onUploadingChange,
  disabled = false,
  buttonId,
  ref,
}: Props): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.imageUpload');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Round 2, #20 — ids per instance: two editors on one page must not share them.
  const idBase = useId();
  const inputId = `${idBase}-file`;
  const helpId = `${idBase}-help`;
  const noticeId = `${idBase}-public-notice`;
  const alertId = `${idBase}-error`;

  // Round 2, #4/#15 — a picker opened from the description never starts a
  // second upload mid-flight, and starting again clears the last refusal.
  useImperativeHandle(
    ref,
    () => ({
      openPicker: () => {
        if (uploading) return;
        setError(null);
        fileRef.current?.click();
      },
    }),
    [uploading],
  );

  useEffect(() => {
    onUploadingChange?.(uploading);
  }, [uploading, onUploadingChange]);

  // A native listener, not React's `onCancel` prop: React attaches `cancel`
  // only to <dialog>, so the prop would never fire on an <input type="file">.
  useEffect(() => {
    const input = fileRef.current;
    if (input === null || onPickerCancel === undefined) return;
    input.addEventListener('cancel', onPickerCancel);
    return () => input.removeEventListener('cancel', onPickerCancel);
  }, [onPickerCancel]);

  // The uploader's OWN button — never `openPicker()`, which the alt-first flow
  // uses. If this button can be clicked, no picker the description opened is
  // still open, so that picker was dismissed: report it. That is the guard on
  // browsers without the input `cancel` event (Safari < 16.4), where the
  // listener above never fires.
  const handlePick = (): void => {
    if (disabled) return;
    onPickerCancel?.();
    setError(null);
    fileRef.current?.click();
  };

  const handleChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);

    // PR-review fix 2026-05-20 CR-M4 — client-side size pre-check.
    // Reject locally before constructing FormData + POSTing so members
    // don't burn upload bandwidth + admin Blob quota only to see a
    // 413 reject. Server-side cap still enforced (defence-in-depth).
    const MAX_BYTES = 5 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      const msg = t('errors.broadcast_image_too_large');
      setError(msg);
      toast.error(msg);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    setUploading(true);

    const fd = new FormData();
    fd.append('file', file);
    fd.append('draftId', draftId);

    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string | { code?: string };
        };
        // Two envelopes reach here: the upload use-case refusals are
        // `{ error: '<kind>' }` on every surface, while the staff route's gate
        // and ownership refusals ride the bilingual `{ error: { code } }`
        // (`errorResponse`). Reading only the first would render every staff
        // 404 / 409 / 429 as "unknown".
        const code =
          typeof body.error === 'string'
            ? body.error
            : (body.error?.code ?? 'unknown');
        // UX M-3 fix 2026-05-21 — a future API expansion adding a new error
        // code (`rate_limited`, `tenant_not_found`, …) must not reach the
        // member as a raw key.
        //
        // T155 finding U8 — the original guard was a `try/catch`, on the
        // premise that "next-intl throws on missing keys by default". It does
        // NOT: it returns the key PATH, so the catch was dead and the raw path
        // was shown. `t.has()` is the guard that actually runs.
        // The write freeze arrives as either spelling (flat `read-only-mode`
        // from the proxy, nested `read_only_mode` from a route guard); one key
        // answers both, as a warning — nothing is wrong with the image.
        if (isReadOnlyRefusal(res.status, body)) {
          const msg = t('errors.read_only_mode');
          setError(msg);
          toast.warning(msg);
          return;
        }
        const key = `errors.${code}` as Parameters<typeof t>[0];
        const msg = t.has(key) ? t(key) : t('errors.unknown');
        setError(msg);
        toast.error(msg);
        return;
      }
      const data = (await res.json()) as { blobUrl: string };
      // The success toast is the editor's, said when the image is actually in
      // the message (round 2, #5): an upload whose description is cancelled
      // adds nothing.
      onUploaded(data.blobUrl);
    } catch (err) {
      // PR-review fix 2026-05-20 SF-M2 — log so CSP / CORS / offline
      // are distinguishable in browser console; toast stays generic.
       
      console.error(
        { err: String(err), draftId },
        'broadcasts.inline_image_upload.fetch_failed',
      );
      const msg = t('errors.unknown');
      setError(msg);
      toast.error(msg);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="sr-only">
        {t('pickerLabel')}
      </label>
      <input
        id={inputId}
        // Round 2, #10 — opened only by the button (or the description's
        // hand-off), never reached by Tab: a clipped input was an invisible
        // tab stop beside the button that does the same thing.
        tabIndex={-1}
        // Round 3 (a11y review): hidden from a screen reader's virtual cursor
        // too, and refused while the host is busy or a file is uploading, so
        // it never gets around the Button's guards.
        aria-hidden="true"
        disabled={disabled || uploading}
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        // Both the input and the Button carry the description (the
        // `custom-list-input.tsx` pattern): a member reaching the Button must
        // hear the public-link notice, the entire PDPA transparency control.
        aria-describedby={`${helpId} ${noticeId}`}
        onChange={handleChange}
      />
      {/* Spec 122 US12d-2 — the boards' "Upload image": a secondary AURA
          Button with an image icon, 44px on touch (UX-H3's tap target). */}
      <Button
        variant="secondary"
        icon={<ImageIcon aria-hidden />}
        touchHeight
        onClick={handlePick}
        // `loading`, not `disabled`: aria-disabled + aria-busy keep focus on
        // the button while the file uploads (a native disabled dropped it to
        // <body>, so "Uploading…" was never heard).
        loading={uploading}
        {...(disabled && !uploading && { 'aria-disabled': true })}
        {...(buttonId !== undefined && { id: buttonId })}
        // The refusal stays described on the button after its toast is gone.
        aria-describedby={error ? `${alertId} ${helpId} ${noticeId}` : `${helpId} ${noticeId}`}
        className="self-start"
      >
        {uploading ? t('uploadingLabel') : t('uploadButton')}
      </Button>
      {uploading && (
        // PR-review fix 2026-05-20 UX-H4 — <progress> is indeterminate
        // (no value), so the aria-label must reflect indeterminate
        // semantics. Was 'progressAria' = "Image upload progress" which
        // implied a percentage; now 'uploadingAria' = "Uploading image
        // — please wait". Real byte-progress would need
        // XMLHttpRequest.upload.onprogress wiring; deferred to F7.1b.
        <Progress aria-label={t('uploadingAria')} />
      )}
      {error && (
        // `role="none"`: the toast already announces the refusal (round 2,
        // #15); this keeps it in view after the toast is gone.
        <Alert id={alertId} tone="danger" role="none">
          {error}
        </Alert>
      )}
      <p id={helpId} className="aura-text-caption text-[var(--aura-fg-secondary)]">
        {t('helpText')}
      </p>
      {/*
        F119 review finding F2-11 (PDPA M-4) — transparency BEFORE the choice.
        An inline image is written to a public, unauthenticated blob URL and
        then fetched by every recipient's mail client (a mail client cannot
        carry a session, so the tier has to be public). A member picking a
        photo off their phone has no way to know that from the button, so the
        sentence sits next to the picker, above it in reading order, not in a
        toast after the upload.
      */}
      <p id={noticeId} className="aura-text-caption text-[var(--aura-fg-secondary)]">
        {t('publicLinkNotice')}
      </p>
    </div>
  );
}
