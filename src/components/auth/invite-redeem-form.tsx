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
import { Label } from '@/components/ui/label';
import {
  PasswordStrength,
  type PasswordStrengthLevel,
} from './password-strength';

const schema = z
  .object({
    displayName: z.string().min(1).max(120),
    password: z.string().min(12).max(1000),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords must match',
  });

type FormValues = z.infer<typeof schema>;

export interface InviteRedeemFormProps {
  readonly token: string;
  readonly email: string;
}

function estimateStrength(password: string): PasswordStrengthLevel {
  if (password.length === 0) return 'empty';
  if (password.length < 12) return 'weak';
  if (password.length >= 16 && /[^a-zA-Z0-9]/.test(password)) return 'strong';
  return 'acceptable';
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
    resolver: zodResolver(schema),
    defaultValues: { displayName: '', password: '', confirmPassword: '' },
    mode: 'onSubmit',
  });

  useEffect(() => {
    setFocus('displayName');
  }, [setFocus]);

  const passwordValue = useWatch({ control, name: 'password' });
  const strength = estimateStrength(passwordValue ?? '');

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
    return (
      <div
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
        role="alert"
      >
        <p className="text-sm text-destructive">{t('errors.tokenExpired')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleFormSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" value={email} readOnly disabled />
      </div>

      <div className="space-y-2">
        <Label htmlFor="display-name">{t('displayNameLabel')}</Label>
        <Input
          id="display-name"
          type="text"
          autoComplete="name"
          aria-invalid={errors.displayName ? 'true' : undefined}
          {...register('displayName')}
        />
        {errors.displayName ? (
          <p className="text-sm text-destructive">{errors.displayName.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">{t('passwordLabel')}</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.password ? 'true' : undefined}
          {...register('password')}
        />
        <PasswordStrength level={strength} />
        {errors.password ? (
          <p className="text-sm text-destructive">{errors.password.message}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">{tReset('confirmPasswordLabel')}</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.confirmPassword ? 'true' : undefined}
          {...register('confirmPassword')}
        />
        {errors.confirmPassword ? (
          <p className="text-sm text-destructive">
            {errors.confirmPassword.message}
          </p>
        ) : null}
      </div>

      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2Icon className="size-4 animate-spin" aria-hidden />
            {t('submit')}
          </>
        ) : (
          t('submit')
        )}
      </Button>
    </form>
  );
}
