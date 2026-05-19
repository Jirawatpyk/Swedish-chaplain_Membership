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
  const t = useTranslations('member.broadcasts.compose.imageUpload');
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
        const msg = t(`errors.${code}`);
        setError(msg);
        toast.error(msg);
        return;
      }
      const data = (await res.json()) as { blobUrl: string };
      onUploaded(data.blobUrl);
      toast.success(t('uploadedToast'));
    } catch (err) {
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
      >
        {uploading ? t('uploadingLabel') : t('uploadButton')}
      </Button>
      {uploading && (
        <progress
          aria-label={t('progressAria')}
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
