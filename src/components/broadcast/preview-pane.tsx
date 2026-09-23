'use client';

/**
 * F119 T103 (US3-AS6, FR-043) — the inline preview pane.
 *
 * It shows the REAL email: the pane posts the subject + body to the preview
 * route and renders the document that comes back — the same wrapper the
 * sender uses, so brand header, design blocks and the unsubscribe footer are
 * all present and what the member approves is what is delivered.
 *
 * What it deliberately no longer does (T014): re-sanitise the body in the
 * browser and inject it with `dangerouslySetInnerHTML`. That was the third
 * divergent DOMPurify config in the codebase and it forbade `<img>`, so an
 * uploaded image was invisible here and visible in the delivered mail (audit
 * finding #2). Sanitisation belongs to the server, once
 * (`dompurify-sanitizer.ts`); the browser's job is to display the answer.
 *
 * Request behaviour, the 30-renders/minute budget and every non-ready state
 * live in `use-preview-html.tsx`, shared with the Preview dialog so the two
 * can never drift and so opening the dialog costs no extra render.
 */
import { useTranslations } from 'next-intl';
import { PreviewDialog } from './preview-dialog';
import {
  usePreviewHtml,
  PreviewSurface,
  type PreviewEndpoint,
} from './use-preview-html';
import { PREVIEW_PANE_FRAME_HEIGHT } from './preview-frame-heights';

/**
 * Fixed, so the pane never grows or shrinks as the deferred body settles —
 * the document scrolls inside the frame instead (layout shift was T156's
 * live-look item 2). Re-exported from the framework-free
 * `preview-frame-heights` module so a Server Component `loading.tsx` can
 * reserve the same number without pulling this client module in.
 */
export { PREVIEW_PANE_FRAME_HEIGHT };

export interface PreviewPaneProps {
  readonly subject: string;
  readonly bodyHtml: string;
  /** Member compose posts to the member route, staff proxy to the staff one. */
  readonly endpoint: PreviewEndpoint;
  readonly locale: string;
}

export function PreviewPane({
  subject,
  bodyHtml,
  endpoint,
  locale,
}: PreviewPaneProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  const state = usePreviewHtml({ endpoint, subject, bodyHtml, locale });

  return (
    <section
      data-compose-feature="preview-pane"
      aria-label={t('previewLabel')}
      className="rounded-md border bg-muted/20 overflow-x-hidden min-w-0"
    >
      <header className="flex items-start justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t('previewLabel')}
          </p>
          {/* Portal live walk U32 — this used to be
              `{subject.length > 0 ? subject : ' '}`, i.e. an `<h3>` holding a
              single space on every cold load and again whenever the subject is
              cleared: measured `textContent.length === 1` and 0 px tall, so it
              reserved nothing and only ever existed as an empty heading in the
              accessibility tree. Omitting it is byte-for-byte the same layout
              (a lone space collapses) without the phantom heading. */}
          {subject.trim().length > 0 ? (
            <h3 className="truncate text-sm font-semibold">{subject}</h3>
          ) : null}
        </div>
        {/* The dialog reads the state this pane already fetched — opening it
            never spends a second token of the 30/min budget. */}
        <PreviewDialog state={state} />
      </header>
      {/* One source of truth for the height: the box reserves exactly what a
          ready frame occupies, so the empty / loading / refusal states do not
          resize the form when the document arrives.

          T155 finding U7 — the padding is on the OUTER box. It used to sit on
          the same border-box as `minHeight`, so the 420 px reservation
          INCLUDED the 16 px while the ready state was a 420 px iframe PLUS
          them: measured, the pane was 436 px ready against 420 px reserved,
          every time. Contained then only by DOM ordering; anything rendered
          after the pane would have made it visible movement. */}
      <div className="py-2">
        <div
          data-testid="preview-pane-frame-reservation"
          style={{ minHeight: PREVIEW_PANE_FRAME_HEIGHT }}
        >
          <PreviewSurface state={state} height={PREVIEW_PANE_FRAME_HEIGHT} />
        </div>
      </div>
    </section>
  );
}
