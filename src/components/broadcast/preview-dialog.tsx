'use client';

/**
 * F119 T104 (US3-AS7, FR-043) — the full-size Preview dialog.
 *
 * FR-043 asks for the complete email "in the recipient's likely widths":
 * desktop **600 px** and phone **375 px**. Only the viewport changes — the
 * document is the SAME bytes at both widths, because it is the one the
 * preview route already produced for the pane. The dialog therefore takes
 * the `PreviewState` rather than fetching: opening it costs no second render
 * against the 30-per-minute budget, and its refusal states are the pane's.
 * (The member compare screen, which has no pane, calls `usePreviewHtml`
 * itself and hands the state here the same way.)
 *
 * Focus returns to the Preview button on close (WCAG 2.1 AA SC 2.4.3): the
 * trigger is a sibling of this dialog and never unmounts on close, so it is
 * always the least-surprising target — no `resolveDialogFinalFocus` success
 * case applies here. The resolver is a stable `useCallback` reading a ref,
 * because the dialog reads `finalFocus` at CLOSE time, when a value captured
 * from render-time state has already gone.
 *
 * Spec 122 US12c-1 — AURA's `Dialog` and `Button`s. Motion: AURA's dialog
 * drops its open/close animation under `prefers-reduced-motion: reduce` in its
 * own stylesheet (ux-standards § 17). The compose surfaces (US12d) share this
 * dialog and restyle with it, with no code change of their own.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button, Dialog } from '@jirawatpyk/aura-react';
import { PreviewSurface, type PreviewState } from './use-preview-html';

/** FR-043 — the two recipient widths, in CSS pixels. */
export const PREVIEW_WIDTH_DESKTOP = 600;
export const PREVIEW_WIDTH_PHONE = 375;
/** Tall enough to read a real newsletter; the frame scrolls inside. */
const PREVIEW_DIALOG_FRAME_HEIGHT = 560;

type PreviewWidth = typeof PREVIEW_WIDTH_DESKTOP | typeof PREVIEW_WIDTH_PHONE;

export interface PreviewDialogProps {
  /** The outcome of the ONE preview request this surface already made. */
  readonly state: PreviewState;
}

export function PreviewDialog({ state }: PreviewDialogProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.preview');
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<PreviewWidth>(PREVIEW_WIDTH_DESKTOP);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Read LIVE at close — a value resolved during render would be gone by the
  // time Base UI asks for it.
  const finalFocus = useCallback(() => triggerRef.current, []);

  return (
    <>
      <Button ref={triggerRef} type="button" variant="secondary" size="sm" touchHeight icon="eye" onClick={() => setOpen(true)}>
        {t('openLabel')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        finalFocus={finalFocus}
        size="lg"
        title={t('dialogTitle')}
        description={t('dialogDescription')}
      >
        <div className="flex flex-col gap-[var(--aura-space-3)]">
          <div role="group" aria-label={t('widthLabel')} className="flex flex-wrap gap-2">
            {(
              [
                [PREVIEW_WIDTH_DESKTOP, t('widthDesktop')],
                [PREVIEW_WIDTH_PHONE, t('widthPhone')],
              ] as ReadonlyArray<readonly [PreviewWidth, string]>
            ).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={width === value ? 'secondary' : 'ghost'}
                aria-pressed={width === value}
                onClick={() => setWidth(value)}
              >
                {label}
              </Button>
            ))}
          </div>

          <div className="max-h-[70vh] overflow-auto rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-canvas)] p-2">
            <PreviewSurface state={state} width={width} height={PREVIEW_DIALOG_FRAME_HEIGHT} />
          </div>
        </div>
      </Dialog>
    </>
  );
}
