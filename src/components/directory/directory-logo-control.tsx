'use client';

/**
 * F9 US5 (T082b) — member directory logo upload/remove control (FR-025a).
 *
 * Posts the chosen file as multipart to the member-own logo route (server re-
 * encodes + strips EXIF). Shows the current (re-encoded, public) logo + a remove
 * action. Toasts the result; refreshes so the preview updates.
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { readErrorCode } from './read-error-code';

export function DirectoryLogoControl({
  currentLogoUrl,
}: {
  readonly currentLogoUrl: string | null;
}): React.JSX.Element {
  const t = useTranslations('directorySettings');
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  // Track which action is running so only that button shows the spinner.
  const [pendingAction, setPendingAction] = useState<'upload' | 'remove' | null>(null);
  // Destructive logo removal is confirmed via an AlertDialog (ux-standards § 6).
  const [removeOpen, setRemoveOpen] = useState(false);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    startTransition(async () => {
      setPendingAction('upload');
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/portal/directory/logo', { method: 'POST', body: fd });
        if (!res.ok) {
          const code = await readErrorCode(res);
          if (code === 'too_large') toast.error(t('logoTooLarge'));
          else if (code === 'unsupported_format') toast.error(t('logoUnsupported'));
          else if (code === 'invalid_image') toast.error(t('logoInvalidImage'));
          else if (code === 'member_not_found' || code === 'no_member_profile')
            toast.error(t('logoProfileMissing'));
          else toast.error(t('logoFailed'));
          return;
        }
        toast.success(t('logoSaved'));
        router.refresh();
      } catch {
        toast.error(t('logoFailed'));
      } finally {
        if (inputRef.current) inputRef.current.value = '';
        setPendingAction(null);
      }
    });
  }

  function onRemove() {
    startTransition(async () => {
      setPendingAction('remove');
      try {
        const res = await fetch('/api/portal/directory/logo', { method: 'DELETE' });
        if (!res.ok) {
          const code = await readErrorCode(res);
          if (code === 'member_not_found' || code === 'no_member_profile')
            toast.error(t('logoProfileMissing'));
          else toast.error(t('logoFailed'));
          return;
        }
        toast.success(t('logoRemoved'));
        router.refresh();
      } catch {
        toast.error(t('logoFailed'));
      } finally {
        setPendingAction(null);
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
      <p id="dir-logo-hint" className="text-sm text-muted-foreground">
        {t('logoHint')}
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={onFile}
        aria-label={t('logoUpload')}
        aria-describedby="dir-logo-hint"
      />
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          aria-busy={pendingAction === 'upload'}
          onClick={() => inputRef.current?.click()}
          aria-describedby="dir-logo-hint"
        >
          {pendingAction === 'upload' ? (
            <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
          ) : null}
          {t('logoUpload')}
        </Button>
        {currentLogoUrl !== null ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            aria-busy={pendingAction === 'remove'}
            onClick={() => setRemoveOpen(true)}
          >
            {pendingAction === 'remove' ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
            ) : null}
            {t('logoRemove')}
          </Button>
        ) : null}
      </div>
      <ConfirmationDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('logoRemoveTitle')}
        description={t('logoRemoveDescription')}
        confirmLabel={t('logoRemoveConfirm')}
        cancelLabel={t('cancel')}
        destructive
        onConfirm={onRemove}
      />
    </div>
  );
}
