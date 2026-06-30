'use client';

/**
 * T026 (Feature 013 · F6.1 FULL IMPL) — Inline event-create modal.
 *
 * Admin form to seed a new event before CSV upload can target it. The
 * EventCreate webhook ingest path is gated behind EventCreate's
 * Enterprise tier (project_eventcreate_api_gated memory) — admins
 * cannot rely on Zapier to create events, so this surface is the
 * primary onboarding path for new tenant events.
 *
 * On submit:
 *   POST /api/admin/events { externalId, name, startDate, category }
 *     → 201 'created'       — close modal + invoke onCreated callback
 *     → 200 'already_exists' — close modal + invoke onCreated (idempotent retry)
 *     → 400 validation-error — inline field error
 *     → 429 / 500 — inline destructive Alert (focused); the Create button
 *       stays enabled so the admin can retry without re-opening the modal.
 *
 * Accessibility:
 *   - role=dialog + aria-modal inherited from shadcn Dialog (Base UI).
 *   - Form fields use Label + htmlFor association.
 *   - Field + server errors use role="alert" (assertive) so a newly-inserted
 *     validation/rejection message is announced reliably; the server-error
 *     Alert also takes focus on a failed submit.
 *   - Default focus on the externalId input (admin-facing field).
 *   - All buttons min-h-11 (WCAG 2.5.8 target size).
 *
 * The form is intentionally minimal — only the 4 fields needed by the
 * CSV import path. Advanced fields (description / location / partner-
 * benefit / cultural-event flags) are NOT in this surface; admin can
 * edit them via /admin/events/[eventId] once the event exists.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

export interface CreatedEvent {
  readonly eventId: string;
  readonly externalId: string;
  readonly name: string;
  readonly startDate: string;
  readonly category: string | null;
}

export interface EventCreateInlineModalProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Fires when the event is created OR already exists (both successful
   * outcomes). The parent component refreshes the EventPicker dropdown
   * + auto-selects the new event.
   */
  readonly onCreated?: (event: CreatedEvent) => void;
}

const FormSchema = z.object({
  externalId: z
    .string()
    .trim()
    .min(1, 'externalIdRequired')
    .max(100, 'externalIdTooLong')
    .regex(/^[a-z0-9][a-z0-9-]{0,99}$/i, 'externalIdInvalid'),
  name: z.string().trim().min(1, 'nameRequired').max(500, 'nameTooLong'),
  // `datetime-local` <input> returns "YYYY-MM-DDTHH:mm" without tz.
  // We convert to UTC ISO before posting (toISOString below).
  startDateLocal: z.string().min(1, 'startDateRequired'),
  category: z.string().trim().max(100, 'categoryTooLong').optional(),
});

type FormValues = z.infer<typeof FormSchema>;

interface ServerError {
  readonly title: string;
  readonly detail: string;
}

