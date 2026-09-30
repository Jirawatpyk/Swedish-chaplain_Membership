'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';
import { SendIcon } from 'lucide-react';
import { Button, FormErrorSummary, Select, TextField } from '@jirawatpyk/aura-react';
import { Alert, Card } from '@jirawatpyk/aura-react/server';
import {
  boundedText,
  emailText,
  requiredText,
  type Translator,
} from '@/lib/zod-i18n';

/**
 * Invite colleague form — US5 AS4 (T125).
 *
 * Primary contact invites a secondary contact via F1 invitation flow.
 *
 * Spec 122 US3 (`Portal-contacts-invite`): AURA card, fields and Select;
 * `FormErrorSummary` after a failed submit (client or server field errors —
 * it takes focus, so server errors no longer call `setFocus`). The card
 * opens with what a colleague can do, marks the one optional field (the
 * required ones stay `aria-required`), says where the colleague's details
 * are kept, and ends with Cancel + Send as plain buttons (decision
 * 2026-09-27: full width with Send on top below 640 px).
 */
export interface InviteColleagueFormProps {
  /** The tenant's privacy notice; null → the note names it without a link (never a dead link). */
  readonly privacyNoticeHref?: string | null;
}

function buildInviteSchema(tv: Translator) {
  return z.object({
    first_name: requiredText(tv, 100),
    last_name: requiredText(tv, 100),
    email: emailText(tv, 254),
    role_title: boundedText(tv, 100).optional().default(''),
    preferred_language: z.enum(['en', 'th', 'sv']).optional().default('en'),
  });
}

type InviteFormValues = z.infer<ReturnType<typeof buildInviteSchema>>;

export function InviteColleagueForm({ privacyNoticeHref = null }: InviteColleagueFormProps = {}) {
  const t = useTranslations('portal.invite');
  const readOnlyToast = useReadOnlyToast();
  const tLang = useTranslations('common');
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const inviteSchema = useMemo(
    () => buildInviteSchema(tv as Translator),
    [tv],
  );

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      first_name: '',
      last_name: '',
      email: '',
      role_title: '',
      preferred_language: 'en',
    },
    // the error summary takes focus after a failed submit, not the field
    shouldFocusError: false,
  });

  const { errors, submitCount } = form.formState;
  const firstName = useWatch({ control: form.control, name: 'first_name' }).trim();

  const onSubmit = async (values: InviteFormValues) => {
    setSubmitting(true);
    try {
      const body = {
        ...values,
        role_title: values.role_title || null,
      };

      const res = await fetch('/api/portal/contacts/invite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (isReadOnlyRefusal(res.status, data)) {
          readOnlyToast();
          return;
        }
        const code = data?.error?.code;
        if (code === 'email_taken') {
          // Field-scoped — surface inline on the email input (and in the error
          // summary, which takes focus) rather than a transient toast (audit
          // XF-01). Only returned when the
          // address is already a contact of the member's OWN company.
          form.setError('email', { type: 'server', message: t('emailTaken') });
        } else if (code === 'invite_unavailable') {
          // Neutral on purpose (account-enumeration guard): the server does
          // not say WHY this address can't be invited, so neither do we.
          form.setError('email', { type: 'server', message: t('inviteUnavailable') });
        } else if (code === 'invalid_email') {
          // Field-scoped like email_taken — the server rejected the address,
          // so highlight the email input (the summary takes focus) with a LOCALISED message
          // instead of toasting the server's raw "Invalid email address".
          form.setError('email', { type: 'server', message: t('invalidEmail') });
        } else if (code === 'forbidden') {
          toast.error(t('notPrimary'));
        } else if (code === 'link_failed') {
          // go-live #12-13 (follow-up) — the invite was rolled back; retry is safe.
          toast.error(t('linkFailed'));
        } else if (code === 'validation_error') {
          // The route returns `validation_error` with `details` but NO message,
          // so the old `data.error.message` passthrough rendered `undefined`.
          // Use a localized message.
          toast.error(t('validationError'));
        } else {
          // Never toast the server's raw English — a generic localized message.
          toast.error(t('sendError'));
        }
        return;
      }

      toast.success(t('sendSuccess'));
      // S-3: router.push triggers a fresh server render — no refresh() needed
      router.push('/portal/profile');
    } catch {
      toast.error(t('sendError'));
    } finally {
      setSubmitting(false);
    }
  };

  const privacyLink = (chunks: React.ReactNode) =>
    privacyNoticeHref ? (
      <a
        href={privacyNoticeHref}
        target="_blank"
        rel="noreferrer"
        className="text-[var(--aura-fg-accent)] underline underline-offset-4 hover:text-[var(--aura-fg-primary)]"
      >
        {chunks}
      </a>
    ) : (
      chunks
    );

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} method="post" noValidate className="flex flex-col gap-4">
      <FormErrorSummary errors={errors} focusKey={submitCount} />
      <Card title={t('formTitle')} titleId="invite-colleague-heading" headingLevel={2}>
        <div className="flex flex-col gap-4">
          <Alert tone="info" role="note" title={t('capabilities.title')}>
            {t('capabilities.body')}
          </Alert>
          <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-4">
            {/* Focused on mount (ux-standards § 7.2), like the auth / PII forms.
                `autoFocus`, not an effect calling setFocus: a late effect could
                pull focus back off the error summary. Required without the
                asterisk (the board marks the optional field instead). */}
            <TextField
              id="first_name"
              label={t('fields.firstName')}
              aria-required
              autoFocus
              autoComplete="given-name"
              error={errors.first_name?.message}
              {...form.register('first_name')}
            />
            <TextField
              id="last_name"
              label={t('fields.lastName')}
              aria-required
              autoComplete="family-name"
              error={errors.last_name?.message}
              {...form.register('last_name')}
            />
            {/* type + inputMode + autoComplete: the @-keyboard on phones
                (ux-standards § 11.2, audit XF-06) — what EmailInput baked in */}
            <TextField
              id="email"
              className="sm:col-span-2"
              type="email"
              inputMode="email"
              autoComplete="email"
              label={t('fields.email')}
              hint={t('emailHint')}
              aria-required
              error={errors.email?.message}
              {...form.register('email')}
            />
            <TextField
              id="role_title"
              label={t('fields.roleTitle')}
              optional
              hint={t('roleTitleHint')}
              autoComplete="organization-title"
              error={errors.role_title?.message}
              {...form.register('role_title')}
            />
            <Select
              id="preferred_language"
              label={t('fields.preferredLanguage')}
              options={(['en', 'th', 'sv'] as const).map((v) => ({ value: v, label: tLang(`languageOptions.${v}`) }))}
              {...form.register('preferred_language')}
            />
          </div>
          <p className="aura-text-table-cell text-[var(--aura-fg-secondary)]" data-testid="invite-privacy-note">
            {firstName
              ? t.rich('privacyNote', { firstName, link: privacyLink })
              : t.rich('privacyNoteNoName', { link: privacyLink })}
          </p>
          {/* Cancel before Send (ux-standards § 11.1, and the tab order); Send on top on phones. */}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end sm:gap-3">
            <Button type="button" variant="secondary" onClick={() => router.push('/portal/profile')}>
              {t('cancelButton')}
            </Button>
            <Button type="submit" icon={<SendIcon aria-hidden />} loading={submitting}>
              {submitting ? t('sending') : t('sendButton')}
            </Button>
          </div>
        </div>
      </Card>
    </form>
  );
}
