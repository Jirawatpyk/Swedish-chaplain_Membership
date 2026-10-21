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
 * A11y (ux-standards §6, WCAG 2.1 AA): the picker is AURA's RadioGroup (a
 * fieldset of native radios, arrow-key navigable) with each option's summary
 * read after its name; confirm is disabled until a DIFFERENT role is chosen (and
 * until the phrase matches, when one is required); `finalFocus` returns focus to
 * a surviving landmark on close because the row trigger unmounts under the
 * success `router.refresh()` (reference: dialog-focus-lost-after-unmount).
 */
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { Alert, Button, Dialog, RadioGroup, TextField } from '@jirawatpyk/aura-react';
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
 *
 * Reachability (016 polish, S4): `invalid-role` is defence-only — this dialog
 * only ever submits a member of `CHANGE_ROLE_OPTIONS`, all inside the route's
 * zod enum, so the branch fires only if the two lists ever drift. `same-role`
 * and `role-portal-mismatch` are reachable ONLY through a stale row (another
 * operator changed the target after this page rendered). All three stay: the
 * copy is already localised and a defensive branch that can name its trigger
 * beats a generic fallback. `invalid-input` (400, body-not-JSON) was the
 * OPPOSITE gap — a real route response with no key, mislabelled by the generic
 * "please try again"; it now has its own copy.
 */
const KNOWN_ERROR_CODES = [
  'last-admin-protection',
  'same-role',
  'role-portal-mismatch',
  'forbidden',
  'not-found',
  'invalid-role',
  'no-session',
  'invalid-input',
] as const;

function resolveErrorKey(code: string): (typeof KNOWN_ERROR_CODES)[number] | 'generic' {
  return (KNOWN_ERROR_CODES as readonly string[]).includes(code)
    ? (code as (typeof KNOWN_ERROR_CODES)[number])
    : 'generic';
}

/**
 * Codes where re-clicking Confirm with the SAME selection can never succeed
 * (016 polish, S-10): the stale-row pair needs a refreshed list, `forbidden`
 * needs a different OPERATOR, and the two `invalid-*` codes need a code fix.
 * While one of these is on screen Confirm is disabled; picking a different
 * role clears the error (the RadioGroup's onValueChange) and revives it.
 *
 * Deliberately ABSENT — codes whose own copy tells the operator to fix the
 * precondition and RETRY, which a dead Confirm would contradict (UX review):
 *  - `last-admin-protection`: promote another super_admin in a second tab,
 *    then legitimately retry this exact change;
 *  - `no-session`: its copy says "sign in again, then retry" — cookies are
 *    tab-shared, so a second-tab sign-in makes this exact POST succeed;
 *  - the retryable pair (`server-error`/network → `generic`), where "try
 *    again" is the advice.
 */
