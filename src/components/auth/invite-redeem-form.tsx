'use client';

/**
 * InviteRedeemForm (T133, spec US4 AS2, FR-024).
 *
 * UX:
 *   - display-name field auto-focused on mount (per FR-024 primary-
 *     input table — the email is already known, the display name is
 *     the thing the user customises)
 *   - email field is read-only (shows what the invitation was for)
 *   - password + password-strength indicator
 *   - confirm password must match
 *   - On success: redirects to the `redirectTo` URL returned by the
 *     API (admin or member landing)
 *   - AURA fields (spec 122 US2): `TextField` / `PasswordField`,
 *     `FormErrorSummary` after a failed submit, `Button` with `loading`.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { refinePasswordPair, requiredText, type Translator } from '@/lib/zod-i18n';
import { toast } from '@/lib/toast';
import { Button, FormErrorSummary, PasswordField, TextField } from '@jirawatpyk/aura-react';
import { AuthLinkInvalid } from './auth-link-invalid';
import { portalSignInPath } from '@/lib/portal-paths';
import {
  PasswordStrength,
  usePasswordStrengthMeter,
} from './password-strength';

// H2 + O1 (Round 2/3) — schema built inside component via shared
// `refinePasswordPair` helper (invite uses `password` not
// `newPassword` so the field name override is passed explicitly).
// I1 (Round 4) — cast dropped now that the helper preserves inferred
// shape.
type FormValues = {
  displayName: string;
  password: string;
  confirmPassword: string;
};

function buildSchema(
  tv: Translator,
  tooShort: string,
  passwordMismatch: string,
) {
  return refinePasswordPair(
    z.object({
      displayName: requiredText(tv, 120),
      password: z
        .string()
        .min(12, tooShort)
        .max(256, tv('tooLong', { max: 256 })),
      confirmPassword: z.string(),
    }),
    passwordMismatch,
    'password',
  );
}

export interface InviteRedeemFormProps {
  readonly token: string;
  readonly email: string;
  /** Names the chamber in the privacy line under the button. */
  readonly tenantName?: string;
  /**
   * The tenant's privacy notice (`TENANT_PRIVACY_POLICY_URL`). Creating the
   * account collects the name and password, so the notice is linked at the
   * point of collection (PDPA s.23, the `Auth-invite` board); null hides it.
   */
  readonly privacyNoticeHref?: string | null;
}

export function InviteRedeemForm({ token, email, tenantName = 'SweCham', privacyNoticeHref = null }: InviteRedeemFormProps) {
  const t = useTranslations('auth.invite');
  const tFrame = useTranslations('auth.frame');
  const tReset = useTranslations('auth.resetPassword');
  const tErrors = useTranslations('errors');
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);

  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors, submitCount },
  } = useForm<FormValues>({
    resolver: zodResolver(
      buildSchema(
        tv as Translator,
        tReset('errors.tooShort'),
        tReset('errors.passwordMismatch'),
      ),
    ),
    defaultValues: { displayName: '', password: '', confirmPassword: '' },
    mode: 'onSubmit',
    // The error summary takes focus after a failed submit (spec 122 US2 AS1).
    shouldFocusError: false,
  });

  useEffect(() => {
    setFocus('displayName');
  }, [setFocus]);

  const passwordValue = useWatch({ control, name: 'password' });
  const meter = usePasswordStrengthMeter(passwordValue ?? '');

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/redeem-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          password: values.password,
          displayName: values.displayName,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { redirectTo: string };
        router.push(data.redirectTo);
        router.refresh();
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        issues?: string[];
      };

      if (response.status === 410 || body.error === 'link-invalid') {
        setLinkInvalid(true);
        return;
      }

      if (body.error === 'weak-password') {
        const first = body.issues?.[0] ?? 'too-short';
        const message =
          first === 'breached'
            ? tReset('errors.passwordBreached')
            : tReset('errors.weakPassword');
        setError('password', { message });
        // Pin the strength bar to red for this value so it agrees with the
        // inline error instead of contradicting it. The error summary that
        // appears with it takes focus and links to the field.
        meter.markRejected(values.password);
        return;
      }

      toast.error(tErrors('generic'));
    } catch {
      toast.error(tErrors('network'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleFormSubmit = (event: FormEvent) => {
    void handleSubmit(onSubmit)(event);
  };

  if (linkInvalid) {
    // M3 (Round 3) — the recovery step is a guidance line, not a request
    // button: invitations are issued by someone else, so there is no
    // self-service target; only "Back to sign in". The block takes focus:
    // without it a keyboard user is left on the now-unmounted submit button.
    return (
      <AuthLinkInvalid
        title={t('expiredTitle')}
        detail={t('expiredBody')}
        back={{ label: tFrame('backToSignIn'), href: portalSignInPath('member') }}
        autoFocus
      />
    );
  }

  return (
    <form
      onSubmit={handleFormSubmit}
      // Native fallback POSTs so the new account password stays out of the
      // URL (CWE-598; see tests/unit/auth/auth-forms-post-method.test.tsx).
      method="post"
      className="flex flex-col gap-5"
      noValidate
      aria-busy={submitting}
    >
      <FormErrorSummary errors={errors} focusKey={submitCount} />

      {/* Read-only, not disabled: it stays in the tab order for keyboard and
          screen-reader users, and password managers pair the new password
          with it. Not registered, so it is never submitted. */}
      <TextField id="email" label={t('emailLabel')} type="email" value={email} readOnly autoComplete="username" />

      <TextField
        id="display-name"
        label={t('displayNameLabel')}
        autoComplete="name"
        error={errors.displayName?.message}
        {...register('displayName')}
      />

      <div className="flex flex-col gap-1.5">
        <PasswordField
          id="password"
          label={t('passwordLabel')}
          hint={t('passwordHint')}
          autoComplete="new-password"
          error={errors.password?.message}
          // The bar describes the field until an error replaces it (AURA adds
          // `password-error` itself).
          aria-describedby={errors.password ? undefined : 'password-strength'}
          {...register('password')}
        />
        <div id="password-strength">
          <PasswordStrength level={meter.level} weakReason={meter.weakReason} />
        </div>
      </div>

      <PasswordField
        id="confirm-password"
        label={t('confirmPasswordLabel')}
        autoComplete="new-password"
        error={errors.confirmPassword?.message}
        {...register('confirmPassword')}
      />

      <div className="flex flex-col">
        <Button type="submit" variant="primary" loading={submitting}>
          {t('submit')}
        </Button>
      </div>

      {privacyNoticeHref ? (
        <p className="m-0 aura-text-table-cell text-[var(--aura-fg-secondary)]">
          {t.rich('privacyLine', {
            tenantDisplayName: tenantName,
            link: (chunks) => (
              <a href={privacyNoticeHref} target="_blank" rel="noreferrer" className="text-[var(--aura-fg-accent)] underline underline-offset-4 hover:text-[var(--aura-fg-primary)]">
                {chunks}
              </a>
            ),
          })}
        </p>
      ) : null}
    </form>
  );
}
