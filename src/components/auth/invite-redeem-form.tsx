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
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import {
  PasswordStrength,
  estimatePasswordStrength,
} from './password-strength';

// H2 (Round 2) — schema built inside component so Zod error messages
// translate per locale.
type FormValues = {
  displayName: string;
  password: string;
  confirmPassword: string;
};

function buildSchema(
  tooShort: string,
  passwordMismatch: string,
): z.ZodType<FormValues> {
  return z
    .object({
      displayName: z.string().min(1).max(120),
      password: z.string().min(12, tooShort).max(256),
      confirmPassword: z.string(),
    })
    .refine((data) => data.password === data.confirmPassword, {
      path: ['confirmPassword'],
      message: passwordMismatch,
    });
}

export interface InviteRedeemFormProps {
  readonly token: string;
  readonly email: string;
}

export function InviteRedeemForm({ token, email }: InviteRedeemFormProps) {
  const t = useTranslations('auth.invite');
  const tReset = useTranslations('auth.resetPassword');
  const tErrors = useTranslations('errors');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);

  const {
    control,
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(
      buildSchema(
        tReset('errors.tooShort'),
        tReset('errors.passwordMismatch'),
      ),
    ),
    defaultValues: { displayName: '', password: '', confirmPassword: '' },
    mode: 'onSubmit',
  });

  useEffect(() => {
    setFocus('displayName');
  }, [setFocus]);

  const passwordValue = useWatch({ control, name: 'password' });
  const strength = estimatePasswordStrength(passwordValue ?? '');

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
        setError('password', {
          message:
            first === 'breached'
              ? tReset('errors.passwordBreached')
              : tReset('errors.weakPassword'),
        });
        setFocus('password');
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
    // M3 (Round 3) — recovery CTA added. Pre-fix this was alert-only;
    // user had no next-step affordance. No self-service link target
    // (invitations are admin-issued only) so we render as a guidance
    // line rather than a clickable button.
    return (
      <div
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
        role="alert"
      >
        <p className="text-sm text-destructive">{t('errors.tokenExpired')}</p>
        <p className="text-sm text-muted-foreground">
          {t('errors.contactAdminCta')}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleFormSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">{t('emailLabel')}</Label>
        <Input id="email" type="email" value={email} readOnly disabled />
      </div>

      <div className="space-y-2">
        <Label htmlFor="display-name">{t('displayNameLabel')}</Label>
        <Input
          id="display-name"
          type="text"
          autoComplete="name"
          aria-invalid={errors.displayName ? 'true' : undefined}
          aria-describedby={
            errors.displayName ? 'display-name-error' : undefined
          }
          {...register('displayName')}
        />
        {errors.displayName ? (
          <p
            id="display-name-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errors.displayName.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">{t('passwordLabel')}</Label>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          aria-invalid={errors.password ? 'true' : undefined}
          aria-describedby={
            errors.password ? 'password-error' : 'password-strength'
          }
          {...register('password')}
        />
        <div id="password-strength">
          <PasswordStrength level={strength} />
        </div>
        {errors.password ? (
          <p
            id="password-error"
            role="alert"
            className="text-sm text-destructive"
          >
            {errors.password.message}
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
