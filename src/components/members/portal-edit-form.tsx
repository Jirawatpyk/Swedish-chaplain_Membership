'use client';

import { useState } from 'react';
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
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';

/**
 * Portal edit form — US5 AS2 (T124).
 *
 * Only shows whitelisted fields per FR-042 — forbidden fields are
 * hidden entirely, not shown disabled.
 */

const editSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  phone: z.string().max(20).optional().default(''),
  preferredLanguage: z.enum(['en', 'th', 'sv']),
  website: z.string().max(200).optional().default(''),
  description: z.string().max(2000).optional().default(''),
});

type EditFormValues = z.infer<typeof editSchema>;

type PortalEditFormProps = {
  initialValues: EditFormValues;
};

export function PortalEditForm({ initialValues }: PortalEditFormProps) {
  const t = useTranslations('portal.edit');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

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
        toast.error(data?.error?.message ?? t('saveError'));
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
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <div className="space-y-6">
        {/* Contact fields */}
        <Card>
          <CardHeader>
            <CardTitle>{t('contactSection')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="firstName">
                {t('fields.firstName')} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="firstName"
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
                {t('fields.lastName')} <span className="text-destructive">*</span>
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
                    <SelectTrigger id="preferredLanguage">
                      <TranslatedSelectValue
                        translate={(value: string) =>
                          t(`languageOptions.${value as 'en' | 'th' | 'sv'}`)
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {/* W-7: i18n language option labels */}
                      <SelectItem value="en">{t('languageOptions.en')}</SelectItem>
                      <SelectItem value="th">{t('languageOptions.th')}</SelectItem>
                      <SelectItem value="sv">{t('languageOptions.sv')}</SelectItem>
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
                aria-describedby={errors.description ? 'description-error' : undefined}
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
              <p className="mt-1 text-caption text-muted-foreground">
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
