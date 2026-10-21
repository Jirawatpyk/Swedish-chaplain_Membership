'use client';

/**
 * InviteUserDialog — admin-side invite form that closes the gap
 * between the `user-list-table.tsx` "Invite user" button and the
 * `/api/auth/invite` endpoint.
 *
 * UX (ux-standards § 6 / § 11):
 *   - Dialog opens from the "Invite user" button in the page header.
 *   - Fields: email (auto-focus), role (every role in ASSIGNABLE_ROLES —
 *     super_admin / admin / manager / marketing / member),
 *     optional "link to member" picker — enabled only when role=member
 *     (F1 spec:672-678).
 *   - Submits to `POST /api/auth/invite` with the Origin header set
 *     by the browser (the proxy.ts CSRF guard passes same-origin).
 *   - On success: shows a toast, closes the dialog, refreshes the
 *     users table.
 *   - On error: surfaces the server error code as an inline alert
 *     inside the dialog.
 *   - Keyboard: Enter submits, Escape cancels.
 *
 * Spec 122 US10a (T1004; board `Admin-user-invite`) — on AURA: Dialog,
 * TextField, the role on a Select with the chosen role's summary as its
 * hint, and the member link on the AURA Combobox picker (T1005). The
 * member link stays optional (the board marks it required; recorded as a
 * deviation in the spec). Request body, toasts and errors are unchanged.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { UserIcon } from 'lucide-react';
import { Alert, Button, Dialog, Select, TextField } from '@jirawatpyk/aura-react';
import { MemberPicker } from '@/components/members/member-picker';
// Client component — same rationale as `idle-warning-dialog.tsx`:
// the `@/modules/auth` barrel transitively loads Node-only
// Infrastructure modules and cannot be used from client code.
// Domain types and constants are pure and safe to import directly.
 
import {
  ASSIGNABLE_ROLES,
  byDisplayOrder,
  isRole,
  type Role,
} from '@/modules/auth/domain/role';

/**
 * The exhaustive list of error codes the invite route + this dialog
 * know how to localise. Keep this in sync with `admin.users.invite.errors.*`
 * in `src/i18n/messages/en.json`. Unknown codes fall back to `generic`
 * via `resolveInviteErrorKey` below.
 */
const KNOWN_INVITE_ERROR_KEYS = [
  'generic',
  'network',
  'invalid-input',
  'email-taken',
  'member-not-found',
  // Hybrid A+B duplicate-email handling (findByEmail pre-tx check in
  // `invite-user-for-member`). Both surface as HTTP 409; the dialog
  // renders action-oriented copy (see admin.users.invite.errors.*).
  'contact-already-linked',
  'email-belongs-to-other-member',
  'forbidden',
  // go-live #12-13 follow-up — /api/auth/invite returns `link-failed` (HTTP 500)
  // when the contact-link step fails after createUser committed and the invite is
  // rolled back (SAGA compensation). Distinct, retry-safe copy instead of generic.
  'link-failed',
] as const;

type InviteErrorKey = (typeof KNOWN_INVITE_ERROR_KEYS)[number];

function resolveInviteErrorKey(code: string): InviteErrorKey {
  return (KNOWN_INVITE_ERROR_KEYS as readonly string[]).includes(code)
    ? (code as InviteErrorKey)
    : 'generic';
}

/**
 * Discriminated union makes `lockMember: true` structurally require both
 * `defaultMemberId` AND `lockedMemberLabel` — the compiler rejects the
 * previously-valid `{ lockMember: true }` (no memberId) state.
 *
 * - Free form (default): optional `defaultMemberId` pre-fills the picker
 *   but the admin can change it. Used by `/admin/users`.
 * - Locked form: `defaultMemberId` + `lockedMemberLabel` required; role
 *   is hidden (forced to 'member'). Used by the reverse entry on the
 *   member detail page so admins don't re-search the picker.
 */
type InviteUserDialogBaseProps = {
  readonly disabled?: boolean;
  /** Custom trigger element (replaces the default "Invite user" button).
   *  Must be a single ReactElement — AURA's Dialog renders it in place and
   *  wires its click, `aria-haspopup` and `aria-expanded`. */
  readonly trigger?: React.ReactElement;
};

export type InviteUserDialogProps = InviteUserDialogBaseProps &
  (
    | {
        readonly lockMember?: false;
        readonly defaultMemberId?: string;
        readonly lockedMemberLabel?: never;
      }
    | {
        readonly lockMember: true;
        readonly defaultMemberId: string;
        readonly lockedMemberLabel: string;
      }
  );

