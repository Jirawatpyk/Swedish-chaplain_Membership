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
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { Button } from '@jirawatpyk/aura-react';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import { TRANSPARENCY_CHECKER_STYLE } from '@/components/shell/transparency-checker';
import { readErrorCode } from './read-error-code';

export function DirectoryLogoControl({
  currentLogoUrl,
}: {
  readonly currentLogoUrl: string | null;
}): React.JSX.Element {
  const t = useTranslations('directorySettings');
  const readOnlyToast = useReadOnlyToast();
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
          if (await isReadOnlyResponse(res)) {
            readOnlyToast();
            return;
          }
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
          if (await isReadOnlyResponse(res)) {
            readOnlyToast();
            return;
          }
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
        // The fixed light checker — the logo as an email shows it, on white in
        // either theme (a themed checker hid dark logos). Same swatch as the
        // Brand settings logo preview (T155 U16, F119 UX review).
        <div
          data-testid="directory-logo-preview"
          className="inline-block rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] p-1"
          style={TRANSPARENCY_CHECKER_STYLE}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- external Blob URL; next/image remotePatterns not configured for tenant logos */}
          <img
            src={currentLogoUrl}
            alt={t('logoCurrent')}
            className="h-20 w-auto object-contain"
          />
        </div>
      ) : null}
      <p id="dir-logo-hint" className="text-sm text-[var(--aura-fg-secondary)]">
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
      {/* AURA buttons (spec 122 US3): `loading` shows the spinner on the one
          action that is running and sets aria-busy; both stay disabled while
          either runs. */}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          icon="upload"
          disabled={pending}
          loading={pendingAction === 'upload'}
          onClick={() => inputRef.current?.click()}
          aria-describedby="dir-logo-hint"
        >
          {t('logoUpload')}
        </Button>
        {currentLogoUrl !== null ? (
          <Button
            type="button"
            variant="ghost"
            icon="trash-2"
            disabled={pending}
            loading={pendingAction === 'remove'}
            onClick={() => setRemoveOpen(true)}
          >
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