export function EventCreateInlineModal(
  props: EventCreateInlineModalProps,
): React.JSX.Element {
  const t = useTranslations(
    'admin.events.import.eventPicker.inlineCreateModal',
  );
  const externalIdId = useId();
  const externalIdHintId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const startDateId = useId();
  const startDateHintId = useId();
  const categoryId = useId();
  const categoryHintId = useId();
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  // Move focus to the server-error Alert on a failed submit so a keyboard/SR
  // admin (focus on the re-enabled Create button) is taken to the reason.
  const serverErrorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (serverError) serverErrorRef.current?.focus();
  }, [serverError]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      externalId: '',
      name: '',
      startDateLocal: '',
      category: '',
    },
  });

  const handleClose = useCallback(() => {
    reset();
    setServerError(null);
    // The success path closes WITHOUT a setSubmitting(false), and the parent
    // keeps this modal mounted (only `open` toggles) — so clear it here too,
    // else reopening after a successful create shows a stuck "Creating…".
    setSubmitting(false);
    props.onOpenChange(false);
  }, [props, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    setServerError(null);

    // Convert local datetime → ISO with offset. `datetime-local` does
    // not carry tz info; we assume the admin's wall-clock is the
    // chamber's local tz. Stored as UTC per project convention.
    const startDate = new Date(values.startDateLocal);
    if (Number.isNaN(startDate.getTime())) {
      setServerError({
        title: t('errors.invalidStartDateTitle'),
        detail: t('errors.invalidStartDateDetail'),
      });
      setSubmitting(false);
      return;
    }

    let res: Response;
    try {
      res = await fetch('/api/admin/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalId: values.externalId,
          name: values.name,
          startDate: startDate.toISOString(),
          category:
            values.category && values.category.length > 0
              ? values.category
              : null,
        }),
      });
    } catch (e) {
      setServerError({
        title: t('errors.networkErrorTitle'),
        detail: e instanceof Error ? e.message : t('errors.networkErrorDetail'),
      });
      setSubmitting(false);
      return;
    }

    // Parse body ONCE before branching — double-parse via res.json()
    // throws TypeError on the second call, and catch-swallow would hide
    // the underlying malformed-response bug. The console.error in the
    // catch surfaces malformed proxy responses to dev tooling without
    // affecting the visible UI fallthrough.
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      console.error('[F6.1] event-create response JSON parse failed', e);
      body = {};
    }
    const created = body['event'] as CreatedEvent | undefined;
    if ((res.status === 201 || res.status === 200) && created) {
      if (body['kind'] === 'already_exists') {
        toast.info(t('alreadyExistsToast'), {
          // UX-I4 (Round 1) — show event name (user-friendly) rather
          // than `externalId` (technical DB concept) per ux-standards
          // § 14 plain-language requirement.
          description: t('alreadyExistsToastDesc', { name: created.name }),
        });
      } else {
        toast.success(t('createdToast'), {
          description: t('createdToastDesc', { name: created.name }),
        });
      }
      props.onCreated?.(created);
      handleClose();
      return;
    }

    if (res.status === 400) {
      setServerError({
        title: t('errors.validationTitle'),
        detail: String(
          body['detail'] ?? body['title'] ?? t('errors.validationDetail'),
        ),
      });
    } else if (res.status === 429) {
      // Surface Retry-After when present so admins see an actionable
      // wait time instead of a generic "rate-limited" message.
      const retryAfterHeader = res.headers.get('Retry-After');
      const retryAfter =
        retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
          ? Number(retryAfterHeader)
          : null;
      setServerError({
        title: t('errors.rateLimitTitle'),
        detail:
          retryAfter !== null
            ? t('errors.rateLimitDetailWithSeconds', { seconds: retryAfter })
            : t('errors.rateLimitDetail'),
      });
    } else {
      setServerError({
        title: t('errors.unexpectedTitle'),
        detail: String(
          body['detail'] ?? body['title'] ?? t('errors.unexpectedDetail'),
        ),
      });
    }
    setSubmitting(false);
  });

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) handleClose();
        else props.onOpenChange(true);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {serverError !== null ? (
            <div ref={serverErrorRef} tabIndex={-1} className="outline-none">
              {/* Alert already carries role="alert" (assertive) — no aria-live
                * override, which would downgrade it to polite. */}
              <Alert variant="destructive">
                <AlertTitle>{serverError.title}</AlertTitle>
                <AlertDescription>{serverError.detail}</AlertDescription>
              </Alert>
            </div>
          ) : null}

          {/* APG Form Pattern: keep the hint paragraph always-mounted +
              add the error paragraph as a sibling. `aria-describedby`
              points to BOTH ids when an error fires so SR users hear
              the field context (e.g. "1-100 alphanumeric + hyphen")
              AND the validation message — losing context on error
              defeats the purpose of the hint. */}
          <div className="flex flex-col gap-2">
            <Label htmlFor={externalIdId}>{t('fields.externalIdLabel')}</Label>
            <Input
              id={externalIdId}
              {...register('externalId')}
              autoFocus
              placeholder={t('fields.externalIdPlaceholder')}
              aria-invalid={errors.externalId !== undefined}
              aria-describedby={
                errors.externalId !== undefined
                  ? `${externalIdHintId} ${externalIdId}-error`
                  : externalIdHintId
              }
            />
            <p
              id={externalIdHintId}
              className="text-caption text-muted-foreground"
            >
              {t('fields.externalIdHelp')}
            </p>
            {errors.externalId ? (
              <p
                id={`${externalIdId}-error`}
                className="text-caption text-destructive"
                role="alert"
              >
                {t(`fields.errors.${errors.externalId.message ?? 'externalIdInvalid'}`)}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>{t('fields.nameLabel')}</Label>
            <Input
              id={nameId}
              {...register('name')}
              placeholder={t('fields.namePlaceholder')}
              aria-invalid={errors.name !== undefined}
              aria-describedby={
                errors.name !== undefined
                  ? `${nameHintId} ${nameId}-error`
                  : nameHintId
              }
            />
            <p
              id={nameHintId}
              className="text-caption text-muted-foreground"
            >
              {t('fields.nameHelp')}
            </p>
            {errors.name ? (
              <p
                id={`${nameId}-error`}
                className="text-caption text-destructive"
                role="alert"
              >
                {t(`fields.errors.${errors.name.message ?? 'nameRequired'}`)}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={startDateId}>{t('fields.startDateLabel')}</Label>
            <Input
              id={startDateId}
              type="datetime-local"
              {...register('startDateLocal')}
              aria-invalid={errors.startDateLocal !== undefined}
              aria-describedby={
                errors.startDateLocal !== undefined
                  ? `${startDateHintId} ${startDateId}-error`
                  : startDateHintId
              }
            />
            <p
              id={startDateHintId}
              className="text-caption text-muted-foreground"
            >
              {t('fields.startDateHelp')}
            </p>
            {errors.startDateLocal ? (
              <p
                id={`${startDateId}-error`}
                className="text-caption text-destructive"
                role="alert"
              >
                {t(
                  `fields.errors.${errors.startDateLocal.message ?? 'startDateRequired'}`,
                )}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={categoryId}>{t('fields.categoryLabel')}</Label>
            <Input
              id={categoryId}
              {...register('category')}
              placeholder={t('fields.categoryPlaceholder')}
              aria-invalid={errors.category !== undefined}
              aria-describedby={
                errors.category !== undefined
                  ? `${categoryHintId} ${categoryId}-error`
                  : categoryHintId
              }
            />
            <p
              id={categoryHintId}
              className="text-caption text-muted-foreground"
            >
              {t('fields.categoryHelp')}
            </p>
            {errors.category ? (
              <p
                id={`${categoryId}-error`}
                className="text-caption text-destructive"
                role="alert"
              >
                {t(`fields.errors.${errors.category.message ?? 'categoryTooLong'}`)}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={submitting}
              className="min-h-11"
            >
              {t('cancelCta')}
            </Button>
            <Button
              type="submit"
              disabled={submitting}
              aria-busy={submitting}
              className="min-h-11"
            >
              {submitting ? (
                <>
                  <Loader2
                    aria-hidden="true"
                    className="mr-2 size-4 animate-spin motion-reduce:animate-none"
                  />
                  {t('submittingCta')}
                </>
              ) : (
                t('submitCta')
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