export function InviteUserDialog({
  disabled = false,
  defaultMemberId,
  lockMember = false,
  lockedMemberLabel,
  trigger,
}: InviteUserDialogProps) {
  const t = useTranslations('admin.users.invite');
  const tLink = useTranslations('admin.users.invite.linkMember');
  const tActions = useTranslations('admin.users.actions');
  // Role NAME and role SUMMARY, both shared with the change-role picker so the
  // two controls on this screen describe a role the same way. They used to draw
  // from different namespaces: invite showed "name — description" while
  // change-role showed a bare name, so a super_admin promoting a colleague to
  // super_admin saw no statement of what that grants.
  const tRole = useTranslations('admin.users.filters.role');
  const tSummary = useTranslations('admin.users.roleSummary');
  // Email-locale audit 2026-07-16 — carry the admin's UI locale as the invite
  // default. The route threads it onward: for a NEW contact / staff user this
  // is the best available signal; for an EXISTING member contact the use-case
  // overrides it with the contact's stored preferred_language. Previously the
  // dialog sent no locale, so every invitation from here shipped English.
  const locale = useLocale();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [memberId, setMemberId] = useState<string | null>(
    defaultMemberId ?? null,
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // On close we reset to the pristine state: `defaultMemberId` (not null) +
  // role='member' so locked reopens preserve the preset. Focus on open needs
  // no help: AURA's Dialog lands it on the first field, the email.
  useEffect(() => {
    if (open) return;
    setEmail('');
    setRole('member');
    setMemberId(defaultMemberId ?? null);
    setErrorCode(null);
  }, [open, defaultMemberId]);

  // Clear memberId when role switches away from 'member' — the
  // backend rejects the combination and showing a stale selection
  // under a disabled picker would be confusing. Skip when the member
  // is locked: role can never leave 'member' in that mode.
  useEffect(() => {
    if (lockMember) return;
    // rbac-presentation-only-ok: clears a form field that is meaningless for
    // a staff role. The server ignores memberId for non-member invites.
    if (role !== 'member' && memberId !== null) {
      setMemberId(null);
    }
  }, [role, memberId, lockMember]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setErrorCode(null);
    try {
      const body: Record<string, unknown> = {
        email: email.trim().toLowerCase(),
        role,
        locale,
      };
      // rbac-presentation-only-ok: shapes the request body; the route
      // re-derives the member link itself and does not trust this.
      if (role === 'member' && memberId) {
        body.memberId = memberId;
      }
      const response = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errBody = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setErrorCode(errBody.error ?? 'generic');
        return;
      }
      toast.success(t('toast.success', { email: email.trim() }));
      setOpen(false);
      router.refresh();
    } catch {
      setErrorCode('network');
    } finally {
      setSubmitting(false);
    }
  }

  const formId = 'invite-user-form';

  return (
    <Dialog
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      trigger={
        trigger ?? (
          <Button variant="primary" icon={<UserIcon aria-hidden />} touchHeight disabled={disabled}>
            {tActions('invite')}
          </Button>
        )
      }
      title={t('title')}
      description={t('description')}
      footer={
        <>
          <Button touchHeight variant="secondary" onClick={() => setOpen(false)}>
            {t('cancel')}
          </Button>
          <Button touchHeight
            type="submit"
            form={formId}
            variant="primary"
            loading={submitting}
            disabled={submitting || !email.trim()}
          >
            {submitting ? t('submitting') : t('submit')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-4">
        <TextField
          id="invite-email"
          touchHeight
          label={t('emailLabel')}
          type="email"
          autoComplete="off"
          required
          value={email}
          disabled={submitting}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('emailPlaceholder')}
        />
        {/* Role dropdown is hidden when invoked in locked-member mode — role
            is force-set to 'member' for the reverse entry point on the member
            detail page. The /admin/users entry point shows the full role
            selector. The options carry the role NAMES; the hint under the
            field says what the chosen role grants (the summary, shared with
            the change-role picker, moved off the options — same words). */}
        {!lockMember && (
          <Select
            id="invite-role"
            touchHeight
            label={t('roleLabel')}
            required
            value={role}
            disabled={submitting}
            onChange={(e) => {
              const next = e.target.value;
              if (isRole(next)) setRole(next);
            }}
            options={byDisplayOrder(ASSIGNABLE_ROLES).map((r) => ({ value: r, label: tRole(r) }))}
            hint={tSummary(role)}
          />
        )}
        {lockMember ? (
          // Read-only display of the pre-selected company: still in the Tab
          // order with `readOnly`, so its name and value are heard.
          <TextField
            id="invite-link-member"
            touchHeight
            label={tLink('label')}
            readOnly
            value={lockedMemberLabel ?? tLink('lockedFallback')}
            hint={tLink('lockedHelpText')}
          />
        ) : (
          <MemberPicker
            id="invite-link-member"
            label={tLink('label')}
            hint={tLink('helpText')}
            value={memberId}
            onChange={setMemberId}
            // rbac-presentation-only-ok: enables a field, grants nothing
            disabled={submitting || role !== 'member'}
          />
        )}
        {errorCode ? (
          <Alert tone="danger">{t(`errors.${resolveInviteErrorKey(errorCode)}`)}</Alert>
        ) : null}
      </form>
    </Dialog>
  );
}
