'use client';

/**
 * Shared admin template form (new + edit).
 *
 * Used by both /admin/broadcasts/templates/new and /admin/broadcasts/
 * templates/[id]/edit. Single-source-of-truth for field shape,
 * validation messages, and API call wiring. Body editor reuses the
 * F7 MVP Tiptap instance via `loadTiptapEditor` so paste-sanitiser +
 * bracket-placeholder config stay aligned with the member compose
 * surface.
 *
 * a11y: semantic <form> + <label htmlFor>, aria-describedby on every
 * field, role="alert" on submit-failure announcement, destructive
 * errors highlight + announce live.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
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
import { loadTiptapEditor } from '@/components/ui/tiptap-loader';
import { toast } from 'sonner';
import {
  TEMPLATE_MAX_NAME_LENGTH,
  TEMPLATE_MAX_SUBJECT_LENGTH,
} from '@/modules/broadcasts';

// T113 (F7.1a US7) — share the F7 MVP Tiptap editor instance with the
// admin templates surface. Same StarterKit + paste-sanitiser config as
// the member compose surface; `imagesEnabled=false` because templates
// don't carry a draft id for the upload route + admin authors paste
// allowlisted URLs by hand (validateImageSourceAllowlist runs on
// every save).
const TiptapEditor = loadTiptapEditor<{
  initialHtml: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  labelledById?: string;
  describedById?: string;
  invalid?: boolean;
  imagesEnabled?: boolean;
  draftId?: string | null;
}>(() => import('@/components/broadcast/tiptap-editor'));

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
  // M-ux-3: track whether the user has attempted submit so per-field
  // error hints render only AFTER first interaction (avoids shouting
  // "required" the moment the page mounts).
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const isNameInvalid = submitAttempted && !name.trim();
  const isSubjectInvalid = submitAttempted && !subject.trim();
  const isBodyInvalid = submitAttempted && !bodyHtml.trim();

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
          // R2.2 silent-H-sf-6 — log parse failures + status so dev tools
          // surface "stop the line" hints when the route returns a non-
          // JSON body (CDN 502/cors page) instead of silently mapping
          // to "unknown".
          const correlationId =
            res.headers.get('X-Correlation-Id') ?? undefined;
          const payload = (await res.json().catch((parseErr) => {
            // R3.5 M-11 — message-first console syntax so log captures
            // (Sentry, Vercel client logs) display the message string
            // adjacent to the object payload (pino-style ordering is
            // server-only). DevTools also renders this more legibly.
            console.error(
              'broadcasts.template.form.error_body_parse_failed',
              {
                err:
                  parseErr instanceof Error ? parseErr.message : String(parseErr),
                status: res.status,
                correlationId,
              },
            );
            return {};
          })) as { error?: string };
          const code = payload.error ?? 'unknown';
          const msg = ((): string => {
            try {
              return t(`errors.${code}` as never);
            } catch {
              // R2.2 silent-M1 — log unknown code so observability picks
              // up new server error codes that need an i18n key. Falls
              // back to a generic translated message for the user.
              // R3.5 M-11 — message-first arg syntax.
              console.warn(
                'broadcasts.template.form.unknown_error_code',
                { code, correlationId },
              );
              return t('errors.unknown');
            }
          })();
          setError(msg);
          toast.error(msg);
          return;
        }

        // M-ux-1: dedicated success toast key (was reusing page title
        // which read as "Edit broadcast template" — confusing as a
        // success confirmation).
        toast.success(t('savedToast'));
        router.push('/admin/broadcasts/templates');
        router.refresh();
      } catch (err) {
        // Preserve Error stack for DevTools (Round-3-Final H4 pattern).
        // R3.5 M-11 — message-first arg syntax for legible log capture.
        console.error('broadcasts.template.form.submit_failed', { err, mode });
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
        setSubmitAttempted(true);
        if (name.trim() && subject.trim() && bodyHtml.trim()) submit();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="tpl-name">{t('fields.name')}</Label>
        <Input
          id="tpl-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={TEMPLATE_MAX_NAME_LENGTH}
          required
          disabled={isPending}
          aria-invalid={isNameInvalid}
          aria-describedby={
            isNameInvalid ? 'tpl-name-help tpl-name-error' : 'tpl-name-help'
          }
        />
        <p id="tpl-name-help" className="text-caption">
          {t('fields.nameHelp')}
        </p>
        {isNameInvalid ? (
          <p
            id="tpl-name-error"
            role="alert"
            className="text-caption text-destructive"
          >
            {t('errors.field_required')}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="tpl-subject">{t('fields.subject')}</Label>
        <Input
          id="tpl-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={TEMPLATE_MAX_SUBJECT_LENGTH}
          required
          disabled={isPending}
          aria-invalid={isSubjectInvalid}
          aria-describedby={
            isSubjectInvalid
              ? 'tpl-subject-help tpl-subject-error'
              : 'tpl-subject-help'
          }
        />
        <p id="tpl-subject-help" className="text-caption">
          {t('fields.subjectHelp')}
        </p>
        {isSubjectInvalid ? (
          <p
            id="tpl-subject-error"
            role="alert"
            className="text-caption text-destructive"
          >
            {t('errors.field_required')}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label id="tpl-body-label">{t('fields.bodyHtml')}</Label>
        {/* R3.5 M-13 — describedById + invalid forwarded into the
            contenteditable (not on the wrapper) so SR users get
            associated help + error + invalid state on focus. */}
        <TiptapEditor
          initialHtml={bodyHtml || '<p></p>'}
          onChange={setBodyHtml}
          disabled={isPending}
          labelledById="tpl-body-label"
          describedById={
            isBodyInvalid ? 'tpl-body-help tpl-body-error' : 'tpl-body-help'
          }
          invalid={isBodyInvalid}
          imagesEnabled={false}
        />
        <p id="tpl-body-help" className="text-caption">
          {t('fields.bodyHtmlHelp')}
        </p>
        {isBodyInvalid ? (
          <p
            id="tpl-body-error"
            role="alert"
            className="text-caption text-destructive"
          >
            {t('errors.field_required')}
          </p>
        ) : null}
      </div>

      {mode === 'new' ? (
        <div className="space-y-2">
          <Label htmlFor="tpl-locale">{t('fields.localeLabel')}</Label>
          <Select
            value={locale}
            onValueChange={(v) => setLocale(v as Locale)}
            disabled={isPending}
          >
            <SelectTrigger
              id="tpl-locale"
              aria-label={t('fields.localeLabel')}
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">{t('locale.en')}</SelectItem>
              <SelectItem value="th">{t('locale.th')}</SelectItem>
              <SelectItem value="sv">{t('locale.sv')}</SelectItem>
            </SelectContent>
          </Select>
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
          {isPending ? (
            <>
              <Loader2
                className="mr-2 size-4 motion-safe:animate-spin"
                aria-hidden="true"
              />
              {t('savingButton')}
            </>
          ) : (
            t('saveButton')
          )}
        </Button>
      </div>
    </form>
  );
}
