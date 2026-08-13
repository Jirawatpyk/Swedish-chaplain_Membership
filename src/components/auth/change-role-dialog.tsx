'use client';

/**
 * ChangeRoleDialog — the 016 PR 3 (US1) staff-role picker.
 *
 * Opened from a per-row "Change role" trigger on the /admin/users table by a
 * viewer who holds `users.manage` (super_admin on the ON leg; admin on the OFF
 * leg — the page/route gate decides, this component only renders the affordance
 * the parent already authorised). Offers all four staff roles —
 * super_admin / admin / manager / marketing (`marketing` joined in PR 4, D17) —
 * with `member` excluded, because a member↔staff move is a portal change rather
 * than a staff-role reassignment; `changeRole.memberHint` says so on screen so
 * the gap does not read as a missing option. The server
 * `POST /api/auth/users/[id]/role` route is the authority; this dialog surfaces
 * its typed refusals as localised inline errors rather than a raw toast:
 *
 *   - last-admin-protection (409) — the tenant would be left with no
 *     administrator. The whole point of US1-AS4; MUST read as guidance
 *     ("promote another Super Admin first"), never an unhandled 500.
 *   - same-role (409) / role-portal-mismatch (400) / forbidden (403) /
 *     not-found (404) / no-session (401) — localised too, each with advice that
 *     fits it. Only 500 falls back to "please try again".
 *
 * Each option carries a one-line summary of what the role grants
 * (`roleSummary.*`, shared with the invite picker), and a PROMOTION to
 * super_admin additionally requires a typed phrase — see `promotingToSuperAdmin`
 * below for why that one transition is heavier than the rest.
 *
 * A11y (ux-standards §6, WCAG 2.1 AA): the picker is a RadioGroup (arrow-key
 * navigable, single-select semantics) with each option's summary wired through
 * `aria-describedby`; confirm is disabled until a DIFFERENT role is chosen (and
 * until the phrase matches, when one is required); `finalFocus` returns focus to
 * a surviving landmark on close because the row trigger unmounts under the
 * success `router.refresh()` (reference: dialog-focus-lost-after-unmount).
 */
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { byDisplayOrder, isRole, type Role } from '@/modules/auth/domain/role';

/**
 * The staff roles a super_admin may assign from the picker. Ordered most→least
 * privileged; `marketing` joined in PR 4 (D17).
 *
 * `member` is deliberately absent: moving someone between the staff and member
 * portals is a different operation from re-ranking a staff member, and the route
 * answers `role-portal-mismatch` for it. The invariant is therefore
 * `ASSIGNABLE_ROLES ∩ STAFF_ROLES` — asserted in
 * `assignable-roles-lockstep.test.ts`, which did not cover this list until PR 4.
 *
 * It is the THIRD of FOUR role lists on this screen — the fourth,
 * `ROLE_VALUES` in `users-filters.tsx`, went unnoticed through PR 3 and PR 4
 * and now derives from `ROLES` instead of being re-typed. Widening the two
 * route zod enums without this one makes a role assignable at the API and
 * unofferable in the UI.
 *
 * Rendered through `byDisplayOrder`, not in the order written here: the
 * lockstep test sorts both sides before comparing, so this literal's order was
 * never asserted and the "both pickers agree" promise held only for invite.
 */
export const CHANGE_ROLE_OPTIONS: readonly Role[] = [
  'super_admin',
  'admin',
  'manager',
  'marketing',
];

/**
 * Error codes the route returns that this dialog localises inline.
 *
 * `forbidden`, `not-found` and `no-session` were missing, so all three fell to
 * the generic "Please try again." — advice that is wrong for each of them.
 * `forbidden` (403) happens for real when a session outlives the operator's own
 * demotion, and retrying can never succeed; `not-found` (404) means the row is
 * gone and the list needs a refresh; `no-session` (401, from
 * `requireApiPermission`) means the session expired mid-dialog — the proxy only
 * redirects on the next NAVIGATION, so the operator sits on a rendered page
 * being told to retry something that cannot succeed until they sign in again.
 *
 * `server-error` (500) is deliberately left on `generic`: "please try again" is
 * the correct advice there.
 */
