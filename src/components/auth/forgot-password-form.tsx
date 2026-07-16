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
 *   - Failures (429 rate-limit / non-ok / network) surface an inline
 *     role="alert" banner above the form (never a toast — see
 *     ux-standards § 4.1), on both the first submit and a resend.
 *   - Keyboard: Enter submits. Esc is a no-op (spec explicitly does
 *     NOT want Esc to clear the form since that is surprising).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmailInput } from '@/components/ui/email-input';
import { Label } from '@/components/ui/label';
import { emailText, type Translator } from '@/lib/zod-i18n';

function buildForgotPasswordSchema(tv: Translator) {
  return z.object({
    email: emailText(tv, 254),
  });
}

type FormValues = z.infer<ReturnType<typeof buildForgotPasswordSchema>>;

const RESEND_COUNTDOWN_SECONDS = 60;

export function ForgotPasswordForm() {
  const t = useTranslations('auth.forgotPassword');
  const tErrors = useTranslations('errors');
  const tv = useTranslations('shared.validation');
  // Email-locale audit 2026-07-16 — the reset email must arrive in the language
  // the requester is using (requester = recipient, so the active UI locale is
  // the right signal). The API already accepts an optional `locale`; the form
  // just never sent it, so every reset email shipped English.
  const locale = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Managed focus on the success card so a keyboard/SR user isn't dropped on
  // <body> when the submit button is replaced by the resend button (XF focus).
  const successRef = useRef<HTMLDivElement>(null);

  const schema = useMemo(
    () => buildForgotPasswordSchema(tv as Translator),
    [tv],
  );

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

  // Move focus to the success card when the form swaps to the submitted state
  // (WCAG 2.4.3 — the focused submit button is unmounted).
  useEffect(() => {
    if (submitted) successRef.current?.focus();
  }, [submitted]);

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
      setErrorMsg(null);
      try {
        const response = await fetch('/api/auth/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, locale }),
        });
        if (response.status === 429) {
          // Actionable rate-limit copy instead of a generic "went wrong".
          setErrorMsg(t('rateLimited'));
          return;
        }
        if (!response.ok) {
          setErrorMsg(tErrors('generic'));
          return;
        }
        setSubmitted(true);
        startCountdown();
      } catch {
        setErrorMsg(tErrors('network'));
      } finally {
        setSubmitting(false);
      }
    },
    [startCountdown, t, tErrors, locale],
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
    <form
      onSubmit={handleSubmit(onSubmit)}
      // Keep the email out of the URL on a pre-hydration native submit
      // (CWE-598; see tests/unit/components/pii-forms-post-method.test.tsx).
      method="post"
      className="space-y-4"
      noValidate
    >
      <div className="space-y-2">
        <Label htmlFor="email">{t('emailLabel')}</Label>
        <EmailInput
          id="email"
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

      {/* Gated on errorMsg alone (NOT `!submitted`): a failed RESEND happens
        * while submitted===true, so `!submitted` would swallow it. Each send
        * clears errorMsg first (setErrorMsg(null)), so the success path leaves
        * it null and the banner stays hidden; only a real failure shows it. */}
      {errorMsg ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {errorMsg}
        </div>
      ) : null}

      {submitted ? (
        <div
          ref={successRef}
          tabIndex={-1}
          className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="status"
        >
          <p>{t('submitted')}</p>
          {/* FR-025 user-facing advisory — shown UNCONDITIONALLY (to matched
              and unmatched submitters alike) so it never reveals whether the
              email matched an account (preserves the FR-016 enumeration guard),
              while still helping a real user whose mail was delayed/spam-filed. */}
          <p className="text-muted-foreground">{t('deliveryHint')}</p>
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
          aria-busy={submitting}
        >
          {submitting && (
            <Loader2Icon
              className="size-4 motion-safe:animate-spin"
              aria-hidden
            />
          )}
          {remaining > 0
            ? t('resendCountdown', { seconds: remaining })
            : t('resend')}
        </Button>
      )}
    </form>
  );
}
