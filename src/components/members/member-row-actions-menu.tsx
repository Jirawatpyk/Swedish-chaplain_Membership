'use client';

/**
 * #5 members-ux — per-row "⋯" overflow menu of single-member actions, so an
 * admin no longer has to tick the row + travel to the bulk bar for a one-member
 * action. Mirrors the row-⋯ pattern in
 * `admin/invoices/_components/invoice-more-menu.tsx`. Lives beside the other
 * per-member action components (`invite-portal-button`, `archive-member-button`).
 *
 * Items (admin-only — the column is gated on `enableSelection` in members-table):
 *   - Invite to portal   — only when the primary contact needs an invite
 *   - Send renewal reminder (#4 nudge) — reuses the shipped bulk endpoint with 1 id
 *   - View invoices / Benefits — navigation
 *   - Archive (+ confirm & reason & 10s Undo)  OR  Restore (archived rows)
 *
 * Each action reuses an EXISTING endpoint + its localized copy — no new server
 * code. The archive confirm dialog is rendered as a sibling of the menu (not
 * inside a menu item) so the menu→dialog focus hand-off is clean, and its
 * `finalFocus` is resolved via `resolveDialogFinalFocus` so focus returns to the
 * ⋯ trigger on cancel/Esc but lands on `#main-content` after a successful
 * archive (the row — and its trigger — unmounts). This repo's documented
 * focus-loss class.
 */

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArchiveIcon,
  BellIcon,
  FileTextIcon,
  GiftIcon,
  Loader2Icon,
  MailPlusIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';

type MemberStatus = 'active' | 'inactive' | 'archived';
type PortalStateValue =
  | 'active'
  | 'invited'
  | 'invite_expired'
  | 'not_invited'
  | 'unknown';

export interface MemberRowActionsMenuProps {
  readonly memberId: string;
  readonly companyName: string;
  readonly status: MemberStatus;
  readonly portalState: PortalStateValue | null;
  readonly primaryContact: { readonly contactId: string; readonly email: string } | null;
}

