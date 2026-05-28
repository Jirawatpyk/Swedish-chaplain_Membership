'use client';

/**
 * F9 US5 (T082b) — member directory logo upload/remove control (FR-025a).
 *
 * Posts the chosen file as multipart to the member-own logo route (server re-
 * encodes + strips EXIF). Shows the current (re-encoded, public) logo + a remove
 * action. Toasts the result; refreshes so the preview updates.
 */
import { useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function DirectoryLogoControl({
  currentLogoUrl,
}: {
  readonly currentLogoUrl: string | null;
}): React.JSX.Element {
  const t = useTranslations('directorySettings');
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    startTransition(async () => {
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/portal/directory/logo', { method: 'POST', body: fd });
        if (!res.ok) {
          toast.error(t('logoFailed'));
          return;
        }
        toast.success(t('logoSaved'));
        router.refresh();
      } catch {
        toast.error(t('logoFailed'));
      } finally {
        if (inputRef.current) inputRef.current.value = '';
      }
    });
  }

  function onRemove() {
    startTransition(async () => {
      try {
        const res = await fetch('/api/portal/directory/logo', { method: 'DELETE' });
        if (!res.ok) {
          toast.error(t('logoFailed'));
          return;
        }
        toast.success(t('logoRemoved'));
        router.refresh();
      } catch {
        toast.error(t('logoFailed'));
      }
    });
  }

  return (
    <div className="space-y-3">
      {currentLogoUrl !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- external Blob URL; next/image remotePatterns not configured for tenant logos
        <img
          src={currentLogoUrl}
          alt={t('logoCurrent')}
          className="h-20 w-auto rounded border bg-white object-contain p-1"
        />
      ) : null}
      <p className="text-sm text-muted-foreground">{t('logoHint')}</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={onFile}
        aria-label={t('logoUpload')}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => inputRef.current?.click()}
        >
          {t('logoUpload')}
        </Button>
        {currentLogoUrl !== null ? (
          <Button type="button" variant="ghost" disabled={pending} onClick={onRemove}>
            {t('logoRemove')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
