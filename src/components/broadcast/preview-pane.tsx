'use client';

/**
 * T088 — Preview pane (sanitised body rendered as HTML).
 *
 * Defence-in-depth: even though the server (`sanitize-html.ts` use-case)
 * sanitises before persistence, the client also re-runs DOMPurify on
 * the locally-edited body before injecting via `dangerouslySetInnerHTML`.
 * If a future Tiptap upgrade ever lets unsafe markup escape the editor's
 * `transformPastedHTML` path, the preview pane still renders safely.
 *
 * Re-renders are throttled by the parent's `useDeferredValue(bodyHtml)`
 * — preview pane just renders whatever it receives.
 */
import { useMemo } from 'react';
import DOMPurify from 'isomorphic-dompurify';
import { useTranslations } from 'next-intl';

const PREVIEW_SANITIZER_CONFIG = Object.freeze({
  ALLOWED_TAGS: [
    'p',
    'br',
    'strong',
    'em',
    'u',
    'a',
    'ul',
    'ol',
    'li',
    'h1',
    'h2',
    'h3',
    'h4',
    'blockquote',
    'hr',
  ],
  ALLOWED_ATTR: ['href'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  FORBID_TAGS: [
    'script',
    'style',
    'iframe',
    'form',
    'link',
    'meta',
    'base',
    'object',
    'embed',
    'svg',
    'img',
  ],
  FORBID_ATTR: ['style'],
  KEEP_CONTENT: true,
  RETURN_TRUSTED_TYPE: false,
});

export interface PreviewPaneProps {
  readonly subject: string;
  readonly bodyHtml: string;
}

export function PreviewPane({
  subject,
  bodyHtml,
}: PreviewPaneProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  const sanitised = useMemo(
    () => DOMPurify.sanitize(bodyHtml, PREVIEW_SANITIZER_CONFIG) as string,
    [bodyHtml],
  );

  return (
    <section
      aria-label={t('previewLabel')}
      className="rounded-md border bg-muted/20"
    >
      <header className="border-b px-3 py-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {t('previewLabel')}
        </p>
        <h3 className="text-sm font-semibold">
          {subject.length > 0 ? subject : ' '}
        </h3>
      </header>
      <div
        className="prose prose-sm dark:prose-invert max-w-none px-3 py-2"
        // sanitised — defence-in-depth: server already sanitised; this
        // is a second pass before the browser-rendered preview.
        dangerouslySetInnerHTML={{ __html: sanitised }}
      />
    </section>
  );
}
