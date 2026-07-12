'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequiredMark } from '@/components/ui/required-mark';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
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
 */

function buildEditSchema(tv: Translator) {
  return z.object({
    firstName: requiredText(tv, 100),
    lastName: requiredText(tv, 100),
    phone: boundedText(tv, 20).optional().default(''),
    preferredLanguage: z.enum(['en', 'th', 'sv']),
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
  const tLang = useTranslations('common');
  const tv = useTranslations('shared.validation');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const editSchema = useMemo(() => buildEditSchema(tv as Translator), [tv]);

  const form = useForm<EditFormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: initialValues,
  });

  const { errors } = form.formState;

  const onSubmit = async (values: EditFormValues) => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};

      // Contact fields
      const contactPatch: Record<string, unknown> = {};
      if (values.firstName !== initialValues.firstName) contactPatch.firstName = values.firstName;
      if (values.lastName !== initialValues.lastName) contactPatch.lastName = values.lastName;
      if (values.phone !== initialValues.phone) contactPatch.phone = values.phone || null;
      if (values.preferredLanguage !== initialValues.preferredLanguage)
        contactPatch.preferredLanguage = values.preferredLanguage;
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
        // Surface a field-scoped server rejection INLINE (audit XF-01): map the
        // first validation issue whose path tail matches a form field, else
        // fall back to a toast. The form's field names match the server keys.
        const issues: unknown = data?.error?.details;
        if (data?.error?.code === 'validation_error' && Array.isArray(issues)) {
          const FIELDS: ReadonlyArray<keyof EditFormValues> = [
            'firstName',
            'lastName',
            'phone',
            'preferredLanguage',
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
              // is the same leak XF-02 fixed for refund. The inline highlight +
              // focus tells the user which field; the message stays localised.
              form.setError(field, { type: 'server', message: t('saveError') });
              form.setFocus(field);
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
    <form onSubmit={form.handleSubmit(onSubmit)} method="post" noValidate>
      <div className="space-y-6">
        {/* Contact fields */}
        <Card>
          <CardHeader>
            <CardTitle>{t('contactSection')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="firstName">
                {t('fields.firstName')} <RequiredMark />
              </Label>
              <Input
                id="firstName"
                autoFocus
                autoComplete="given-name"
                aria-required="true"
                aria-invalid={Boolean(errors.firstName)}
                aria-describedby={errors.firstName ? 'firstName-error' : undefined}
                {...form.register('firstName')}
              />
              {errors.firstName && (
                <p id="firstName-error" role="alert" className="mt-1 text-caption text-destructive">
                  {errors.firstName.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="lastName">
                {t('fields.lastName')} <RequiredMark />
              </Label>
              <Input
                id="lastName"
                autoComplete="family-name"
                aria-required="true"
                aria-invalid={Boolean(errors.lastName)}
                aria-describedby={errors.lastName ? 'lastName-error' : undefined}
                {...form.register('lastName')}
              />
              {errors.lastName && (
                <p id="lastName-error" role="alert" className="mt-1 text-caption text-destructive">
                  {errors.lastName.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="phone">{t('fields.phone')}</Label>
              <Input
                id="phone"
                type="tel"
                autoComplete="tel"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? 'phone-error' : undefined}
                {...form.register('phone')}
              />
              {errors.phone && (
                <p id="phone-error" role="alert" className="mt-1 text-caption text-destructive">
                  {errors.phone.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="preferredLanguage">{t('fields.preferredLanguage')}</Label>
              {/* W-9: Use Controller for proper RHF integration */}
              <Controller
                control={form.control}
                name="preferredLanguage"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="preferredLanguage" className="w-full">
                      <TranslatedSelectValue
                        translate={(value: string) =>
                          tLang(`languageOptions.${value as 'en' | 'th' | 'sv'}`)
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {/* W-7: i18n language option labels */}
                      <SelectItem value="en">{tLang('languageOptions.en')}</SelectItem>
                      <SelectItem value="th">{tLang('languageOptions.th')}</SelectItem>
                      <SelectItem value="sv">{tLang('languageOptions.sv')}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* Member fields */}
        <Card>
          <CardHeader>
            <CardTitle>{t('companySection')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div>
              <Label htmlFor="website">{t('fields.website')}</Label>
              <Input
                id="website"
                type="url"
                autoComplete="url"
                placeholder="https://"
                aria-invalid={Boolean(errors.website)}
                aria-describedby={errors.website ? 'website-error' : undefined}
                {...form.register('website')}
              />
              {errors.website && (
                <p id="website-error" role="alert" className="mt-1 text-caption text-destructive">
                  {errors.website.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="description">{t('fields.description')}</Label>
              <Textarea
                id="description"
                rows={4}
                aria-invalid={Boolean(errors.description)}
                aria-describedby={
                  errors.description
                    ? 'description-error description-count'
                    : 'description-count'
                }
                {...form.register('description')}
              />
              {errors.description && (
                <p
                  id="description-error"
                  role="alert"
                  className="mt-1 text-caption text-destructive"
                >
                  {errors.description.message}
                </p>
              )}
              {/* Associated via aria-describedby so a SR reads the count on
                * focus — but NOT a live region: a per-keystroke aria-live
                * would announce "1/2000, 2/2000, …" on every character. */}
              <p
                id="description-count"
                className="mt-1 text-caption text-muted-foreground"
              >
                {form.watch('description')?.length ?? 0}/2000
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Actions — H5: justify-end + Cancel before Submit (ux-standards § 11.1). */}
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="outline" onClick={() => router.push('/portal/profile')}>
            {t('cancelButton')}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" aria-hidden="true" />
                {t('saving')}
              </>
            ) : (
              t('saveButton')
            )}
          </Button>
        </div>
      </div>
    </form>
  );
}
