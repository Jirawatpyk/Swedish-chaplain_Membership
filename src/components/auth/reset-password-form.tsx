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
    newPassword: z.string().min(12, 'Must be at least 12 characters').max(1000),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords must match',
  });

type FormValues = z.infer<typeof schema>;

export interface ResetPasswordFormProps {
  readonly token: string;
}

/** Heuristic strength used in the client-side indicator. */
function estimateStrength(password: string): PasswordStrengthLevel {
  if (password.length === 0) return 'empty';
  if (password.length < 12) return 'weak';
  if (password.length >= 16 && /[^a-zA-Z0-9]/.test(password)) return 'strong';
  return 'acceptable';
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const t = useTranslations('auth.resetPassword');
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
    defaultValues: { newPassword: '', confirmPassword: '' },
    mode: 'onSubmit',
  });

  useEffect(() => {
    setFocus('newPassword');
  }, [setFocus]);

  const newPasswordValue = useWatch({ control, name: 'newPassword' });
  const strength = estimateStrength(newPasswordValue ?? '');

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
        setFocus('newPassword');
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
    return (
      <div
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
        role="alert"
      >
        <p className="text-sm text-destructive">{t('errors.tokenExpired')}</p>
        <a
          href="/forgot-password"
          className="inline-flex h-10 w-full items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {t('submit')}
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleDirectSubmit} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="new-password">{t('newPasswordLabel')}</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          aria-invalid={errors.newPassword ? 'true' : undefined}
          {...register('newPassword')}
        />
        <PasswordStrength level={strength} />
        {errors.newPassword ? (
          <p className="text-sm text-destructive">
            {errors.newPassword.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">{t('confirmPasswordLabel')}</Label>
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
