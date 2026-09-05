'use client';

/**
 * T141 — ArchivedBanner (US7).
 *
 * Shown on the member detail page when `status === 'archived'`. Renders:
 *   - "Archived on {archivedAt}" heading + descriptive copy
 *   - "Undelete" CTA when within the 90-day window; disabled button +
 *     tooltip when beyond 90 days (FR-005 AS3).
 *
 * Uses the Domain `archiveWindowStatus` policy computed server-side and
 * passed as props — the component itself is presentational only.
 */

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { toast } from 'sonner';
import { ArchiveRestoreIcon, AlertTriangleIcon } from 'lucide-react';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  RestorePrimaryDialog,
  type DesignatableContact,
  type RestorePrimaryNotice,
} from '@/components/members/restore-primary-dialog';

/** The 409 `no_primary_contact` payload shape (snake_case on the wire). */
type NoPrimaryDetails = {
  readonly designatable?: ReadonlyArray<{
    readonly contact_id: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly email: string;
  }>;
};

type ArchiveWindow =
  | { state: 'within_window'; daysRemaining: number }
  | { state: 'window_expired'; daysSinceArchive: number };

type Props = {
  readonly memberId: string;
  readonly archivedAtIso: string;
  readonly windowStatus: ArchiveWindow;
};

