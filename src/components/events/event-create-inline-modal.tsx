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
 *   - AURA `Dialog` (spec 122 US9b-2): role=dialog, focus trap, Escape.
 *   - AURA fields carry their label, hint and error; each field error is
 *     wrapped in role="alert" (assertive) so a newly-inserted validation
 *     message is announced reliably; the server-error Alert also takes
 *     focus on a failed submit.
 *   - Default focus on the externalId input (admin-facing field).
 *   - The start is a DatePicker plus a TimePicker in Bangkok time
 *     (Buddhist Era on TH is display only; the value stays ISO).
 *
 * The form is intentionally minimal — only the 4 fields needed by the
 * CSV import path. Advanced fields (description / location / partner-
 * benefit / cultural-event flags) are NOT in this surface; admin can
 * edit them via /admin/events/[eventId] once the event exists.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Alert,
  Button,
  DatePicker,
  Dialog,
  TextField,
  TimePicker,
  type ISODate,
} from '@jirawatpyk/aura-react';
import { toast } from '@/lib/toast';
import { bangkokInputToIso } from '@/components/broadcast/bangkok-datetime';

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
  // The DatePicker gives "YYYY-MM-DD" and the TimePicker "HH:mm"; joined,
  // they are read as Bangkok wall time and posted as UTC ISO (onSubmit).
  startDate: z.string().min(1, 'startDateRequired'),
  startTime: z.string().min(1, 'startTimeRequired'),
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
  const formId = useId();
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
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      externalId: '',
      name: '',
      startDate: '',
      startTime: '',
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

    // The picked date and time carry no timezone. They are the chamber's
    // wall time (Asia/Bangkok, as the help text promises), not the
    // browser's: `new Date(local)` would shift it by the admin's offset.
    // Stored as UTC per project convention.
    const startDate = bangkokInputToIso(`${values.startDate}T${values.startTime}`);
    if (startDate === null) {
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
          startDate,
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

  /** A field error, announced assertively when it appears (audit XF-07). */
  const fieldError = (message: string | undefined, fallback: string) =>
    message !== undefined ? (
      <span role="alert">{t(`fields.errors.${message || fallback}`)}</span>
    ) : undefined;

  return (
    <Dialog
      open={props.open}
      onClose={handleClose}
      dismissible={!submitting}
      title={t('title')}
      description={t('description')}
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={submitting}
            touchHeight
          >
            {t('cancelCta')}
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={submitting}
            touchHeight
          >
            {submitting ? t('submittingCta') : t('submitCta')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={onSubmit}
        noValidate
        className="flex flex-col gap-[var(--aura-space-4)]"
      >
        {serverError !== null ? (
          <div ref={serverErrorRef} tabIndex={-1} className="outline-none">
            {/* role="note": focus moves to this box, which reads it; a live
                region as well would announce the error twice. */}
            <Alert tone="danger" role="note" title={serverError.title}>
              {serverError.detail}
            </Alert>
          </div>
        ) : null}

        <TextField
          {...register('externalId')}
          label={t('fields.externalIdLabel')}
          autoFocus
          placeholder={t('fields.externalIdPlaceholder')}
          hint={t('fields.externalIdHelp')}
          error={fieldError(errors.externalId?.message, 'externalIdInvalid')}
        />

        <TextField
          {...register('name')}
          label={t('fields.nameLabel')}
          placeholder={t('fields.namePlaceholder')}
          hint={t('fields.nameHelp')}
          error={fieldError(errors.name?.message, 'nameRequired')}
        />

        <div className="grid gap-[var(--aura-space-4)] sm:grid-cols-2">
          <Controller
            control={control}
            name="startDate"
            render={({ field }) => (
              <DatePicker
                id={`${formId}-start-date`}
                name={field.name}
                ref={field.ref}
                label={t('fields.startDateLabel')}
                timeZone="Asia/Bangkok"
                value={(field.value || null) as ISODate | null}
                onChange={(iso) => field.onChange(iso ?? '')}
                error={fieldError(errors.startDate?.message, 'startDateRequired')}
              />
            )}
          />
          <Controller
            control={control}
            name="startTime"
            render={({ field }) => (
              <TimePicker
                id={`${formId}-start-time`}
                name={field.name}
                ref={field.ref}
                label={t('fields.startTimeLabel')}
                step={15}
                suggest="09:00"
                value={field.value || null}
                onChange={(time) => field.onChange(time ?? '')}
                hint={t('fields.startDateHelp')}
                error={fieldError(errors.startTime?.message, 'startTimeRequired')}
              />
            )}
          />
        </div>

        <TextField
          {...register('category')}
          label={t('fields.categoryLabel')}
          placeholder={t('fields.categoryPlaceholder')}
          hint={t('fields.categoryHelp')}
          error={fieldError(errors.category?.message, 'categoryTooLong')}
        />
      </form>
    </Dialog>
  );
}
