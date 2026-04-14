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
 *     optional display name placeholder (not yet wired — the invite
 *     route derives it from the email on submit).
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
import { useTranslations } from 'next-intl';
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
  SelectValue,
} from '@/components/ui/select';
// Client component — same rationale as `idle-warning-dialog.tsx`:
// the `@/modules/auth` barrel transitively loads Node-only
// Infrastructure modules and cannot be used from client code.
// Domain types and constants are pure and safe to import directly.
// eslint-disable-next-line no-restricted-imports
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
  'forbidden',
] as const;

type InviteErrorKey = (typeof KNOWN_INVITE_ERROR_KEYS)[number];

function resolveInviteErrorKey(code: string): InviteErrorKey {
  return (KNOWN_INVITE_ERROR_KEYS as readonly string[]).includes(code)
    ? (code as InviteErrorKey)
    : 'generic';
}

export interface InviteUserDialogProps {
  readonly disabled?: boolean;
}

export function InviteUserDialog({ disabled = false }: InviteUserDialogProps) {
  const t = useTranslations('admin.users.invite');
  const tActions = useTranslations('admin.users.actions');
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Auto-focus the email field when the dialog opens. The timeout
  // lets Base UI finish its portal mount before we call .focus().
  useEffect(() => {
    if (!open) {
      setEmail('');
      setRole('member');
      setErrorCode(null);
      return;
    }
    const t = setTimeout(() => emailRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setErrorCode(null);
    try {
      const response = await fetch('/api/auth/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          role,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        setErrorCode(body.error ?? 'generic');
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
          <Button variant="outline" size="sm" disabled={disabled}>
            <UserPlusIcon className="size-4" aria-hidden />
            {tActions('invite')}
          </Button>
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
                  <SelectValue />
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
                  <Loader2Icon className="size-4 animate-spin" aria-hidden />
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
