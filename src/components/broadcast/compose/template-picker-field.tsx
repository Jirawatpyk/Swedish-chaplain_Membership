'use client';

/**
 * F119 T140 (US6-AS1, FR-046, SC-012 — the template-selection arm).
 *
 * The template picker plus the one rule FR-046 adds: choosing a template while
 * the subject or the message is non-empty asks first. A "no" changes nothing;
 * a "yes" re-seeds the subject and the body IN PLACE — the form is not
 * remounted and no URL is pushed, so everything else the user set (segment,
 * custom list, schedule, a draft id already minted) survives the swap.
 *
 * Shared by the member compose form and the staff compose-on-behalf form
 * (FR-039), which is why the template CONTENT travels with the option: both
 * pages resolve the tenant's templates server-side, chamber-name substitution
 * already applied, so applying one costs no round trip and cannot half-apply.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmationDialog } from '@/components/shell/confirmation-dialog';
import {
  ComposeTemplatePicker,
  type TemplatePickerRow,
} from './template-picker';

export interface ComposeTemplateOption extends TemplatePickerRow {
  readonly subject: string;
  readonly bodyHtml: string;
}

export interface ComposeTemplatePickerFieldProps {
  readonly templates: readonly ComposeTemplateOption[];
  readonly selectedId: string | null;
  /** True when applying a template would overwrite something (FR-046). */
  readonly hasContent: boolean;
  /** Called with the template to apply, or `null` for the blank option. */
  readonly onApply: (option: ComposeTemplateOption | null) => void;
  readonly disabled?: boolean;
}

export function ComposeTemplatePickerField({
  templates,
  selectedId,
  hasContent,
  onApply,
  disabled = false,
}: ComposeTemplatePickerFieldProps): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.compose.templatePicker');
  // `null` = no pending choice. The wrapper object is what distinguishes
  // "blank pending" (`{ option: null }`) from "nothing pending" (`null`).
  const [pending, setPending] = useState<{
    readonly option: ComposeTemplateOption | null;
  } | null>(null);
  /**
   * F119 T108 (FR-046) — template starts already counted on this screen. The
   * count is per (compose session, template): re-picking the SAME template
   * after an undo-by-re-pick is one start, not two, and the blank option is
   * not a start at all.
   */
  const countedRef = useRef<Set<string>>(new Set());

  if (templates.length === 0) return null;

  /**
   * Fire-and-forget: adoption telemetry must never block, fail or warn the
   * member's compose flow. The server refuses an unknown, other-tenant or
   * deleted template and rate-limits the bucket; a rejected count is simply a
   * count that did not happen.
   */
  function countStart(templateId: string): void {
    if (countedRef.current.has(templateId)) return;
    countedRef.current.add(templateId);
    void fetch(`/api/broadcasts/templates/${templateId}/started`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
    }).catch(() => {
      /* telemetry only — never surfaced */
    });
  }

  function applyOption(option: ComposeTemplateOption | null): void {
    if (option !== null) countStart(option.id);
    onApply(option);
  }

  function handleSelect(id: string | null): void {
    const option =
      id === null ? null : (templates.find((tpl) => tpl.id === id) ?? null);
    // An id the list does not carry can only come from a stale render; do
    // nothing rather than silently blanking the form.
    if (id !== null && option === null) return;
    if (!hasContent) {
      applyOption(option);
      return;
    }
    setPending({ option });
  }

  return (
    <>
      <ComposeTemplatePicker
        templates={templates}
        selectedId={selectedId}
        onSelect={handleSelect}
        disabled={disabled}
      />
      <ConfirmationDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={t('confirm.title')}
        description={
          pending?.option
            ? t('confirm.description', { template: pending.option.name })
            : t('confirm.descriptionBlank')
        }
        confirmLabel={
          pending?.option
            ? t('confirm.confirmLabel')
            : t('confirm.confirmLabelBlank')
        }
        cancelLabel={t('confirm.cancelLabel')}
        onConfirm={() => {
          if (pending !== null) applyOption(pending.option);
        }}
      />
    </>
  );
}
