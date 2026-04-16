'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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

  const onSubmit = async (values: EditFormValues) => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {};

      // Contact fields
      const contactPatch: Record<string, unknown> = {};
      if (values.firstName !== initialValues.firstName)
        contactPatch.firstName = values.firstName;
      if (values.lastName !== initialValues.lastName)
        contactPatch.lastName = values.lastName;
      if (values.phone !== initialValues.phone)
        contactPatch.phone = values.phone || null;
      if (values.preferredLanguage !== initialValues.preferredLanguage)
        contactPatch.preferredLanguage = values.preferredLanguage;
      if (Object.keys(contactPatch).length > 0)
        body.primary_contact = contactPatch;

      // Member fields
      if (values.website !== initialValues.website)
        body.website = values.website || null;
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
      router.push('/portal/profile');
      router.refresh();
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
                {...form.register('firstName')}
              />
              {form.formState.errors.firstName && (
                <p className="mt-1 text-caption text-destructive">
                  {form.formState.errors.firstName.message}
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
                {...form.register('lastName')}
              />
              {form.formState.errors.lastName && (
                <p className="mt-1 text-caption text-destructive">
                  {form.formState.errors.lastName.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="phone">{t('fields.phone')}</Label>
              <Input
                id="phone"
                type="tel"
                autoComplete="tel"
                {...form.register('phone')}
              />
            </div>
            <div>
              <Label htmlFor="preferredLanguage">
                {t('fields.preferredLanguage')}
              </Label>
              <Select
                value={form.watch('preferredLanguage')}
                onValueChange={(v) =>
                  form.setValue('preferredLanguage', v as 'en' | 'th' | 'sv')
                }
              >
                <SelectTrigger id="preferredLanguage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="th">ไทย</SelectItem>
                  <SelectItem value="sv">Svenska</SelectItem>
                </SelectContent>
              </Select>
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
                {...form.register('website')}
              />
            </div>
            <div>
              <Label htmlFor="description">{t('fields.description')}</Label>
              <Textarea
                id="description"
                rows={4}
                {...form.register('description')}
              />
              <p className="mt-1 text-caption text-muted-foreground">
                {form.watch('description')?.length ?? 0}/2000
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('saving') : t('saveButton')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push('/portal/profile')}
          >
            {t('cancelButton')}
          </Button>
        </div>
      </div>
    </form>
  );
}
