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
 *   - On success: sonner toast + stays on the page (the cookie
 *     rotation happened server-side, so no navigation needed)
 *   - On `wrong-current-password`: inline error + focus moves back
 *     to current-password
 *   - On `same-password`: inline error on new-password
 *   - On `weak-password` / `breached`: inline error on new-password
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { passwordPairFields, refinePasswordPair } from '@/lib/zod-i18n';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import {
  PasswordStrength,
  estimatePasswordStrength,
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
  const [submitting, setSubmitting] = useState(false);

  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    reset,
    formState: { errors },
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
  });

  useEffect(() => {
    setFocus('currentPassword');
  }, [setFocus]);

  const newValue = useWatch({ control, name: 'newPassword' });
  const strength = estimatePasswordStrength(newValue ?? '');

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
        reset();
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        issues?: string[];
      };

      switch (body.error) {
        case 'wrong-current-password':
          setError('currentPassword', {
            message: t('errors.wrongCurrent'),
          });
          setFocus('currentPassword');
          break;
        case 'same-password':
          setError('newPassword', { message: t('errors.samePassword') });
          setFocus('newPassword');
          break;
        case 'weak-password': {
          const first = body.issues?.[0] ?? 'too-short';
          setError('newPassword', {
            message:
              first === 'breached'
                ? tReset('errors.passwordBreached')
                : tReset('errors.weakPassword'),
          });
          setFocus('newPassword');
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
    <form onSubmit={handleFormSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="current-password">{t('currentPasswordLabel')}</Label>
        <PasswordInput
          id="current-password"
          autoComplete="current-password"
          aria-invalid={errors.currentPassword ? 'true' : undefined}
          aria-describedby={
            errors.currentPassword ? 'current-password-error' : undefined
          }
          {...register('currentPassword')}
        />
        {errors.currentPassword ? (
          <p
            id="current-password-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errors.currentPassword.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-password">{t('newPasswordLabel')}</Label>
        <PasswordInput
          id="new-password"
          autoComplete="new-password"
          aria-invalid={errors.newPassword ? 'true' : undefined}
          aria-describedby={
            errors.newPassword
              ? 'new-password-error'
              : 'new-password-strength'
          }
          {...register('newPassword')}
        />
        <div id="new-password-strength">
          <PasswordStrength level={strength} />
        </div>
        {errors.newPassword ? (
          <p
            id="new-password-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errors.newPassword.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">{tReset('confirmPasswordLabel')}</Label>
        <PasswordInput
          id="confirm-password"
          autoComplete="new-password"
          aria-invalid={errors.confirmPassword ? 'true' : undefined}
          aria-describedby={
            errors.confirmPassword ? 'confirm-password-error' : undefined
          }
          {...register('confirmPassword')}
        />
        {errors.confirmPassword ? (
          <p
            id="confirm-password-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errors.confirmPassword.message}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2Icon
              className="size-4 motion-safe:animate-spin"
              aria-hidden
            />
            {t('submit')}
          </>
        ) : (
          t('submit')
        )}
      </Button>
    </form>
  );
}