export function ArchivedBanner({
  memberId,
  archivedAtIso,
  windowStatus,
}: Props) {
  const t = useTranslations('admin.members.archive');
  const tD = useTranslations('admin.members.undelete.designate');
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  // 108 FR-014 — the designate dialog. Mounted as ONE sibling instance
  // (below the Card) and driven by state, so Base UI runs its close cycle and
  // `finalFocus` lands back on the Restore button.
  const [designateOpen, setDesignateOpen] = useState(false);
  const [designatable, setDesignatable] = useState<ReadonlyArray<DesignatableContact>>([]);
  const [notice, setNotice] = useState<RestorePrimaryNotice | null>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  // Set the moment a restore SUCCEEDS. `router.refresh()` then re-renders the
  // server tree and this whole banner unmounts, so returning focus to the
  // Restore button would drop it on <body> (memory: dialog-focus-lost-after-
  // unmount — axe never catches it; the T040 e2e did). On success focus goes
  // to the staff layout's #main-content landmark, which survives; on cancel,
  // to the button that opened the dialog.
  const restoredRef = useRef(false);
  const dialogFinalFocus = () => {
    if (typeof document === 'undefined') return null;
    const landmark = document.getElementById('main-content');
    return restoredRef.current ? landmark : (restoreButtonRef.current ?? landmark);
  };

  const canUndelete = windowStatus.state === 'within_window';

  /**
   * One request per click, each under a FRESH Idempotency-Key: a 409
   * `no_primary_contact` is a question the server deliberately does not
   * remember, and re-sending the answer under the first key with a different
   * body would be an idempotency conflict.
   */
  async function handleUndelete(designatePrimaryContactId?: string) {
    setLoading(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const res = await fetch(`/api/members/${memberId}/undelete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        ...(designatePrimaryContactId === undefined
          ? {}
          : {
              body: JSON.stringify({
                designate_primary_contact_id: designatePrimaryContactId,
              }),
            }),
      });
      if (res.ok) {
        restoredRef.current = true;
        // The SERVER says whether anyone was designated — a primary can
        // appear between the 409 and the retry, in which case the call sent a
        // designation and nothing was set (T041 reliability review, L4c).
        const body = (await res.json().catch(() => ({}))) as {
          designated_primary_contact_id?: string | null;
        };
        const designated =
          typeof body.designated_primary_contact_id === 'string' &&
          body.designated_primary_contact_id.length > 0;
        toast.success(designated ? tD('successDesignated') : t('undeleteSuccess'));
        if (designateOpen) {
          // Close first; the refresh runs from `onCloseComplete` so the
          // dialog's close cycle (and `finalFocus`) finishes BEFORE the server
          // tree re-renders and this banner unmounts (T041 UX review, M8).
          setDesignateOpen(false);
        } else {
          // The plain-restore path never opened the dialog, so no close
          // cycle will move focus — move it to the surviving landmark here
          // before the refresh unmounts this banner.
          document.getElementById('main-content')?.focus();
          startTransition(() => {
            router.refresh();
          });
        }
      } else {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; details?: NoPrimaryDetails };
        };
        const code = data.error?.code ?? 'server_error';
        // Map the server error CODE to localized copy — never render the
        // server's raw English `error.message`.
        if (code === 'no_primary_contact') {
          // Not an error to toast about on the first pass — it is the
          // question the dialog asks. On a SECOND pass (the chosen contact
          // vanished under us) say so INSIDE the dialog — a toast would sit
          // behind the modal's aria-hidden (T041 UX review, H1) — and offer
          // the fresh list.
          const list = (data.error?.details?.designatable ?? []).map((c) => ({
            contactId: c.contact_id,
            firstName: c.first_name,
            lastName: c.last_name,
            email: c.email,
          }));
          setDesignatable(list);
          setNotice(
            designatePrimaryContactId === undefined
              ? null
              : list.length === 0
                ? 'contact_gone_none'
                : 'contact_gone',
          );
          setDesignateOpen(true);
        } else if (code === 'archive_window_expired') {
          toast.error(t('windowExpiredToast'));
        } else if (code === 'state_error') {
          toast.error(t('undeleteNotArchived'));
        } else if (code === 'not_found') {
          toast.error(t('undeleteNotFound'));
        } else {
          toast.error(t('undeleteError'));
        }
      }
    } catch {
      toast.error(t('undeleteError'));
    } finally {
      setLoading(false);
    }
  }

  // R007 (staff-review-20260417-us7) — Thai Buddhist Era display for
  // th-TH per CLAUDE.md "BE = CE + 543 is display-only for th-TH".
  // Same BCP47 pattern as src/lib/relative-time.ts:73 (`-u-ca-buddhist`
  // extension). Storage remains Gregorian ISO; this is pure display.
  const archivedDate = new Date(archivedAtIso);
  let isoDate: string;
  try {
    isoDate = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      // Hydration safety (2026-07-31 #418 incident class): pin Bangkok so
      // SSR (UTC server) and hydration (browser) agree on the calendar
      // day — see format-date-localised.ts's timezone-default doc.
      timeZone: 'Asia/Bangkok',
    }).format(archivedDate);
  } catch {
    isoDate = archivedDate.toISOString().slice(0, 10);
  }
  const disabled = loading || isPending;

  return (
    <>
    <Card className="border-destructive/40 bg-destructive/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <AlertTriangleIcon
            className="mt-0.5 size-5 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold">
              {t('bannerTitle', { date: isoDate })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {windowStatus.state === 'within_window'
                ? t('withinWindow', {
                    daysRemaining: windowStatus.daysRemaining,
                  })
                : t('windowExpired', {
                    daysSinceArchive: windowStatus.daysSinceArchive,
                  })}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center">
          {canUndelete ? (
            <Button
              ref={restoreButtonRef}
              variant="outline"
              size="sm"
              onClick={() => void handleUndelete()}
              disabled={disabled}
              aria-label={t('undeleteCta')}
            >
              <ArchiveRestoreIcon className="size-4" />
              {t('undeleteCta')}
            </Button>
          ) : (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger className="inline-flex">
                  <span
                    aria-disabled="true"
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm text-muted-foreground opacity-50"
                    aria-label={t('undeleteCta')}
                  >
                    <ArchiveRestoreIcon className="size-4" aria-hidden="true" />
                    {t('undeleteCta')}
                  </span>
                </TooltipTrigger>
                <TooltipContent>{t('windowExpiredTooltip')}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
    </Card>
    <RestorePrimaryDialog
      open={designateOpen}
      onOpenChange={(next) => {
        setDesignateOpen(next);
        if (!next) setNotice(null);
      }}
      onCloseComplete={() => {
        if (!restoredRef.current) return;
        startTransition(() => {
          router.refresh();
        });
      }}
      memberId={memberId}
      designatable={designatable}
      notice={notice}
      onConfirm={(contactId) => void handleUndelete(contactId)}
      // The zero-contacts door: `addContact` made the new contact the
      // primary, so restoring again — in place, no click hunting — succeeds.
      onContactAdded={() => void handleUndelete()}
      submitting={loading}
      finalFocus={dialogFinalFocus}
    />
    </>
  );
}
