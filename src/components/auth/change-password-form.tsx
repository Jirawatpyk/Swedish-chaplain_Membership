'use client';

/**
 * ChangePasswordForm (T153, spec US6, FR-024).
 *
 * UX:
 *   - current-password field auto-focused on mount (per FR-024
 *     primary-input table — the user's intent is to confirm they
 *     own the account first)
 *   - new-password + confirm-password with live strength indicator
 *     (client-side heuristic only; server runs HIBP)
 *   - On success: toast + stays on the page (the cookie
 *     rotation happened server-side, so no navigation needed)
 *   - On `wrong-current-password`: inline error + focus moves back
 *     to current-password
 *   - On `same-password`: inline error on new-password
 *   - On `weak-password` / `breached`: inline error on new-password
 *   - AURA fields (spec 122 US2): `PasswordField`, `FormErrorSummary`
 *     after a failed submit (it takes focus and links to each field, the
 *     server's field errors included), `Button` with `loading`
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { passwordPairFields, refinePasswordPair } from '@/lib/zod-i18n';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';
import { Button, FormErrorSummary, PasswordField } from '@jirawatpyk/aura-react';
import {
  PasswordStrength,
  usePasswordStrengthMeter,
} from './password-strength';

// H2 + O1 (Round 2/3) — schema built inside component via shared
// helpers in src/lib/zod-i18n.ts. I1 (Round 4) — helper signature
// now preserves inferred shape so the cast is dropped.
type FormValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

function buildSchema(
  required: string,
  tooShort: string,
  tooLong: string,
  passwordMismatch: string,
) {
  return refinePasswordPair(
    z.object({
      currentPassword: z.string().min(1, required),
      ...passwordPairFields(tooShort, tooLong),
    }),
    passwordMismatch,
  );
}

export function ChangePasswordForm() {
  const t = useTranslations('auth.changePassword');
  const tReset = useTranslations('auth.resetPassword');
  const tErrors = useTranslations('errors');
  const tv = useTranslations('shared.validation');
  const readOnlyToast = useReadOnlyToast();
  const [submitting, setSubmitting] = useState(false);

  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    reset,
    formState: { errors, submitCount },
  } = useForm<FormValues>({
    resolver: zodResolver(
      buildSchema(
        tv('required'),
        tReset('errors.tooShort'),
        tv('tooLong', { max: 256 }),
        tReset('errors.passwordMismatch'),
      ),
    ),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
    mode: 'onSubmit',
    // The error summary takes focus after a failed submit (spec 122 US2 AS1).
    shouldFocusError: false,
  });

  useEffect(() => {
    setFocus('currentPassword');
  }, [setFocus]);

  const newValue = useWatch({ control, name: 'newPassword' });
  const meter = usePasswordStrengthMeter(newValue ?? '');

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        }),
      });

      if (response.ok) {
        toast.success(t('success'));
        meter.clearRejected();
        reset();
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        issues?: string[];
      };

      if (isReadOnlyRefusal(response.status, body)) {
        readOnlyToast();
        return;
      }

      switch (body.error) {
        case 'wrong-current-password':
          // The error summary that appears with each field error below takes
          // focus and links to the field.
          setError('currentPassword', {
            message: t('errors.wrongCurrent'),
          });
          break;
        case 'same-password':
          setError('newPassword', { message: t('errors.samePassword') });
          break;
        case 'weak-password': {
          const first = body.issues?.[0] ?? 'too-short';
          setError('newPassword', {
            message:
              first === 'breached'
                ? tReset('errors.passwordBreached')
                : tReset('errors.weakPassword'),
          });
          // Pin the strength bar to red for this value so it agrees with the
          // inline error instead of contradicting it.
          meter.markRejected(values.newPassword);
          break;
        }
        case 'rate-limited':
          toast.error(t('errors.rateLimited'));
          break;
        default:
          toast.error(tErrors('generic'));
      }
    } catch {
      toast.error(tErrors('network'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleFormSubmit = (event: FormEvent) => {
    void handleSubmit(onSubmit)(event);
  };

  return (
    <form
      onSubmit={handleFormSubmit}
      // Native fallback POSTs so current/new password stays out of the URL
      // (CWE-598; see tests/unit/auth/auth-forms-post-method.test.tsx).
      method="post"
      className="flex flex-col gap-4"
      noValidate
      aria-busy={submitting}
    >
      <FormErrorSummary errors={errors} focusKey={submitCount} />

      <PasswordField
        id="current-password"
        label={t('currentPasswordLabel')}
        autoComplete="current-password"
        error={errors.currentPassword?.message}
        {...register('currentPassword')}
      />

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
        label={tReset('confirmPasswordLabel')}
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
