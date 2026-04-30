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
 * **SSR-safe load** (root cause: isomorphic-dompurify → jsdom → ESM-only
 * @exodus/bytes crashes Node 20's CJS loader during SSR pre-render).
 * Dompurify is loaded ONLY in the browser via `useEffect` + dynamic
 * import (which the bundler/browser caches), so the server-render path
 * never touches it. See `docs/runbooks/f7-dompurify-esm-workaround.md`.
 *
 * Three render states:
 *   - `loading=true`           → aria-busy placeholder (UX-C4)
 *   - `loadError !== null`     → role=alert with refresh hint (UX I4)
 *   - default                  → dangerouslySetInnerHTML(sanitised)
 *
 * Re-renders are throttled by the parent's `useDeferredValue(bodyHtml)`.
 */
import { useEffect, useRef, useState } from 'react';
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

// Structural-typing escape hatch for the dynamic import: importing the
// real DOMPurify type would re-introduce SSR bundling of the ESM chain
// at type-checking time. Do NOT replace with `import type`.
type PurifyLike = {
  sanitize: (html: string, config: unknown) => string;
};

export interface PreviewPaneProps {
  readonly subject: string;
  readonly bodyHtml: string;
}

export function PreviewPane({
  subject,
  bodyHtml,
}: PreviewPaneProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  const [sanitised, setSanitised] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // UX-R2-3 (round-3) — only announce loading on the FIRST mount.
  // Subsequent re-sanitisations (every keystroke via deferred bodyHtml)
  // must NOT re-announce "Loading preview…" — SR users would hear it on
  // every typed character.
  const hasLoadedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        // Native module-cache makes repeated `import()` cheap; no extra layer.
        const mod = (await import('isomorphic-dompurify')) as {
          default: PurifyLike;
        };
        if (cancelled) return;
        const out = mod.default.sanitize(bodyHtml, PREVIEW_SANITIZER_CONFIG);
        setSanitised(typeof out === 'string' ? out : '');
        setLoadError(null);
        setLoading(false);
        hasLoadedOnce.current = true;
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : 'unknown';
        window.console.error('[broadcast.preview] sanitiser load failed:', message);
        setLoadError(message);
        setSanitised('');
        setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
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
      {loading ? (
        <div
          className="prose prose-sm dark:prose-invert max-w-none px-3 py-3 text-xs text-muted-foreground"
          aria-busy="true"
          // Only announce on first mount to avoid keystroke-spam announcements.
          {...(hasLoadedOnce.current ? {} : { 'aria-live': 'polite' as const })}
        >
          {t('previewLoading')}
        </div>
      ) : loadError !== null ? (
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
