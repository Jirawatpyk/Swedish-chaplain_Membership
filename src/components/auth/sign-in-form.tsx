'use client';

/**
 * SignInForm — credentials entry for staff and member portals (T072).
 *
 * Uses react-hook-form + zod for client-side validation and shadcn
 * Input/Label/Button for consistent styling. The shadcn `form` wrapper
 * is no longer in the registry under base-nova; we compose RHF
 * primitives directly.
 *
 * UX requirements (spec FR-024 + ux-standards § 8 + § 11):
 *   - Email field has auto-focus on mount
 *   - Enter submits the form
 *   - Submit button shows in-place spinner state
 *   - Inline error messages localised via next-intl
 *   - On submission failure, focus moves to the first invalid field
 *     (or the email if the failure is "invalid-credentials")
 *   - All toasts are routed through `sonner` (see RootLayout)
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmailInput } from '@/components/ui/email-input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { safeReturnTo } from '@/lib/return-url';
import { emailText, requiredText, type Translator } from '@/lib/zod-i18n';

function buildSignInSchema(tv: Translator) {
  return z.object({
    email: emailText(tv, 254),
    password: requiredText(tv, 256),
  });
}

type FormValues = z.infer<ReturnType<typeof buildSignInSchema>>;

export interface SignInFormProps {
  readonly portal: 'staff' | 'member';
  /**
   * Optional validated return path from the sign-in page's server
   * component. Server-side validation via `safeReturnTo()` has already
   * run; we re-validate client-side as defense-in-depth.
   */
  readonly returnTo?: string | null;
}

export function SignInForm({ portal, returnTo }: SignInFormProps) {
  const t = useTranslations('auth.signIn');
  const tErrors = useTranslations('errors');
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const schema = useMemo(() => buildSignInSchema(tv as Translator), [tv]);

  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
  });

  // Auto-focus the email field on mount (spec FR-024 primary-input table).
  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    setSubmitting(true);
    try {
      const response = await fetch('/api/auth/sign-in', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, portal }),
      });

      if (response.ok) {
        const data = (await response.json()) as { redirect: string };
        // Re-validate returnTo client-side before navigation (defense
        // in depth — the server already validated via safeReturnTo in
        // the sign-in page's server component, but we re-check here
        // so any future refactor that forgets the guard still stays
        // safe).
        const safeReturn = returnTo ? safeReturnTo(returnTo, portal) : null;
        router.push(safeReturn ?? data.redirect);
        router.refresh();
        return;
      }

      const errorBody = (await response.json().catch(() => ({}))) as { error?: string };
      const errorCode = errorBody.error ?? 'invalid-credentials';

      // Surface every server rejection in the inline root banner (+ focus the
      // email) so the reason persists on-page and is announced — a toast can be
      // missed/dismissed and isn't associated with the form (audit XF-01).
      // invalid-credentials stays generic so neither field is revealed (FR-016).
      const messageByCode: Record<string, string> = {
        'account-disabled': t('errors.accountDisabled'),
        'account-locked': t('errors.accountLocked'),
        'rate-limited': t('errors.rateLimited'),
        'invalid-credentials': t('errors.invalidCredentials'),
      };
      setError('root', {
        message: messageByCode[errorCode] ?? t('errors.invalidCredentials'),
      });
      setFocus('email');
    } catch {
      toast.error(tErrors('network'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      // Native (pre-hydration) fallback MUST be POST so credentials land in
      // the request body, never the URL query string. CWE-598 — see
      // tests/unit/auth/auth-forms-post-method.test.tsx. Inert once hydrated
      // (RHF handleSubmit calls preventDefault).
      method="post"
      className="space-y-4"
      noValidate
      aria-busy={submitting}
    >
      <div className="space-y-2">
        <Label htmlFor="email">{t('emailLabel')}</Label>
        <EmailInput
          id="email"
          autoComplete="username"
          spellCheck={false}
          // Associate with the inline error AND the root server-rejection banner,
          // since a failed sign-in focuses this field (audit XF-01 / WCAG 3.3.1).
          aria-invalid={errors.email || errors.root ? 'true' : undefined}
          aria-describedby={
            [errors.email ? 'email-error' : null, errors.root ? 'signin-error' : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          {...register('email')}
        />
        {errors.email ? (
          <p id="email-error" role="alert" className="text-sm text-destructive">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">{t('passwordLabel')}</Label>
          <a
            href="/forgot-password"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {t('forgotPassword')}
          </a>
        </div>
        <PasswordInput
          id="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? 'true' : undefined}
          aria-describedby={errors.password ? 'password-error' : undefined}
          {...register('password')}
        />
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

      {errors.root ? (
        <div
          id="signin-error"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {errors.root.message}
        </div>
      ) : null}

      <Button type="submit" className="w-full" size="lg" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2Icon
              className="size-4 motion-safe:animate-spin"
              aria-hidden
            />
            {t('submitting')}
          </>
        ) : (
          t('submit')
        )}
      </Button>
    </form>
  );
}
