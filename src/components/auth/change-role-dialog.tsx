'use client';

/**
 * ChangeRoleDialog — the 016 PR 3 (US1) staff-role picker.
 *
 * Opened from a per-row "Change role" trigger on the /admin/users table by a
 * viewer who holds `users.manage` (super_admin on the ON leg; admin on the OFF
 * leg — the page/route gate decides, this component only renders the affordance
 * the parent already authorised). Offers exactly the three staff roles the
 * design assigns in PR 3 — super_admin / admin / manager — with `marketing`
 * held back to PR 4 (design §9 / D17) and `member` excluded (a member↔staff
 * move is a portal change, not a staff-role reassignment). The server
 * `POST /api/auth/users/[id]/role` route is the authority; this dialog surfaces
 * its typed refusals as localised inline errors rather than a raw toast:
 *
 *   - last-admin-protection (409) — the tenant would be left with no
 *     administrator. The whole point of US1-AS4; MUST read as guidance
 *     ("promote another Super Admin first"), never an unhandled 500.
 *   - same-role (409) / role-portal-mismatch (400) — localised too.
 *
 * A11y (ux-standards §6, WCAG 2.1 AA): the picker is a RadioGroup (arrow-key
 * navigable, single-select semantics); confirm is disabled until a DIFFERENT
 * role is chosen; `finalFocus` returns focus to a surviving landmark on close
 * because the row trigger unmounts under the success `router.refresh()`
 * (reference: dialog-focus-lost-after-unmount).
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { isRole, type Role } from '@/modules/auth/domain/role';

/**
 * The staff roles a super_admin may assign from the picker. Ordered most→least
 * privileged; `marketing` joined in PR 4 (D17).
 *
 * `member` is deliberately absent: moving someone between the staff and member
 * portals is a different operation from re-ranking a staff member, and the route
 * answers `role-portal-mismatch` for it. The invariant is therefore
 * `ASSIGNABLE_ROLES ∩ STAFF_ROLES` — asserted in
 * `assignable-roles-lockstep.test.ts`, which did not cover this list until PR 4.
 * It is the THIRD role list; widening the two route zod enums without this one
 * makes a role assignable at the API and unofferable in the UI.
 */
export const CHANGE_ROLE_OPTIONS: readonly Role[] = [
  'super_admin',
  'admin',
  'manager',
  'marketing',
];

/** Error codes the route returns that this dialog localises inline. */
const KNOWN_ERROR_CODES = [
  'last-admin-protection',
  'same-role',
  'role-portal-mismatch',
] as const;

function resolveErrorKey(code: string): (typeof KNOWN_ERROR_CODES)[number] | 'generic' {
  return (KNOWN_ERROR_CODES as readonly string[]).includes(code)
    ? (code as (typeof KNOWN_ERROR_CODES)[number])
    : 'generic';
}

export interface ChangeRoleDialogProps {
  /**
   * The target row, or `null` while the dialog sits closed. The parent mounts
   * ONE instance unconditionally (so Base UI runs its close cycle + `finalFocus`
   * — 016 UX review C1) and retains the last user through the close animation,
   * so every user access here is null-guarded for the brief closed/idle window.
   */
  readonly user: { readonly id: string; readonly email: string; readonly role: Role } | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Called after a successful role change (parent runs `router.refresh()`). */
  readonly onChanged: () => void;
  /** Focus-return target on close (parent supplies a surviving landmark). */
  readonly finalFocus?: () => HTMLElement | null;
}

export function ChangeRoleDialog({
  user,
  open,
  onOpenChange,
  onChanged,
  finalFocus,
}: ChangeRoleDialogProps) {
  const t = useTranslations('admin.users');
  const tRole = useTranslations('admin.users.filters.role');
  const currentRole = user?.role ?? null;
  // Pre-select the user's current role when it is one of the offered options
  // (so "confirm" stays disabled until the operator actually picks a change);
  // otherwise start unset so any pick is a real change.
  const initialSelected =
    currentRole !== null && CHANGE_ROLE_OPTIONS.includes(currentRole) ? currentRole : null;
  const [selected, setSelected] = useState<Role | null>(initialSelected);
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Reset to the pristine per-user state whenever the dialog (re)opens — the
  // parent reuses one dialog instance across rows, so a stale selection/error
  // from a previous row must not leak into the next.
  useEffect(() => {
    if (open) {
      setSelected(initialSelected);
      setErrorCode(null);
      setSubmitting(false);
    }
  }, [open, initialSelected]);

  const unchanged = selected === null || selected === currentRole;

  async function handleConfirm(): Promise<void> {
    if (unchanged || submitting || selected === null || user === null) return;
    setSubmitting(true);
    setErrorCode(null);
    try {
      const response = await fetch(`/api/auth/users/${user.id}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRole: selected }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setErrorCode(body.error ?? 'generic');
        return;
      }
      toast.success(
        t('toast.roleChanged', { email: user.email, role: tRole(selected) }),
      );
      onChanged();
      onOpenChange(false);
    } catch {
      setErrorCode('generic');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {/* No `initialFocus` on Cancel — this is a picker, not a destructive
          confirm. Confirm is disabled until a DIFFERENT role is chosen, so
          there is no accidental-confirm risk to guard; letting Base UI land
          focus in the RadioGroup makes arrow-key selection work immediately
          (016 UX review I1; ux-standards §6 form vs confirmation focus). */}
      <AlertDialogContent finalFocus={finalFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('changeRole.title', { email: user?.email ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('changeRole.description')}</AlertDialogDescription>
        </AlertDialogHeader>

        <RadioGroup
          aria-label={t('changeRole.roleLabel')}
          value={selected ?? ''}
          onValueChange={(next) => {
            if (typeof next === 'string' && isRole(next)) {
              setErrorCode(null);
              setSelected(next);
            }
          }}
        >
          {CHANGE_ROLE_OPTIONS.map((r) => (
            <label
              key={r}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent/40 has-[[data-checked]]:border-primary"
            >
              {/* Base UI Radio auto-sets its own `aria-labelledby` to a
                  generated (and here dangling) id, which WINS over `aria-label`
                  per ARIA. Point it at our visible label span instead so the
                  accessible name is the role name (WCAG 2.5.3 Label in Name). */}
              <RadioGroupItem
                value={r}
                disabled={submitting}
                aria-labelledby={`change-role-opt-${r}`}
              />
              <span id={`change-role-opt-${r}`}>{tRole(r)}</span>
              {r === currentRole ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  {t('changeRole.current')}
                </span>
              ) : null}
            </label>
          ))}
        </RadioGroup>

        {errorCode ? (
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
          >
            {t(`changeRole.errors.${resolveErrorKey(errorCode)}`)}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          {/* `user === null` is folded into the gate so the "open with no
              target" state (representable because `user` and `open` are
              independent props) cannot present an enabled Confirm whose handler
              then early-returns in silence — review Suggestion #11. */}
          <AlertDialogAction
            disabled={user === null || unchanged || submitting}
            aria-disabled={user === null || unchanged || submitting || undefined}
            onClick={(event) => {
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {submitting ? (
              <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
            ) : null}
            {t('changeRole.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
