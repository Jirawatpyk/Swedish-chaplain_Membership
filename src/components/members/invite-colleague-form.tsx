'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm, Controller } from 'react-hook-form';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Invite colleague form — US5 AS4 (T125).
 *
 * Primary contact invites a secondary contact via F1 invitation flow.
 */

const inviteSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email().max(254),
  role_title: z.string().max(100).optional().default(''),
  preferred_language: z.enum(['en', 'th', 'sv']).optional().default('en'),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

export function InviteColleagueForm() {
  const t = useTranslations('portal.invite');
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: {
      first_name: '',
      last_name: '',
      email: '',
      role_title: '',
      preferred_language: 'en',
    },
  });

  const { errors } = form.formState;

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
        if (data?.error?.code === 'email_taken') {
          toast.error(t('emailTaken'));
        } else if (data?.error?.code === 'forbidden') {
          toast.error(t('notPrimary'));
        } else {
          toast.error(data?.error?.message ?? t('sendError'));
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

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <Card>
        <CardHeader>
          <CardTitle>{t('formTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="first_name">
              {t('fields.firstName')} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="first_name"
              autoComplete="given-name"
              aria-required="true"
              aria-invalid={Boolean(errors.first_name)}
              aria-describedby={errors.first_name ? 'first_name-error' : undefined}
              {...form.register('first_name')}
            />
            {errors.first_name && (
              <p id="first_name-error" role="alert" className="mt-1 text-caption text-destructive">
                {errors.first_name.message}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="last_name">
              {t('fields.lastName')} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="last_name"
              autoComplete="family-name"
              aria-required="true"
              aria-invalid={Boolean(errors.last_name)}
              aria-describedby={errors.last_name ? 'last_name-error' : undefined}
              {...form.register('last_name')}
            />
            {errors.last_name && (
              <p id="last_name-error" role="alert" className="mt-1 text-caption text-destructive">
                {errors.last_name.message}
              </p>
            )}
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="email">
              {t('fields.email')} <span className="text-destructive">*</span>
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              aria-required="true"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'email-error' : undefined}
              {...form.register('email')}
            />
            {errors.email && (
              <p id="email-error" role="alert" className="mt-1 text-caption text-destructive">
                {errors.email.message}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="role_title">{t('fields.roleTitle')}</Label>
            <Input
              id="role_title"
              autoComplete="organization-title"
              {...form.register('role_title')}
            />
          </div>
          <div>
            <Label htmlFor="preferred_language">
              {t('fields.preferredLanguage')}
            </Label>
            {/* W-9: Use Controller for proper RHF integration */}
            <Controller
              control={form.control}
              name="preferred_language"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="preferred_language">
                    <SelectValue />
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

      <div className="mt-6 flex items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? t('sending') : t('sendButton')}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push('/portal/profile')}
        >
          {t('cancelButton')}
        </Button>
      </div>
    </form>
  );
}
