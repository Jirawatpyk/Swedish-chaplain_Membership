'use client';

/**
 * 088 US8 UX-B1 (T061e-4) — OPTIONAL MFA §80/1(5) zero-rate cert-scan uploader.
 *
 * Forked from `compose-inline-image-uploader.tsx` (F7.1a). Triggers
 * POST /api/invoices/[id]/zero-rate-cert-upload; on success reports the pinned
 * Blob key + filename to the parent issue form via `onUploaded`. The scan is
 * OPTIONAL — the cert NUMBER (validated above, fail-closed) is what makes the
 * zero rate valid; this attaches supporting evidence only.
 *
 * Input ergonomics (FR-036): the PRIMARY input is a native "Choose file" button
 * (≥44px, keyboard-focusable) paired with an `sr-only` file input; drag/drop is
 * an enhancement deliberately NOT implemented in this slice (don't block on it).
 *
 * a11y:
 *   - `sr-only` file input paired with a visible Button trigger so the
 *     focusable affordance is announced by screen readers;
 *   - indeterminate `<progress aria-label>` for upload-in-flight feedback;
 *   - `role="alert"` on the inline error so it is announced immediately;
 *   - once attached, an "Attached: <file> — Remove" affordance replaces the
 *     re-picker so the admin can remove/replace without a stale re-upload.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { PaperclipIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

/** Mirrors the use-case cap (5 MB) + accepted MIME allowlist. */
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/png,image/jpeg';

interface Props {
  readonly invoiceId: string;
  /** Non-null when a scan is attached → shows the attached affordance. */
  readonly attachedFilename: string | null;
  readonly onUploaded: (blobKey: string, filename: string) => void;
  readonly onRemove: () => void;
}

export function ZeroRateCertUploader({
  invoiceId,
  attachedFilename,
  onUploaded,
  onRemove,
}: Props): React.ReactElement {
  const t = useTranslations('admin.invoices.issue.form.certUpload');
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

    // Client-side size pre-check — reject locally before POSTing so the admin
    // doesn't burn upload bandwidth only to see a 413. Server cap enforced too.
    if (file.size > MAX_BYTES) {
      const msg = t('errors.zero_rate_cert_too_large');
      setError(msg);
      toast.error(msg);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    setUploading(true);
    const fd = new FormData();
    fd.append('file', file);

    try {
      const res = await fetch(`/api/invoices/${invoiceId}/zero-rate-cert-upload`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string };
        };
        const code = body.error?.code ?? 'unknown';
        // next-intl throws on a missing key — a future API error code would
        // otherwise crash the UI. Fall back to `errors.unknown`.
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
      const data = (await res.json()) as { blobKey: string };
      onUploaded(data.blobKey, file.name);
      toast.success(t('uploadedToast'));
    } catch (err) {
      console.error(
        { err: String(err), invoiceId },
        'invoicing.zero_rate_cert_upload.fetch_failed',
      );
      const msg = t('errors.unknown');
      setError(msg);
      toast.error(msg);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // Attached state — filename + Remove, not a re-picker (FR-024 ergonomics).
  if (attachedFilename) {
    return (
      <div className="flex flex-col gap-2" data-testid="zero-rate-cert-attached">
        <span className="text-sm font-medium">{t('label')}</span>
        <div className="flex items-center gap-2 rounded-md border bg-muted/30 p-2 text-sm">
          <PaperclipIcon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">
            {t('attached', { filename: attachedFilename })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[44px]"
            onClick={onRemove}
            disabled={uploading}
          >
            {t('remove')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">{t('label')}</span>
      <Label htmlFor="zero-rate-cert-file" className="sr-only">
        {t('pickerLabel')}
      </Label>
      <input
        id="zero-rate-cert-file"
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={handleChange}
      />
      <Button
        type="button"
        variant="outline"
        onClick={handlePick}
        disabled={uploading}
        // FR-036 — ≥44px touch target for the file-picker trigger.
        className="min-h-[44px] self-start"
      >
        {uploading ? t('uploadingLabel') : t('uploadButton')}
      </Button>
      {uploading && (
        <progress aria-label={t('uploadingAria')} className="w-full" />
      )}
      {error && (
        <div role="alert" className="text-caption text-destructive">
          {error}
        </div>
      )}
      <p className="text-caption text-muted-foreground">{t('helpText')}</p>
    </div>
  );
}
