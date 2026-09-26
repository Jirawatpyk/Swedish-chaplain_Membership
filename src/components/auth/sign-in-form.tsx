'use client';

/**
 * SignInForm — credentials entry for staff and member portals (T072).
 *
 * Uses react-hook-form + zod for client-side validation on AURA fields
 * (spec 122 US2): `TextField` / `PasswordField` (the show/hide toggle
 * announces its state), `FormErrorSummary` after a failed submit, an AURA
 * `Alert` for a server rejection and `Button` with `loading`.
 *
 * UX requirements (spec FR-024 + ux-standards § 8 + § 11):
 *   - Email field has auto-focus on mount
 *   - Enter submits the form
 *   - Submit button shows in-place spinner state
 *   - Inline error messages localised via next-intl
 *   - On a validation failure the error summary takes focus and links to
 *     each field; on a server rejection focus moves to the email
 *   - All toasts are routed through `@/lib/toast` (AURA; see AuraBridge)
 */
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { zodResolver } from '@hookform/resolvers/zod';
import { type SubmitHandler, useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from '@/lib/toast';
import { Alert, Button, FormErrorSummary, PasswordField, TextField } from '@jirawatpyk/aura-react';
import { useSubmittedErrors } from './use-submitted-errors';
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
    clearErrors,
    setFocus,
    formState: { errors, submitCount },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
    // The error summary takes focus after a failed submit (spec 122 US2 AS1).
    shouldFocusError: false,
  });
  const summary = useSubmittedErrors<FormValues>();

  // Auto-focus the email field on mount (spec FR-024 primary-input table).
  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  const onSubmit: SubmitHandler<FormValues> = async (values) => {
    summary.clear();
    setSubmitting(true);
    // Clear any prior server-rejection banner so it can't linger next to a
    // different outcome (e.g. a later network throw) on a fresh attempt.
    clearErrors('root');
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

      // Surface every server rejection in the inline root banner (+ focus the
      // email) so the reason persists on-page and is announced — a toast can be
      // missed/dismissed and isn't associated with the form (audit XF-01).
      // invalid-credentials stays generic so neither field is revealed (FR-016).
      // Anything else — a 500 `server-error`, a 400 `invalid-input`, or a body
      // with no code at all — is OUR failure, not wrong credentials: telling the
      // user their password is wrong would send them to reset a good one.
      const messageByCode: Record<string, string> = {
        'account-disabled': t('errors.accountDisabled'),
        'account-locked': t('errors.accountLocked'),
        'rate-limited': t('errors.rateLimited'),
        'invalid-credentials': t('errors.invalidCredentials'),
      };
      setError('root', {
        message:
          (errorBody.error !== undefined ? messageByCode[errorBody.error] : undefined) ??
          tErrors('generic'),
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
      onSubmit={handleSubmit(onSubmit, summary.onInvalid)}
      // Native (pre-hydration) fallback MUST be POST so credentials land in
      // the request body, never the URL query string. CWE-598 — see
      // tests/unit/auth/auth-forms-post-method.test.tsx. Inert once hydrated
      // (RHF handleSubmit calls preventDefault).
      method="post"
      className="flex flex-col gap-4"
      noValidate
      aria-busy={submitting}
    >
      <FormErrorSummary errors={summary.errors} focusKey={submitCount} />

      <TextField
        id="email"
        label={t('emailLabel')}
        type="email"
        inputMode="email"
        autoComplete="username"
        spellCheck={false}
        error={errors.email?.message}
        // aria-invalid only for an actual email-FORMAT error (AURA sets it from
        // `error`) — a server rejection (bad credentials / account state)
        // doesn't mean the email is malformed. But the focused field IS
        // described by the rejection so a SR user hears the reason (audit
        // XF-01 / WCAG 3.3.1).
        aria-describedby={errors.root ? 'signin-error' : undefined}
        {...register('email')}
      />

      <div className="flex flex-col">
        <PasswordField
          id="password"
          label={t('passwordLabel')}
          autoComplete="current-password"
          error={errors.password?.message}
          {...register('password')}
        />
        {/* Under the field, not beside its label as the boards draw it: there
            it is a 20px target flush against the input, and it would sit
            before the field visually but after it in tab order. Here it is
            44px tall and visual order is tab order. */}
        <a
          href="/forgot-password"
          className="inline-flex min-h-11 items-center self-end text-[13px] font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
        >
          {t('forgotPassword')}
        </a>
      </div>

      {errors.root ? (
        <div id="signin-error">
          <Alert tone="danger">{errors.root.message}</Alert>
        </div>
      ) : null}

      <div className="flex flex-col">
        <Button type="submit" variant="primary" loading={submitting}>
          {submitting ? t('submitting') : t('submit')}
        </Button>
      </div>
    </form>
  );
}
