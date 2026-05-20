'use client';

/**
 * Phase 5G.2 (F7.1a US7) — Shared admin template form (new + edit).
 *
 * Used by both /admin/broadcasts/templates/new and /admin/broadcasts/
 * templates/[id]/edit. Single-source-of-truth for field shape,
 * validation messages, and API call wiring.
 *
 * MVP body editor: <textarea> with raw HTML input. The Tiptap rich-
 * text editor lands at Phase 5H T113 + replaces the textarea with the
 * same shared editor instance the F7 MVP compose surface uses.
 *
 * a11y:
 *   - semantic <form> + <label htmlFor>
 *   - aria-describedby on every field → help text + per-field error
 *   - role="alert" on submit-failure announcement
 *   - destructive errors highlight + announce live
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

type Locale = 'en' | 'th' | 'sv';

export interface TemplateFormInitial {
  readonly templateId?: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: Locale;
  readonly isSeeded?: boolean;
}

interface Props {
  readonly mode: 'new' | 'edit';
  readonly initial: TemplateFormInitial;
}

export function AdminTemplateForm({ mode, initial }: Props): React.ReactElement {
  const t = useTranslations('admin.broadcasts.templates');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState(initial.name);
  const [subject, setSubject] = useState(initial.subject);
  const [bodyHtml, setBodyHtml] = useState(initial.bodyHtml);
  const [locale, setLocale] = useState<Locale>(initial.locale);
  const [error, setError] = useState<string | null>(null);

  function submit(): void {
    setError(null);
    startTransition(async () => {
      try {
        const isEdit = mode === 'edit' && initial.templateId !== undefined;
        const url = isEdit
          ? `/api/admin/broadcasts/templates/${initial.templateId}`
          : '/api/admin/broadcasts/templates';
        const method = isEdit ? 'PATCH' : 'POST';
        const body = isEdit
          ? { name, subject, bodyHtml }
          : { name, subject, bodyHtml, locale };

        const res = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          const code = payload.error ?? 'unknown';
          const msg = ((): string => {
            try {
              return t(`errors.${code}` as never);
            } catch {
              return t('errors.unknown');
            }
          })();
          setError(msg);
          toast.error(msg);
          return;
        }

        toast.success(
          isEdit ? t('editPageTitle') : t('newPageTitle'),
        );
        router.push('/admin/broadcasts/templates');
        router.refresh();
      } catch (err) {
        // Preserve Error stack for DevTools (Round-3-Final H4 pattern).
        console.error({ err, mode }, 'broadcasts.template.form.submit_failed');
        const msg = t('errors.unknown');
        setError(msg);
        toast.error(msg);
      }
    });
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && subject.trim() && bodyHtml.trim()) submit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="tpl-name">{t('fields.name')}</Label>
        <Input
          id="tpl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          required
          disabled={isPending}
          aria-describedby="tpl-name-help"
        />
        <p id="tpl-name-help" className="text-caption">
          {t('fields.nameHelp')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tpl-subject">{t('fields.subject')}</Label>
        <Input
          id="tpl-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={200}
          required
          disabled={isPending}
          aria-describedby="tpl-subject-help"
        />
        <p id="tpl-subject-help" className="text-caption">
          {t('fields.subjectHelp')}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="tpl-body">{t('fields.bodyHtml')}</Label>
        <Textarea
          id="tpl-body"
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          rows={12}
          required
          disabled={isPending}
          aria-describedby="tpl-body-help"
          className="font-mono text-sm"
        />
        <p id="tpl-body-help" className="text-caption">
          {t('fields.bodyHtmlHelp')}
        </p>
      </div>

      {mode === 'new' ? (
        <div className="space-y-2">
          <Label htmlFor="tpl-locale">{t('fields.localeLabel')}</Label>
          <select
            id="tpl-locale"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
            disabled={isPending}
            className="block w-full rounded-md border border-input bg-background px-3 h-[var(--input-height)] text-sm"
          >
            <option value="en">{t('locale.en')}</option>
            <option value="th">{t('locale.th')}</option>
            <option value="sv">{t('locale.sv')}</option>
          </select>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-3">
        <Button
          type="button"
          variant="ghost"
          disabled={isPending}
          onClick={() => router.push('/admin/broadcasts/templates')}
        >
          {t('cancelButton')}
        </Button>
        <Button
          type="submit"
          disabled={
            isPending || !name.trim() || !subject.trim() || !bodyHtml.trim()
          }
        >
          {isPending ? t('savingButton') : t('saveButton')}
        </Button>
      </div>
    </form>
  );
}
