'use client';

/**
 * T088 — Preview pane (sanitised body rendered as HTML).
 *
 * Defence-in-depth: the SERVER (`sanitize-html.ts` use-case) is the
 * authoritative sanitisation boundary — every persisted body is already
 * allowlist-filtered. The client re-runs DOMPurify on the locally-edited
 * body before injecting via `dangerouslySetInnerHTML` to keep WYSIWYG
 * preview in sync with the saved-state behaviour. **Do not remove the
 * server-side sanitisation thinking the client covers it** — the client
 * is paranoia for the unsaved-edit path only.
 *
 * Two render states:
 *   - `loadError !== null`     → role=alert with refresh hint (UX I4)
 *   - default                  → dangerouslySetInnerHTML(sanitised)
 *
 * Re-renders are throttled by the parent's `useDeferredValue(bodyHtml)`.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import DOMPurify from 'isomorphic-dompurify';

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
  ALLOWED_ATTR: ['href', 'target', 'rel'],
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

  const { sanitised, loadError } = useMemo<{
    sanitised: string;
    loadError: string | null;
  }>(() => {
    try {
      const out = DOMPurify.sanitize(bodyHtml, PREVIEW_SANITIZER_CONFIG);
      return {
        sanitised: typeof out === 'string' ? out : '',
        loadError: null,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown';
      if (typeof window !== 'undefined') {
        window.console.error('[broadcast.preview] sanitiser failed:', message);
      }
      return { sanitised: '', loadError: message };
    }
  }, [bodyHtml]);

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
          {subject.length > 0 ? subject : ' '}
        </h3>
      </header>
      {loadError !== null ? (
        <div role="alert" className="px-3 py-3 text-sm text-destructive">
          <p className="font-medium">{t('previewUnavailable')}</p>
          <p className="text-xs text-muted-foreground">
            {t('previewUnavailableHint')}
          </p>
        </div>
      ) : (
        <div
          className="prose prose-sm dark:prose-invert max-w-none px-3 py-2"
          dangerouslySetInnerHTML={{ __html: sanitised }}
        />
      )}
    </section>
  );
}
