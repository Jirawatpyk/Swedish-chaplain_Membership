'use client';

/**
 * ForgotPasswordForm (T103, spec US3 AS1, FR-024 / FR-025).
 *
 * UX:
 *   - Email field auto-focused on mount (FR-024 primary-input rule).
 *   - On submit, the form shows the neutral "if the email is
 *     registered, a link has been sent" message — NEVER distinguishes
 *     between known and unknown emails (FR-016 enumeration guard).
 *   - After submission, a 60-second countdown gates the resend
 *     affordance (FR-025 / SC-017). Until the countdown expires, the
 *     resend link is disabled and shows the remaining seconds.
 *   - Rate-limited responses (429) surface a toast + temporarily
 *     disable the submit button.
 *   - Keyboard: Enter submits. Esc is a no-op (spec explicitly does
 *     NOT want Esc to clear the form since that is surprising).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const schema = z.object({
  email: z.string().email().max(254),
});

type FormValues = z.infer<typeof schema>;

const RESEND_COUNTDOWN_SECONDS = 60;

export function ForgotPasswordForm() {
  const t = useTranslations('auth.forgotPassword');
  const tErrors = useTranslations('errors');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const {
    register,
    handleSubmit,
    setFocus,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
    mode: 'onSubmit',
  });

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  const startCountdown = useCallback(() => {
    setRemaining(RESEND_COUNTDOWN_SECONDS);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setRemaining((previous) => {
        if (previous <= 1) {
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return 0;
        }
        return previous - 1;
      });
    }, 1000);
  }, []);

  const sendRequest = useCallback(
    async (email: string) => {
      setSubmitting(true);
      try {
        const response = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        if (response.status === 429) {
          toast.error(tErrors('generic'));
          return;
        }
        if (!response.ok) {
          toast.error(tErrors('generic'));
          return;
        }
        setSubmitted(true);
        startCountdown();
      } catch {
        toast.error(tErrors('network'));
      } finally {
        setSubmitting(false);
      }
    },
    [startCountdown, tErrors],
  );

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    await sendRequest(values.email);
  };

  const handleResend = useCallback(async () => {
    const { email } = getValues();
    if (!email) return;
    await sendRequest(email);
  }, [getValues, sendRequest]);

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="space-y-2">
        <Label htmlFor="email">{t('emailLabel')}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username"
          disabled={submitting || submitted}
          aria-invalid={errors.email ? 'true' : undefined}
          aria-describedby={errors.email ? 'email-error' : undefined}
          {...register('email')}
        />
        {errors.email ? (
          <p id="email-error" role="alert" className="text-sm text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      {submitted ? (
        <div
          className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
          role="status"
        >
          {t('submitted')}
        </div>
      ) : null}

      {!submitted ? (
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
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          size="lg"
          onClick={handleResend}
          disabled={remaining > 0 || submitting}
        >
          {remaining > 0
            ? t('resendCountdown', { seconds: remaining })
            : t('resend')}
        </Button>
      )}
    </form>
  );
}
