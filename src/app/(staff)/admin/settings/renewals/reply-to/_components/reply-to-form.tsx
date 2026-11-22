'use client';

/**
 * PR B (#707 follow-up) — the renewal reminder Reply-To form.
 *
 * - `PUT /api/admin/renewals/settings/reply-to { email, displayName }`, same
 *   origin. While in flight the form is `aria-busy` and the buttons show
 *   `loading`; nothing is `disabled`, so focus never drops to `<body>`.
 * - A field error from the server (422) shows on that field; a read-only 503
 *   shows the read-only copy; anything else the generic alert. The fields keep
 *   what the user typed in every failure.
 * - Success shows the server's trimmed values, and a toast only when
 *   something changed (`changed: true`): a no-op writes no audit row, so
 *   "saved" would claim a change the trail does not have.
 * - "Remove reply-to" sends `email: null` (clears both), is shown only while
 *   a value is stored, and its toast offers Undo (puts the removed values
 *   back). After it, focus moves to the email field, since the button is gone.
 * - A field error moves focus to that field, so a screen reader reads the
 *   label and its error; a save that changed nothing says so inline.
 * - A network failure says the server may not have answered, not that
 *   nothing changed: the save may have landed.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Alert, Button, TextField } from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';

type FieldError = 'invalid_email' | 'display_name_without_email' | 'unsafe_character' | 'too_long';

/** The longest name the server accepts (the domain rule). */
const DISPLAY_NAME_MAX = 100;

function readSaved(body: unknown): { email: string | null; displayName: string | null; changed: boolean } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { email?: unknown; displayName?: unknown; changed?: unknown };
  const okNullableString = (v: unknown) => v === null || typeof v === 'string';
  if (!okNullableString(b.email) || !okNullableString(b.displayName) || typeof b.changed !== 'boolean') return null;
  return { email: b.email as string | null, displayName: b.displayName as string | null, changed: b.changed };
}

function readError(body: unknown): { code: string; reason?: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const e = (body as { error?: unknown }).error;
  if (typeof e !== 'object' || e === null) return null;
  const code = (e as { code?: unknown }).code;
  const reason = (e as { reason?: unknown }).reason;
  if (typeof code !== 'string') return null;
  return typeof reason === 'string' ? { code, reason } : { code };
}

export function ReplyToForm({
  initialEmail,
  initialDisplayName,
}: {
  readonly initialEmail: string | null;
  readonly initialDisplayName: string | null;
}): React.ReactElement {
  const t = useTranslations('admin.settings.renewalReplyTo');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [displayName, setDisplayName] = useState(initialDisplayName ?? '');
  const [stored, setStored] = useState<{ email: string | null; displayName: string | null }>({
    email: initialEmail,
    displayName: initialDisplayName,
  });
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  // The toast's Undo holds the `send` of the render that removed, where
  // `busy` reads null; the ref guards every caller against a request in flight.
  const inFlight = useRef(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  function focusField(ref: React.RefObject<HTMLInputElement | null>): void {
    requestAnimationFrame(() => ref.current?.focus());
  }

  function showFieldError(field: 'email' | 'name', message: string): void {
    if (field === 'email') setEmailError(message);
    else setNameError(message);
    focusField(field === 'email' ? emailRef : nameRef);
  }

  async function send(
    kind: 'save' | 'remove' | 'undo',
    values: { email: string | null; displayName: string | null },
  ): Promise<void> {
    if (inFlight.current) return;
    setEmailError(null);
    setNameError(null);
    setFormError(null);
    setUnchanged(false);
    if (values.displayName !== null && values.displayName.trim().length > DISPLAY_NAME_MAX) {
      showFieldError('name', t('errors.nameTooLong'));
      return;
    }
    inFlight.current = true;
    setBusy(kind === 'remove' ? 'remove' : 'save');
    const before = stored;
    const payload = values;
    try {
      const res = await fetch('/api/admin/renewals/settings/reply-to', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        if (isReadOnlyRefusal(res.status, body)) {
          setFormError(t('errors.readOnly'));
          return;
        }
        const e = readError(body);
        const field = (e?.code === 'invalid_display_name' ? e.reason : e?.code) as FieldError | undefined;
        if (field === 'invalid_email') showFieldError('email', t('errors.invalidEmail'));
        else if (field === 'display_name_without_email') showFieldError('email', t('errors.nameWithoutEmail'));
        else if (field === 'unsafe_character') showFieldError('name', t('errors.nameUnsafe'));
        else if (field === 'too_long') showFieldError('name', t('errors.nameTooLong'));
        else setFormError(t('errors.generic'));
        return;
      }
      const saved = readSaved(body);
      if (saved === null) {
        setFormError(t('errors.generic'));
        return;
      }
      setStored({ email: saved.email, displayName: saved.displayName });
      setEmail(saved.email ?? '');
      setDisplayName(saved.displayName ?? '');
      if (!saved.changed) {
        setUnchanged(true);
      } else if (kind === 'remove') {
        toast.success(t('toast.removed'), {
          duration: 8_000,
          action: { label: t('toast.undo'), onClick: () => void send('undo', before) },
        });
      } else {
        toast.success(saved.email === null ? t('toast.removed') : t('toast.saved'));
      }
      if (kind === 'remove') focusField(emailRef);
    } catch {
      setFormError(t('errors.network'));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <form
      className="grid gap-[var(--aura-space-4)]"
      aria-busy={busy !== null || undefined}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void send('save', {
          email: email.trim() === '' ? null : email,
          displayName: displayName.trim() === '' ? null : displayName,
        });
      }}
    >
      <TextField
        ref={emailRef}
        touchHeight
        readOnly={busy !== null}
        label={t('email.label')}
        hint={t('email.hint')}
        type="email"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setUnchanged(false);
        }}
        error={emailError ?? undefined}
      />
      <TextField
        ref={nameRef}
        touchHeight
        readOnly={busy !== null}
        optional
        label={t('displayName.label')}
        hint={t('displayName.hint')}
        autoComplete="off"
        value={displayName}
        onChange={(e) => {
          setDisplayName(e.target.value);
          setUnchanged(false);
        }}
        error={nameError ?? undefined}
      />
      <Alert tone="info" role="note">
        {t('note')}
      </Alert>
      {formError !== null ? (
        <Alert tone="danger" role="alert">
          {formError}
        </Alert>
      ) : null}
      <p role="status" aria-live="polite" className="text-sm text-[var(--aura-fg-secondary)] empty:-mt-[var(--aura-space-4)]">
        {unchanged ? t('status.unchanged') : null}
      </p>
      <div className="flex flex-wrap gap-[var(--aura-space-3)]">
        <Button type="submit" variant="primary" touchHeight fullWidth="below-sm" loading={busy === 'save'}>
          {t('actions.save')}
        </Button>
        {stored.email !== null ? (
          <Button
            type="button"
            variant="secondary"
            touchHeight
            fullWidth="below-sm"
            loading={busy === 'remove'}
            onClick={() => void send('remove', { email: null, displayName: null })}
          >
            {t('actions.remove')}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