const KNOWN_ERROR_CODES = [
  'last-admin-protection',
  'same-role',
  'role-portal-mismatch',
  'forbidden',
  'not-found',
  'invalid-role',
  'no-session',
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
  const tSummary = useTranslations('admin.users.roleSummary');
  const locale = useLocale();
  const currentRole = user?.role ?? null;
  // Pre-select the user's current role when it is one of the offered options
  // (so "confirm" stays disabled until the operator actually picks a change);
  // otherwise start unset so any pick is a real change.
  const initialSelected =
    currentRole !== null && CHANGE_ROLE_OPTIONS.includes(currentRole) ? currentRole : null;
  const [selected, setSelected] = useState<Role | null>(initialSelected);
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [typedPhrase, setTypedPhrase] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  // Reset to the pristine per-user state whenever the dialog (re)opens — the
  // parent reuses one dialog instance across rows, so a stale selection/error
  // from a previous row must not leak into the next.
  useEffect(() => {
    if (open) {
      setSelected(initialSelected);
      setErrorCode(null);
      setSubmitting(false);
      setTypedPhrase('');
    }
  }, [open, initialSelected]);

  // One focus move per error, not one per render. See the alert's ref below.
  useEffect(() => {
    if (errorCode !== null) errorRef.current?.focus();
  }, [errorCode]);

  const unchanged = selected === null || selected === currentRole;

  /**
   * Promotion to super_admin is gated on a typed phrase (ux-standards § 6.3 /
   * § 6.4), the same treatment the repo already gives voids, credit notes and
   * archives.
   *
   * Not because the ROLE CHANGE is irreversible — it can be undone — but
   * because what it grants is not: `users.manage`, `audit.read`,
   * `settings.invoicing` and permanent GDPR erasure, plus the ability to demote
   * the person granting it. The product made an operator type "CREDIT" before
   * issuing a reversible credit note while handing out data-erasure rights on a
   * single click; that asymmetry is what this closes. It fires only on a
   * PROMOTION — re-picking a role for someone who is already super_admin, or
   * choosing any other role, stays one click, because friction applied to every
   * option is friction operators learn to type straight through.
   *
   * TWO items of the § 6.4 checklist are deliberately NOT met, so nobody reads
   * the citation as full conformance:
   *  - focus does NOT start on Cancel. This is a picker first; landing focus in
   *    the RadioGroup is what makes arrow-key selection work, and Confirm is
   *    disabled on open anyway, so there is no accidental-confirm to guard.
   *  - Confirm is NOT the destructive variant. A promotion is not a deletion,
   *    and colouring it red would misdescribe it next to genuinely destructive
   *    reds elsewhere in the product.
   */
  // rbac-presentation-only-ok: decides whether to show a warning and demand a
  // typed phrase. The authorization for this action is `users.manage`, checked
  // server-side in POST /api/auth/users/[id]/role.
  const promotingToSuperAdmin = selected === 'super_admin' && currentRole !== 'super_admin';
  const confirmPhrase = t('changeRole.superAdminPhrase');
  // A FIXED ASCII token, identical in all three locales — like
  // `creditNote.confirmPhrase` ("CREDIT"), unlike `issue.confirmPhrase` (which
  // is translated). The repo does both; the deciding factor here is that a Thai
  // operator would otherwise have to switch input method mid-dialog to type a
  // Thai word into a field that then upper-cases it. Compared locale-aware and
  // case-insensitively anyway, mirroring void-confirm-dialog.
  //
  // Considered and NOT chosen: the target's email, which is what
  // void-confirm-dialog uses (the document number) to catch WRONG-ROW mistakes.
  // That risk is real here too — one dialog instance is reused across every row
  // — and the email is already interpolated into the title. It stays on the
  // table if a wrong-promotion ever actually happens.
  const phraseMatches =
    typedPhrase.trim().toLocaleUpperCase(locale) === confirmPhrase.toLocaleUpperCase(locale);
  const phraseBlocking = promotingToSuperAdmin && !phraseMatches;

  async function handleConfirm(): Promise<void> {
    if (unchanged || submitting || selected === null || user === null) return;
    // The typed phrase is checked HERE as well as on the button: `disabled` is a
    // presentation state, and this handler is the only thing between a pick and
    // a POST that grants erasure rights.
    if (phraseBlocking) return;
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
      {/* `max-h` + scroll: AlertDialogContent is `fixed top-1/2 -translate-y-1/2`
          with NO height cap, so content taller than the viewport is clipped at
          BOTH ends with no way to reach it — and this dialog grew from ~380px to
          roughly 1,000px once every option gained a summary and the promotion
          gained a warning + input. `max-w-xs` (320px) on mobile makes the copy
          taller still. Idiom: issue-invoice-dialog.tsx. */}
      <AlertDialogContent finalFocus={finalFocus} className="max-h-[85vh] overflow-y-auto">
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
          {byDisplayOrder(CHANGE_ROLE_OPTIONS).map((r) => (
            <label
              key={r}
              className="flex cursor-pointer items-start gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent/40 has-[[data-checked]]:border-primary"
            >
              {/* Base UI Radio auto-sets its own `aria-labelledby` to a
                  generated (and here dangling) id, which WINS over `aria-label`
                  per ARIA. Point it at our visible label span instead so the
                  accessible name is the role name (WCAG 2.5.3 Label in Name).
                  `aria-describedby` carries the summary, which a screen reader
                  otherwise never reached — before this the option announced a
                  bare role name and nothing about what it grants. */}
              <RadioGroupItem
                value={r}
                disabled={submitting}
                aria-labelledby={`change-role-opt-${r}`}
                // The promotion warning is appended to the DESCRIPTION of the
                // super_admin option: selecting it mounts an amber box and a
                // required field with no announcement of either, so a screen
                // reader user met a disabled Confirm and no stated reason.
                aria-describedby={
                  r === 'super_admin' && promotingToSuperAdmin
                    ? `change-role-desc-${r} change-role-sa-warning`
                    : `change-role-desc-${r}`
                }
                className="mt-0.5"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  <span id={`change-role-opt-${r}`}>{tRole(r)}</span>
                  {r === currentRole ? (
                    <span className="text-xs text-muted-foreground">
                      {t('changeRole.current')}
                    </span>
                  ) : null}
                </span>
                <span id={`change-role-desc-${r}`} className="text-xs text-muted-foreground">
                  {tSummary(r)}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>

        {/* `member` is absent from the options and the reason existed only in a
            source comment: an operator who saw five roles in the invite dialog
            and four here reads it as a bug. */}
        <p className="text-xs text-muted-foreground">{t('changeRole.memberHint')}</p>

        {/* Promotion to super_admin is the one irreversible-in-practice choice
            here — it grants users.manage, audit.read, invoice settings and GDPR
            erasure, and the grantee can immediately demote the grantor. It had
            exactly the same weight as every other pick: one primary button
            labelled "Change role". ux-standards § 6.1 names "Change user role"
            directly; this is the § 6.3 inline warning, short of the typed-phrase
            gate the repo uses for credit notes. */}
        {/* rbac-presentation-only-ok: shows an advisory warning; the server
            gate on this promotion is `users.manage` in the route. */}
        {selected === 'super_admin' && currentRole !== 'super_admin' ? (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-foreground"
            data-testid="super-admin-promotion-warning"
          >
            <p id="change-role-sa-warning">{t('changeRole.superAdminWarning')}</p>
            <div className="mt-2 grid gap-1.5">
              <Label htmlFor="change-role-phrase" className="text-xs font-normal">
                {t('changeRole.superAdminConfirmCopy', { phrase: confirmPhrase })}
              </Label>
              <Input
                id="change-role-phrase"
                value={typedPhrase}
                onChange={(e) => setTypedPhrase(e.target.value)}
                placeholder={confirmPhrase}
                disabled={submitting}
                autoComplete="off"
                // Case-insensitive compare above, so do NOT force uppercase —
                // that fights the keyboard for no gain (idiom: void-confirm-dialog).
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={typedPhrase.length > 0 && !phraseMatches}
                aria-describedby={
                  typedPhrase.length > 0 && !phraseMatches
                    ? 'change-role-phrase-error'
                    : undefined
                }
              />
              {typedPhrase.length > 0 && !phraseMatches ? (
                <p
                  id="change-role-phrase-error"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {t('changeRole.superAdminConfirmMismatch', { phrase: confirmPhrase })}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {errorCode ? (
          <div
            role="alert"
            // Focused ONCE per error, via a ref + effect keyed on `errorCode`
            // (idiom: void-confirm-dialog.tsx). An INLINE `ref={(n) => n?.focus()}`
            // looks equivalent and is not: its identity changes every render, so
            // React detaches and reattaches it on each commit and the focus call
            // fires again. With the phrase field on screen — reachable by
            // picking super_admin, submitting, and having the server refuse —
            // every keystroke bounced focus onto this alert and the next
            // character never landed. Pinned by "keeps focus in the phrase field
            // while typing AFTER a failed attempt".
            ref={errorRef}
            tabIndex={-1}
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive outline-none"
          >
            {t(`changeRole.errors.${resolveErrorKey(errorCode)}`)}
          </div>
        ) : null}

        {/* Confirm is disabled until a DIFFERENT role is picked, which on open
            is always — so the dialog presented a dead primary button with no
            statement of what would revive it. */}
        {unchanged && errorCode === null ? (
          <p className="text-xs text-muted-foreground">{t('changeRole.pickDifferent')}</p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          {/* `user === null` is folded into the gate so the "open with no
              target" state (representable because `user` and `open` are
              independent props) cannot present an enabled Confirm whose handler
              then early-returns in silence — review Suggestion #11. */}
          {/* No `aria-disabled` alongside `disabled`: a disabled button is out
              of the tab order, so the ARIA attribute is never announced and
              only suggests the two could disagree. */}
          <AlertDialogAction
            disabled={user === null || unchanged || submitting || phraseBlocking}
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
