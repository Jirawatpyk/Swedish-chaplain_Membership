'use client';

/**
 * T080 (F7.1a US2) — Member compose inline-image uploader.
 *
 * Triggers POST /api/broadcasts/inline-image-upload; on success calls
 * `onUploaded(blobUrl)` so the parent Tiptap editor can insert the
 * `<img src=blobUrl>` via `editor.chain().setImage()`.
 *
 * a11y:
 *   - file input is `sr-only` + paired with visible Button trigger
 *     so the focusable affordance is announced by screen readers
 *   - <progress aria-label> for upload-in-flight feedback
 *   - role="alert" on inline error so it's announced immediately
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface Props {
  readonly draftId: string;
  readonly onUploaded: (blobUrl: string) => void;
}

export function ComposeInlineImageUploader({
  draftId,
  onUploaded,
}: Props): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.imageUpload');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePick = (): void => {
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
      const res = await fetch('/api/broadcasts/inline-image-upload', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        const code = body.error ?? 'unknown';
        // UX M-3 fix 2026-05-21 (review finding enterprise-ux-designer
        // M-3): wrap dynamic-key lookup in try/catch with fallback to
        // `errors.unknown`. next-intl throws on missing keys by
        // default — a future API expansion adding a new error code
        // (e.g. `rate_limited`, `tenant_not_found`) would crash the
        // upload UI before this guard landed. Pattern mirrors F6.1
        // Phase 5 US5 fix.
        let msg: string;
        try {
          msg = t(`errors.${code}`);
        } catch {
          msg = t('errors.unknown');
        }
        setError(msg);
        toast.error(msg);
        return;
      }
      const data = (await res.json()) as { blobUrl: string };
      onUploaded(data.blobUrl);
      toast.success(t('uploadedToast'));
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
      <Label htmlFor="broadcast-image-file" className="sr-only">
        {t('pickerLabel')}
      </Label>
      <input
        id="broadcast-image-file"
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        onChange={handleChange}
      />
      <Button
        type="button"
        variant="outline"
        onClick={handlePick}
        disabled={uploading}
        // PR-review fix 2026-05-20 UX-H3 — mobile tap target ≥44px
        // per iOS HIG (default Button height is 36px, fails on file-
        // picker triggers on mobile Safari).
        className="min-h-[44px]"
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
        <progress
          aria-label={t('uploadingAria')}
          className="w-full"
        />
      )}
      {error && (
        <div role="alert" className="text-destructive text-caption">
          {error}
        </div>
      )}
      <p className="text-caption text-muted-foreground">{t('helpText')}</p>
    </div>
  );
}
