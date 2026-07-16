'use client';

/**
 * InviteUserDialog — admin-side invite form that closes the gap
 * between the `user-list-table.tsx` "Invite user" button and the
 * `/api/auth/invite` endpoint.
 *
 * UX (ux-standards § 6 / § 11):
 *   - Dialog opens from the "Invite user" button at the bottom of
 *     the users table.
 *   - Fields: email (auto-focus), role (admin / manager / member),
 *     optional "link to member" picker — enabled only when role=member
 *     (F1 spec:672-678).
 *   - Submits to `POST /api/auth/invite` with the Origin header set
 *     by the browser (the proxy.ts CSRF guard passes same-origin).
 *   - On success: shows a toast, closes the dialog, refreshes the
 *     users table.
 *   - On error: surfaces the server error code as an inline alert
 *     inside the dialog.
 *   - Keyboard: Enter submits, Escape cancels.
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2Icon, UserPlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import { MemberPicker } from '@/components/members/member-picker';
// Client component — same rationale as `idle-warning-dialog.tsx`:
// the `@/modules/auth` barrel transitively loads Node-only
// Infrastructure modules and cannot be used from client code.
// Domain types and constants are pure and safe to import directly.
 
import { isRole, ROLES, type Role } from '@/modules/auth/domain/role';

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
   *  Must be a single ReactElement — DialogTrigger's `render` prop does
   *  not accept fragments or strings. */
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
  const emailRef = useRef<HTMLInputElement>(null);

  // Auto-focus the email field when the dialog opens. A 0ms timeout
  // defers the `.focus()` call to the next task so Base UI has time
  // to finish its portal mount (same pattern as MemberPicker).
  // On close we reset to the pristine state: `defaultMemberId` (not
  // null) + role='member' so locked reopens preserve the preset.
  useEffect(() => {
    if (!open) {
      setEmail('');
      setRole('member');
      setMemberId(defaultMemberId ?? null);
      setErrorCode(null);
      return;
    }
    const timer = setTimeout(() => emailRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, defaultMemberId]);

  // Clear memberId when role switches away from 'member' — the
  // backend rejects the combination and showing a stale selection
  // under a disabled picker would be confusing. Skip when the member
  // is locked: role can never leave 'member' in that mode.
  useEffect(() => {
    if (lockMember) return;
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          trigger ?? (
            <Button disabled={disabled}>
              <UserPlusIcon className="size-4" aria-hidden />
              {tActions('invite')}
            </Button>
          )
        }
      />
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">{t('emailLabel')}</Label>
              <Input
                id="invite-email"
                ref={emailRef}
                type="email"
                autoComplete="off"
                required
                value={email}
                disabled={submitting}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t('emailPlaceholder')}
              />
            </div>
            {/* Role dropdown is hidden when invoked in locked-member
                mode — role is force-set to 'member' for the reverse
                entry point on the member detail page. The original
                /admin/users entry point shows the full role selector. */}
            {!lockMember && (
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">{t('roleLabel')}</Label>
                <Select
                  value={role}
                  disabled={submitting}
                  onValueChange={(next) => {
                    if (next && isRole(next)) setRole(next);
                  }}
                >
                  <SelectTrigger id="invite-role" className="w-full">
                    <TranslatedSelectValue
                      translate={(v) => (v ? t(`roles.${v}`) : t('roleLabel'))}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t(`roles.${r}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label
                id="invite-link-member-label"
                htmlFor="invite-link-member"
              >
                {tLink('label')}
              </Label>
              {lockMember ? (
                // Read-only display of the pre-selected company.
                // Mirrors the MemberPicker trigger's visual footprint
                // so the dialog layout doesn't jump between the two
                // modes. `aria-readonly` + non-interactive styling
                // make it unambiguous to SR users that this value
                // cannot be changed in the current flow.
                <div
                  id="invite-link-member"
                  role="textbox"
                  aria-readonly="true"
                  // A readonly textbox is still focusable — keep it in the tab
                  // order (matching the focusable <MemberPicker> it swaps with,
                  // so tab order is stable across the two modes) and honour the
                  // role=textbox contract (an unfocusable textbox is invalid).
                  tabIndex={0}
                  aria-labelledby="invite-link-member-label"
                  aria-describedby="invite-link-member-help"
                  className="flex h-9 w-full items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">
                    {lockedMemberLabel ?? tLink('lockedFallback')}
                  </span>
                </div>
              ) : (
                <MemberPicker
                  id="invite-link-member"
                  aria-labelledby="invite-link-member-label"
                  aria-describedby="invite-link-member-help"
                  value={memberId}
                  onChange={setMemberId}
                  disabled={submitting || role !== 'member'}
                />
              )}
              {/* id wired so MemberPicker's trigger can reference this
                  paragraph via aria-describedby when the picker is active. */}
              <p id="invite-link-member-help" className="text-xs text-muted-foreground">
                {lockMember ? tLink('lockedHelpText') : tLink('helpText')}
              </p>
            </div>
            {errorCode ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
              >
                {t(`errors.${resolveInviteErrorKey(errorCode)}`)}
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t('cancel')}
            </DialogClose>
            <Button type="submit" disabled={submitting || !email.trim()}>
              {submitting ? (
                <>
                  <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
                  {t('submitting')}
                </>
              ) : (
                t('submit')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
