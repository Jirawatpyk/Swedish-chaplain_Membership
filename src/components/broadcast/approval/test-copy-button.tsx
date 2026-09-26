'use client';

/**
 * F119 T063 (FR-037) — "Send me a test copy" on the staff format surface.
 *
 * Posts the CURRENT working copy (subject + body, unsaved edits included —
 * a test copy is how you check an edit before saving it) to
 * `POST /api/admin/broadcasts/test-copy`. The recipient is always the staff
 * session's own address: the route has no `to` field, so there is nothing
 * here to choose. `broadcastId` / `versionId` only reference the audit row.
 * The route allows 10 per user per hour; a 429 reads as the localised
 * rate-limit line, never a raw code. The READ_ONLY_MODE write freeze (PR #392
 * review C1) is main #390's read-only warning, not the generic error.
 *
 * `focusableWhenDisabled` (UX review H2): the button turns unavailable while it
 * holds focus (its own request, or the workspace's save / send), and a native
 * `disabled` would drop focus to `<body>`; `aria-disabled` keeps it, and the
 * handler refuses the click itself.
 */
import { useTransition } from 'react';
import { Loader2Icon, MailCheck } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { isLocale } from '@/i18n/config';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyResponse } from '@/lib/http/read-only-refusal';
import { approvalErrorMessage, readErrorCode } from './approval-error';

export interface TestCopyButtonProps {
  readonly broadcastId: string;
  readonly versionId: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function TestCopyButton({
  broadcastId,
  versionId,
  subject,
  bodyHtml,
  disabled = false,
  className,
}: TestCopyButtonProps): React.ReactElement {
  const t = useTranslations('admin.broadcasts.approval.testCopy');
  const tErrors = useTranslations('admin.broadcasts.approval.errors');
  const readOnlyToast = useReadOnlyToast();
  const locale = useLocale();
  const [pending, startTransition] = useTransition();

  function send(): void {
    if (disabled || pending) return;
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/broadcasts/test-copy', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject,
            bodyHtml,
            locale: isLocale(locale) ? locale : 'en',
            broadcastId,
            versionId,
          }),
        });
        if (res.ok) {
          toast.success(t('sent'));
          return;
        }
        if (await isReadOnlyResponse(res)) {
          readOnlyToast();
          return;
        }
        toast.error(approvalErrorMessage(tErrors, await readErrorCode(res)));
      } catch {
        toast.error(approvalErrorMessage(tErrors, null));
      }
    });
  }

  return (
    <Button
      type="button"
      variant="outline"
      data-testid="eblast-test-copy"
      className={className}
      onClick={send}
      disabled={disabled || pending}
      focusableWhenDisabled
      aria-busy={pending || undefined}
    >
      {pending ? (
        <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        <MailCheck className="size-4" aria-hidden="true" />
      )}
      {t('button')}
    </Button>
  );
}