const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'same-role',
  'role-portal-mismatch',
  'forbidden',
  'not-found',
  'invalid-role',
  'invalid-input',
]);

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
  readonly finalFocus?: () => HTMLElement | false | null;
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
  // In-flight POST guard (016 polish, S-9 — idiom: relink-registration-dialog).
  // The parent reuses ONE dialog instance forever, so a response that resolves
  // after close would otherwise repaint the NEXT row's dialog with THIS row's
  // outcome, and a late success would force-close a dialog the operator has
  // since reopened. Closing aborts; every await below re-checks the signal.
  const abortRef = useRef<AbortController | null>(null);

  // Reset to the pristine per-user state whenever the dialog (re)opens — the
  // parent reuses one dialog instance across rows, so a stale selection/error
  // from a previous row must not leak into the next. Closing aborts any
  // in-flight POST for the same reason (S-9). Note the abort does NOT undo a
  // change the server may already have committed — the next refresh shows the
  // truth; what it prevents is this component acting on a stale response.
  useEffect(() => {
    if (open) {
      setSelected(initialSelected);
      setErrorCode(null);
      setSubmitting(false);
      setTypedPhrase('');
    } else {
      abortRef.current?.abort();
    }
  }, [open, initialSelected]);

  // Unmount safety net (the parent never unmounts this today, but the abort
  // must not depend on that staying true).
  useEffect(() => () => abortRef.current?.abort(), []);

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
    const controller = new AbortController();
    abortRef.current = controller;
    setSubmitting(true);
    setErrorCode(null);
    try {
      const response = await fetch(`/api/auth/users/${user.id}/role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newRole: selected }),
        signal: controller.signal,
      });
      // Closed while in flight (S-9): the dialog now belongs to another row —
      // touch nothing. (fetch usually rejects on abort; this covers the race
      // where the response had already resolved.)
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (controller.signal.aborted) return;
        setErrorCode(body.error ?? 'generic');
        return;
      }
      toast.success(
        t('toast.roleChanged', { email: user.email, role: tRole(selected) }),
      );
      onChanged();
      onOpenChange(false);
    } catch {
      if (controller.signal.aborted) return;
      setErrorCode('generic');
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  // `user === null` is folded into the gate so the "open with no target"
  // state (representable because `user` and `open` are independent props)
  // cannot present an enabled Confirm whose handler then early-returns in
  // silence — review Suggestion #11. The non-retryable arm (S-10): while an
  // error whose verbatim retry cannot succeed is on screen, Confirm is dead —
  // picking a different role clears the error and revives it.
  const confirmDisabled =
    user === null ||
    unchanged ||
    submitting ||
    phraseBlocking ||
    (errorCode !== null && NON_RETRYABLE_ERROR_CODES.has(errorCode));

  return (
    // `role="alertdialog"` is DELIBERATE — 016 UX review S1, recorded
    // WON'T-FIX: a role grant mid-decision should not be dismissible by a
    // stray click the way a browse dialog is, and AURA's alertdialog ignores
    // the scrim. Escape and the close button still close it (and abort any
    // in-flight POST). The two §6.4 confirmation-checklist deviations this
    // picker keeps are documented on `promotingToSuperAdmin` above.
    //
    // No initial focus on Cancel — this is a picker, not a destructive
    // confirm. Confirm is disabled until a DIFFERENT role is chosen, so there
    // is no accidental-confirm risk to guard; AURA lands focus on the first
    // radio, so arrow-key selection works at once (016 UX review I1).
    <Dialog
      role="alertdialog"
      open={open}
      onClose={() => onOpenChange(false)}
      finalFocus={() => finalFocus?.() || null}
      title={t('changeRole.title', { email: user?.email ?? '' })}
      description={t('changeRole.description')}
      footer={
        <>
          <Button touchHeight variant="secondary" disabled={submitting} onClick={() => onOpenChange(false)}>
            {t('confirm.cancel')}
          </Button>
          <Button touchHeight
            variant="primary"
            disabled={confirmDisabled}
            loading={submitting}
            onClick={() => void handleConfirm()}
          >
            {t('changeRole.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Each option is named by its role alone (the current one says so,
            as the board does) and described by what it grants — before the
            summaries the option announced a bare role name. `member` is
            absent from the options and the reason existed only in a source
            comment: an operator who saw five roles in the invite dialog and
            four here reads it as a bug, so the hint under the group says why. */}
        <RadioGroup
          touchHeight
          label={t('changeRole.roleLabel')}
          hint={t('changeRole.memberHint')}
          value={selected ?? ''}
          disabled={submitting}
          onChange={(next) => {
            if (isRole(next)) {
              setErrorCode(null);
              setSelected(next);
            }
          }}
          options={byDisplayOrder(CHANGE_ROLE_OPTIONS).map((r) => ({
            value: r,
            label: r === currentRole ? t('changeRole.currentOption', { role: tRole(r) }) : tRole(r),
            description: tSummary(r),
          }))}
        />

        {/* Promotion to super_admin is the one irreversible-in-practice choice
            here — it grants users.manage, audit.read, invoice settings and GDPR
            erasure, and the grantee can immediately demote the grantor. It had
            exactly the same weight as every other pick: one primary button
            labelled "Change role". ux-standards § 6.1 names "Change user role"
            directly; this is the § 6.3 inline warning plus the typed phrase.
            The warning is an alert, so picking the option announces it — a
            screen reader user otherwise met a disabled Confirm and no reason. */}
        {/* rbac-presentation-only-ok: shows an advisory warning; the server
            gate on this promotion is `users.manage` in the route. */}
        {promotingToSuperAdmin ? (
          <>
            <Alert tone="warning" data-testid="super-admin-promotion-warning">
              {t('changeRole.superAdminWarning')}
            </Alert>
            <TextField
              id="change-role-phrase"
              touchHeight
              label={t('changeRole.superAdminConfirmCopy', { phrase: confirmPhrase })}
              required
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
              error={
                typedPhrase.length > 0 && !phraseMatches ? (
                  <span role="alert">
                    {t('changeRole.superAdminConfirmMismatch', { phrase: confirmPhrase })}
                  </span>
                ) : undefined
              }
            />
          </>
        ) : null}

        {errorCode ? (
          <Alert
            tone="danger"
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
            className="outline-none"
          >
            {t(`changeRole.errors.${resolveErrorKey(errorCode)}`)}
          </Alert>
        ) : null}

        {/* Confirm is disabled until a DIFFERENT role is picked, which on open
            is always — so the dialog presented a dead primary button with no
            statement of what would revive it. */}
        {unchanged && errorCode === null ? (
          <p className="text-xs text-[var(--aura-fg-secondary)]">{t('changeRole.pickDifferent')}</p>
        ) : null}
      </div>
    </Dialog>
  );
}
