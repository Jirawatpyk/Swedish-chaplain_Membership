'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import { useReadOnlyToast } from '@/components/shell/use-read-only-toast';
import { isReadOnlyRefusal } from '@/lib/http/read-only-refusal';
import { ActionBar, Button, FormErrorSummary, TextField, Textarea } from '@jirawatpyk/aura-react';
import { AuraCard } from '@/components/shell/aura-markup';
import {
  boundedText,
  requiredText,
  type Translator,
} from '@/lib/zod-i18n';

/**
 * Portal edit form — US5 AS2 (T124).
 *
 * Only shows whitelisted fields per FR-042 — forbidden fields are
 * hidden entirely, not shown disabled.
 *
 * F114 (FR-004, research R6): the contact's email/notification language
 * (`preferredLanguage`) LEFT this form — it is a personal preference, not a
 * member-record fact, and lives on /portal/account beside the display
 * language. The immediate save semantics of the remaining fields are
 * unchanged (flag-OFF path, SC-011).
 *
 * Spec 122 US3 (`Portal-edit`): AURA cards and fields; `FormErrorSummary`
 * after a failed submit (client or server field errors — it takes focus, so
 * the form no longer calls `setFocus`); Cancel + Save in an `ActionBar` that
 * reads "Unsaved changes" while the form is dirty, so Save stays in reach
 * while scrolling on a phone.
 */

function buildEditSchema(tv: Translator) {
  return z.object({
    firstName: requiredText(tv, 100),
    lastName: requiredText(tv, 100),
    phone: boundedText(tv, 20).optional().default(''),
    website: boundedText(tv, 200).optional().default(''),
    description: boundedText(tv, 2000).optional().default(''),
  });
}

type EditFormValues = z.infer<ReturnType<typeof buildEditSchema>>;

type PortalEditFormProps = {
  initialValues: EditFormValues;
};

export function PortalEditForm({ initialValues }: PortalEditFormProps) {
  const t = useTranslations('portal.edit');
  const tc = useTranslations('common');
  const readOnlyToast = useReadOnlyToast();
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const editSchema = useMemo(() => buildEditSchema(tv as Translator), [tv]);

  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: initialValues,
    // the error summary takes focus after a failed submit, not the field
    shouldFocusError: false,
  });

  const { errors, submitCount, isDirty } = form.formState;
  const descriptionLength = form.watch('description')?.length ?? 0;

  const onSubmit = async (values: EditFormValues) => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};

      // Contact fields
      const contactPatch: Record<string, unknown> = {};
      if (values.firstName !== initialValues.firstName) contactPatch.firstName = values.firstName;
      if (values.lastName !== initialValues.lastName) contactPatch.lastName = values.lastName;
      if (values.phone !== initialValues.phone) contactPatch.phone = values.phone || null;
      if (Object.keys(contactPatch).length > 0) body.primary_contact = contactPatch;

      // Member fields
      if (values.website !== initialValues.website) body.website = values.website || null;
      if (values.description !== initialValues.description)
        body.description = values.description || null;

      if (Object.keys(body).length === 0) {
        toast.info(t('noChanges'));
        setSubmitting(false);
        return;
      }

      const res = await fetch('/api/portal/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        // The write freeze: the typed values stay in the form for the retry.
        if (isReadOnlyRefusal(res.status, data)) {
          readOnlyToast();
          return;
        }
        // Surface a field-scoped server rejection INLINE (audit XF-01): map the
        // first validation issue whose path tail matches a form field, else
        // fall back to a toast. The form's field names match the server keys.
        const issues: unknown = data?.error?.details;
        if (data?.error?.code === 'validation_error' && Array.isArray(issues)) {
          const FIELDS: ReadonlyArray<keyof EditFormValues> = [
            'firstName',
            'lastName',
            'phone',
            'website',
            'description',
          ];
          for (const issue of issues as Array<{ path?: unknown }>) {
            const path = Array.isArray(issue.path) ? issue.path : [];
            const tail = path[path.length - 1];
            const field = FIELDS.find((f) => f === tail);
            if (field) {
              // Use a LOCALISED message, never the server's raw `issue.message`
              // (e.g. "invalid phone: <code>") — rendering the dev token inline
              // is the same leak XF-02 fixed for refund.
              // The inline highlight + the error summary (which takes focus and
              // links to the field) tell the user which field.
              form.setError(field, { type: 'server', message: t('saveError') });
              return;
            }
          }
        }
        // Map the server error CODE to localized copy — never toast the
        // server's raw English `error.message` (e.g. `forbidden` carries the
        // use-case's raw reason). Everything else falls back to saveError.
        const code = data?.error?.code;
        const message =
          code === 'forbidden'
            ? t('forbiddenError')
            : code === 'not_found'
              ? t('notFoundError')
              : t('saveError');
        toast.error(message);
        return;
      }

      toast.success(t('saveSuccess'));
      // S-3: router.push triggers a fresh server render — no refresh() needed
      router.push('/portal/profile');
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} method="post" noValidate className="space-y-6">
      <FormErrorSummary errors={errors} focusKey={submitCount} />

      <AuraCard title={t('contactSection')} titleId="portal-edit-contact-heading" headingLevel={2}>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="firstName"
            label={t('fields.firstName')}
            required
            autoFocus
            autoComplete="given-name"
            error={errors.firstName?.message}
            {...form.register('firstName')}
          />
          <TextField
            id="lastName"
            label={t('fields.lastName')}
            required
            autoComplete="family-name"
            error={errors.lastName?.message}
            {...form.register('lastName')}
          />
          <TextField
            id="phone"
            type="tel"
            label={t('fields.phone')}
            autoComplete="tel"
            error={errors.phone?.message}
            {...form.register('phone')}
          />
        </div>
      </AuraCard>

      <AuraCard title={t('companySection')} titleId="portal-edit-company-heading" headingLevel={2}>
        <div className="grid gap-4">
          <TextField
            id="website"
            type="url"
            label={t('fields.website')}
            autoComplete="url"
            placeholder="https://"
            error={errors.website?.message}
            {...form.register('website')}
          />
          <div>
            <Textarea
              id="description"
              label={t('fields.description')}
              rows={4}
              error={errors.description?.message}
              aria-describedby="description-count"
              {...form.register('description')}
            />
            {/* Associated via aria-describedby so a SR reads the count on
              * focus — but NOT a live region: a per-keystroke aria-live
              * would announce "1/2000, 2/2000, …" on every character. */}
            <p
              id="description-count"
              className="mt-1 text-right text-xs text-[var(--aura-fg-secondary)]"
            >
              {descriptionLength}/2000
            </p>
          </div>
        </div>
      </AuraCard>

      {/* Cancel before Save (ux-standards § 11.1), in the ActionBar. */}
      <ActionBar status={isDirty ? tc('unsavedStatus') : null}>
        <Button type="button" variant="secondary" onClick={() => router.push('/portal/profile')}>
          {t('cancelButton')}
        </Button>
        <Button type="submit" loading={submitting}>
          {submitting ? t('saving') : t('saveButton')}
        </Button>
      </ActionBar>
    </form>
  );
}
