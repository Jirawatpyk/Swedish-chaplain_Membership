'use client';

/**
 * ResetPasswordForm (T104, spec US3 AS2/AS4, FR-024).
 *
 * UX:
 *   - new-password field auto-focused on mount (FR-024 primary-input).
 *   - Live strength indicator (T105) that re-evaluates on the client
 *     via a simple length + character-class heuristic. The canonical
 *     policy (HIBP + common-password) runs server-side — we only give
 *     the user a rough guide here to avoid per-keystroke network calls.
 *   - Confirm-password field must equal new-password; validated
 *     locally via zod.
 *   - On success: shows a "password updated" toast and navigates to
 *     the `signInUrl` the API returned (staff vs member portal).
 *   - On `link-invalid`: swaps the form for a full error card with a
 *     "Request a new link" affordance.
 *   - AURA fields (spec 122 US2): `PasswordField` (the show/hide toggle
 *     announces its state), `FormErrorSummary` after a failed submit, and
 *     `Button` with `loading`.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { passwordPairFields, refinePasswordPair } from '@/lib/zod-i18n';
import { toast } from '@/lib/toast';
import { Button, FormErrorSummary, PasswordField } from '@jirawatpyk/aura-react';
import { AuthLinkInvalid } from './auth-link-invalid';
import {
  PasswordStrength,
  usePasswordStrengthMeter,
} from './password-strength';

// H2 (Round 2) — schema built inside the component so error messages
// translate per locale. O1 (Round 3) — extracted to src/lib/zod-i18n.ts
// for reuse across 3 forms; N6 dev-mode guard now catches translation
// drift even before check:i18n CI runs. I1 (Round 4) — helper signature
// now preserves inferred shape, so the previous `as unknown as
// z.ZodType<FormValues>` cast is gone.
type FormValues = { newPassword: string; confirmPassword: string };

function buildSchema(
  tooShort: string,
  tooLong: string,
  passwordMismatch: string,
) {
  return refinePasswordPair(
    z.object(passwordPairFields(tooShort, tooLong)),
    passwordMismatch,
  );
}

export interface ResetPasswordFormProps {
  readonly token: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const t = useTranslations('auth.resetPassword');
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
        t('errors.tooShort'),
        tv('tooLong', { max: 256 }),
        t('errors.passwordMismatch'),
      ),
    ),
    defaultValues: { newPassword: '', confirmPassword: '' },
    mode: 'onSubmit',
    // The error summary takes focus after a failed submit (spec 122 US2 AS1).
    shouldFocusError: false,
  });

  useEffect(() => {
    setFocus('newPassword');
  }, [setFocus]);

  const newPasswordValue = useWatch({ control, name: 'newPassword' });
  const meter = usePasswordStrengthMeter(newPasswordValue ?? '');

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          newPassword: values.newPassword,
        }),
      });

      if (response.ok) {
        const data = (await response.json()) as { signInUrl: string };
        toast.success(t('success'));
        router.push(data.signInUrl);
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
        setError('newPassword', {
          message:
            first === 'breached'
              ? t('errors.passwordBreached')
              : t('errors.weakPassword'),
        });
        // Pin the strength bar to red for this value so it agrees with the
        // inline error instead of contradicting it. The error summary that
        // appears with it takes focus and links to the field.
        meter.markRejected(values.newPassword);
        return;
      }

      if (response.status === 429) {
        toast.error(tErrors('generic'));
        return;
      }

      toast.error(tErrors('generic'));
    } catch {
      toast.error(tErrors('network'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDirectSubmit = (event: FormEvent) => {
    void handleSubmit(onSubmit)(event);
  };

  if (linkInvalid) {
    // Managed focus on the alert that replaces the form (see AuthLinkInvalid).
    return (
      <AuthLinkInvalid
        message={t('errors.tokenExpired')}
        action={{ label: t('requestNewLink'), href: '/forgot-password' }}
        autoFocus
      />
    );
  }

  return (
    <form
      onSubmit={handleDirectSubmit}
      // Native fallback POSTs so the new password stays out of the URL
      // (CWE-598; see tests/unit/auth/auth-forms-post-method.test.tsx).
      method="post"
      className="flex flex-col gap-4"
      noValidate
      aria-busy={submitting}
    >
      <FormErrorSummary errors={errors} focusKey={submitCount} />

      <div className="flex flex-col gap-2">
        <PasswordField
          id="new-password"
          label={t('newPasswordLabel')}
          autoComplete="new-password"
          error={errors.newPassword?.message}
          // The bar describes the field until an error replaces it (AURA adds
          // `new-password-error` itself).
          aria-describedby={errors.newPassword ? undefined : 'new-password-strength'}
          {...register('newPassword')}
        />
        <div id="new-password-strength">
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

      <div className="flex flex-col pt-2">
        <Button type="submit" variant="primary" loading={submitting}>
          {t('submit')}
        </Button>
      </div>
    </form>
  );
}
