/**
 * F8 Phase 8 T222 — `<ReassignTaskDropdown>` AlertDialog + combobox.
 *
 * Admin reassigns task ownership. Lazy-loads active staff users from
 * `/api/admin/users/staff-active` on dialog open. Combobox via `cmdk`
 * (already in deps for F2 command palette). Submit button disabled
 * until a user is selected.
 *
 * R6 HV-3 close — migrated to the shared `<TaskActionDialog>` shell
 * (Round 5 HV-1). Removes ~40 LOC of duplicated AlertDialog scaffold
 * + footer (Cancel / Confirm / spinner / aria-busy) so this dialog
 * benefits from the same a11y-and-spinner consolidation as Done +
 * Skip dialogs.
 */
'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import { Alert, Button, Combobox, type ComboboxOption } from '@jirawatpyk/aura-react';
import { TaskActionDialog } from './task-action-dialog';

/**
 * Round 5 I-6 close — runtime-shape validation prevents a silently
 * empty combobox when the API response shape drifts (partial deploy,
 * proxy injection of an HTML error page, future RBAC tightening that
 * returns `{error:{}}` with status 200, etc.). zod is already in the
 * client bundle (form validation) — incremental cost is zero.
 */
const staffUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  // 016 review I3 — MUST stay in lockstep with the roles
  // `GET /api/admin/users/staff-active` actually queries. That route was
  // widened to include `super_admin` (Migration C promotes every human admin),
  // and this schema parses the WHOLE response: one unexpected role value made
  // `safeParse` fail, which set `loadError` and killed the reassign combobox
  // for every staff user, not just for the super_admin row.
  role: z.enum(['super_admin', 'admin', 'manager']),
});

const staffActiveResponseSchema = z.object({
  users: z.array(staffUserSchema),
});

type StaffUser = z.infer<typeof staffUserSchema>;

export interface ReassignTaskDropdownProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly currentAssigneeUserId: string | null;
  readonly onSubmit: (toUserId: string) => Promise<void>;
  /** UX-audit PR-A #5a — focus-return resolver; forwarded to the shared shell. */
  readonly finalFocus?: (() => HTMLElement | null) | undefined;
}

export function ReassignTaskDropdown({
  open,
  onOpenChange,
  currentAssigneeUserId,
  onSubmit,
  finalFocus,
}: ReassignTaskDropdownProps) {
  const t = useTranslations('admin.renewals.tasks.reassign_dialog');
  // UX-audit PR-A #5b — the staff-role suffix reuses the shared assigneeRole
  // keys (same copy the queue's assignee cell renders) instead of printing the
  // raw enum ('admin'/'manager').
  const tRole = useTranslations('admin.renewals.tasks');
  const [users, setUsers] = useState<ReadonlyArray<StaffUser> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  /**
   * R8 R4-C1 close — retry-counter forces the lazy-load effect to
   * re-run when the user clicks Retry. The previous shape relied on
   * `users` flipping null→null which React skipped (state-set bail-
   * out → effect deps unchanged → fetch never re-fired). Now Retry
   * does `setRetryToken(t => t + 1)` and the effect deps include
   * the counter so the next render re-runs the fetch.
   */
  const [retryToken, setRetryToken] = useState(0);

  // Lazy-load active staff users on open.
  useEffect(() => {
    if (!open) return;
    if (users !== null) return;
    let cancelled = false;
    setIsLoadingUsers(true);
    (async () => {
      try {
        const res = await fetch('/api/admin/users/staff-active', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          if (!cancelled) setLoadError(true);
          return;
        }
        const parsed = staffActiveResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          if (typeof console !== 'undefined') {
            console.warn(
              '[reassign-task-dropdown] staff-active response shape drift',
              parsed.error.flatten(),
            );
          }
          if (!cancelled) setLoadError(true);
          return;
        }
        if (!cancelled) setUsers(parsed.data.users);
      } catch (e) {
        if (typeof console !== 'undefined') {
          console.warn('[reassign-task-dropdown] staff-active fetch failed', e);
        }
        if (!cancelled) setLoadError(true);
      } finally {
        if (!cancelled) setIsLoadingUsers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, users, retryToken]);

  function handleSubmit(): void {
    if (selectedUserId === null) return;
    startTransition(async () => {
      await onSubmit(selectedUserId);
    });
  }

  // 122 US7b-2 (T734) — AURA's Combobox searches the label, the description
  // and the keywords. The current assignee is marked and cannot be picked:
  // reassigning to them is a no-op the confirm already refused.
  const options: ComboboxOption[] = (users ?? []).map((u) => {
    const current = u.id === currentAssigneeUserId;
    return {
      value: u.id,
      label: u.display_name ?? u.email,
      description: [
        ...(u.display_name !== null ? [u.email] : []),
        tRole(`assigneeRole.${u.role}`),
        ...(current ? [t('current_assignee_badge')] : []),
      ].join(' · '),
      keywords: [u.email],
      disabled: current,
    };
  });
  const canSubmit =
    selectedUserId !== null && selectedUserId !== currentAssigneeUserId;

  return (
    <TaskActionDialog
      open={open}
      onOpenChange={onOpenChange}
      onClose={() => {
        setSelectedUserId(null);
        // R8 close — also reset error/retry state so a re-open
        // after a fetch error gets a fresh attempt.
        setLoadError(false);
        setRetryToken(0);
      }}
      title={t('title')}
      description={t('description')}
      cancelLabel={t('cancel')}
      confirmLabel={t('confirm')}
      submittingLabel={t('submitting')}
      isPending={isPending}
      canSubmit={canSubmit}
      onSubmit={handleSubmit}
      finalFocus={finalFocus}
    >
      {loadError ? (
        // An alert, so a screen reader hears the failure where the picker was.
        <Alert
          tone="danger"
          role="alert"
          action={
            <Button
              size="sm"
              variant="secondary"
              loading={isLoadingUsers}
              onClick={() => {
                setLoadError(false);
                setUsers(null);
                setRetryToken((n) => n + 1);
              }}
            >
              {t('retry')}
            </Button>
          }
        >
          {t('load_error')}
        </Alert>
      ) : (
        <Combobox
          label={t('assignee_label')}
          options={options}
          value={selectedUserId}
          onChange={setSelectedUserId}
          placeholder={isLoadingUsers ? t('loading') : t('placeholder')}
          loading={isLoadingUsers}
          loadingText={t('loading')}
          emptyText={t('no_results')}
          disabled={isPending || users === null}
        />
      )}
    </TaskActionDialog>
  );
}