export function MemberRowActionsMenu({
  memberId,
  companyName,
  status,
  portalState,
  primaryContact,
}: MemberRowActionsMenuProps) {
  const t = useTranslations('admin.members.rowActions');
  const tInvite = useTranslations('admin.members.invitePortal');
  const tArchive = useTranslations('admin.members.archive');
  const router = useRouter();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Raised right before the SUCCESS close so the focus resolver skips the ⋯
  // trigger — an archive drops the row off the default (active/inactive) list,
  // unmounting the trigger, so returning to it would drop focus to <body>.
  const closedViaSuccessRef = useRef(false);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [archiving, setArchiving] = useState(false);

  // Focus-return on dialog close (WCAG 2.4.3, repo focus-loss class): the ⋯
  // trigger on cancel/Esc; the #main-content landmark after a successful archive
  // (trigger about to unmount).
  const finalFocus = useCallback(
    () =>
      resolveDialogFinalFocus({
        closedViaSuccess: closedViaSuccessRef.current,
        trigger: triggerRef.current,
        fallback: null,
        mainContent:
          typeof document !== 'undefined'
            ? document.getElementById('main-content')
            : null,
      }),
    [],
  );

  const isArchived = status === 'archived';
  const needsInvite =
    !isArchived &&
    Boolean(primaryContact?.email) &&
    (portalState === 'not_invited' || portalState === 'invite_expired');

  const idempotency = () => ({
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  });

  // --- Invite (reuses invite-portal-button.tsx logic + admin.members.invitePortal) ---
  const handleInvite = useCallback(async () => {
    if (!primaryContact) return;
    const loadingId = toast.loading(tInvite('submitting'));
    try {
      const res = await fetch(
        `/api/members/${encodeURIComponent(memberId)}/contacts/${encodeURIComponent(primaryContact.contactId)}/invite-portal`,
        { method: 'POST' },
      );
      if (res.ok) {
        toast.success(tInvite('success'));
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      // The invite route returns snake_case codes (already_linked, email_taken,
      // invalid_email, contact_removed, not_found, link_failed) but the
      // invitePortal.errors.* keys are camelCase — convert before lookup so a
      // specific error isn't silently degraded to the generic toast (parity with
      // invite-portal-button.tsx's explicit switch).
      const code = body.error?.code;
      const key =
        typeof code === 'string'
          ? `errors.${code.replace(/_(.)/g, (_m, c: string) => c.toUpperCase())}`
          : null;
      toast.error(key && tInvite.has(key) ? tInvite(key) : tInvite('errors.serverError'));
    } catch {
      toast.error(tInvite('errors.serverError'));
    } finally {
      toast.dismiss(loadingId);
    }
  }, [memberId, primaryContact, router, tInvite]);

  // --- Send renewal reminder (#4 nudge — reuses the shipped bulk endpoint) ---
  const handleReminder = useCallback(async () => {
    const loadingId = toast.loading(t('reminderSending'));
    try {
      const res = await fetch('/api/members/bulk', {
        method: 'POST',
        headers: idempotency(),
        body: JSON.stringify({
          action: 'send_renewal_reminder',
          member_ids: [memberId],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        counts?: { sent: number; skipped: number; failed: number };
      };
      if (res.status === 429) {
        toast.error(t('rateLimited'));
        return;
      }
      if (!res.ok) {
        toast.error(t('reminderFailed'));
        return;
      }
      const c = body.counts ?? { sent: 0, skipped: 0, failed: 0 };
      if (c.failed > 0) toast.error(t('reminderFailed'));
      else if (c.sent > 0) toast.success(t('reminderSent'));
      // A single member with no step due / no cycle / opted out — clearer than
      // the bulk "1 skipped".
      else toast.info(t('reminderNoneDue', { company: companyName }));
      router.refresh();
    } catch {
      toast.error(t('reminderFailed'));
    } finally {
      toast.dismiss(loadingId);
    }
  }, [memberId, companyName, router, t]);

  // --- Restore / Undo (POST /undelete) ---
  const undelete = useCallback(async () => {
    const res = await fetch(`/api/members/${encodeURIComponent(memberId)}/undelete`, {
      method: 'POST',
      headers: idempotency(),
    });
    if (res.ok) {
      toast.success(t('restoreSuccess', { company: companyName }));
      // Restoring drops the row out of an archived-only view → the ⋯ trigger
      // unmounts; move focus to the #main-content landmark first so it doesn't
      // fall to <body> (WCAG 2.4.3), mirroring the archive dialog's finalFocus.
      document.getElementById('main-content')?.focus();
      router.refresh();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      error?: { code?: string };
    };
    toast.error(
      body.error?.code === 'archive_window_expired'
        ? t('restoreWindowExpired')
        : t('restoreError'),
    );
  }, [memberId, companyName, router, t]);

  const handleRestore = useCallback(async () => {
    const loadingId = toast.loading(t('restoreSending'));
    try {
      await undelete();
    } catch {
      toast.error(t('restoreError'));
    } finally {
      toast.dismiss(loadingId);
    }
  }, [undelete, t]);

  // --- Archive (reuses archive-member-button.tsx logic + admin.members.archive) ---
  const handleArchiveConfirm = useCallback(async () => {
    setArchiving(true);
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(memberId)}/archive`, {
        method: 'POST',
        headers: idempotency(),
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      if (res.ok) {
        closedViaSuccessRef.current = true;
        // 10s Undo (ux-patterns §2.3) — restores the member via /undelete,
        // matching the bulk-archive Undo shipped in #256.
        toast.success(tArchive('archiveSuccess', { companyName }), {
          duration: 10_000,
          action: { label: t('undo'), onClick: () => void undelete() },
        });
        setArchiveOpen(false);
        setReason('');
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string };
      };
      toast.error(
        body.error?.code === 'state_error'
          ? tArchive('archiveAlreadyArchived')
          : body.error?.code === 'not_found'
            ? tArchive('archiveNotFound')
            : tArchive('archiveError'),
      );
    } catch {
      toast.error(tArchive('archiveError'));
    } finally {
      setArchiving(false);
    }
  }, [memberId, reason, companyName, router, t, tArchive, undelete]);

  const handleArchiveOpenChange = useCallback((next: boolean) => {
    if (next) {
      // Defense: a fresh open must never inherit a stale success flag (which
      // would skip the focus-return-to-trigger). The only opener today also
      // resets it, but any future opener stays safe.
      closedViaSuccessRef.current = false;
    } else {
      setReason('');
      setArchiving(false);
    }
    setArchiveOpen(next);
  }, []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={(props) => (
            <Button
              {...props}
              ref={triggerRef}
              variant="ghost"
              size="icon"
              aria-label={t('moreAria', { company: companyName })}
            >
              <MoreHorizontalIcon aria-hidden="true" />
            </Button>
          )}
        />
        <DropdownMenuContent align="end" className="min-w-56 whitespace-nowrap">
          {needsInvite && (
            <DropdownMenuItem onClick={handleInvite}>
              <MailPlusIcon aria-hidden="true" />
              {t('invite')}
            </DropdownMenuItem>
          )}
          {!isArchived && (
            <DropdownMenuItem onClick={handleReminder}>
              <BellIcon aria-hidden="true" />
              {t('sendReminder')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            render={<Link href={`/admin/members/${memberId}#invoices`} />}
          >
            <FileTextIcon aria-hidden="true" />
            {t('viewInvoices')}
          </DropdownMenuItem>
          <DropdownMenuItem
            render={<Link href={`/admin/members/${memberId}/benefits`} />}
          >
            <GiftIcon aria-hidden="true" />
            {t('benefits')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isArchived ? (
            <DropdownMenuItem onClick={handleRestore}>
              <RotateCcwIcon aria-hidden="true" />
              {t('restore')}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => {
                closedViaSuccessRef.current = false;
                setArchiveOpen(true);
              }}
            >
              <ArchiveIcon aria-hidden="true" />
              {t('archive')}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={archiveOpen} onOpenChange={handleArchiveOpenChange}>
        <AlertDialogContent finalFocus={finalFocus} initialFocus={cancelRef}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tArchive('confirmTitle', { companyName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tArchive('confirmDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`archive-reason-${memberId}`} className="text-sm">
              {tArchive('reasonLabel')}
            </Label>
            <Textarea
              id={`archive-reason-${memberId}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder={tArchive('reasonPlaceholder')}
              rows={3}
            />
            <p className="text-xs text-muted-foreground">{tArchive('reasonHelper')}</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRef} disabled={archiving}>
              {tArchive('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleArchiveConfirm();
              }}
              disabled={archiving}
              aria-busy={archiving}
              className={buttonVariants({ variant: 'destructive' })}
            >
              {archiving && (
                <Loader2Icon
                  className="size-4 motion-safe:animate-spin"
                  aria-hidden="true"
                />
              )}
              {archiving ? tArchive('archivingInProgress') : tArchive('confirmCta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
