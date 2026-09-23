'use client';

/**
 * F119 T103 / T104 (FR-043, research R11) — the ONE request path behind every
 * E-Blast preview, plus the surface that renders its outcome.
 *
 * The preview is not a client-side re-render of the body: it is the REAL
 * email, produced by `POST /api/broadcasts/preview` (member) or
 * `POST /api/admin/broadcasts/preview` (staff) through the same wrapper the
 * sender uses — brand header, design blocks, footer with unsubscribe. The
 * client therefore does NOT sanitise (T014 deleted the third divergent
 * DOMPurify config, which forbade `<img>` and made every uploaded image
 * invisible here while it was visible in the delivered mail — audit finding
 * #2) and does NOT inject with `dangerouslySetInnerHTML`. The document goes
 * into an `<iframe srcdoc>` with `sandbox=""` — no scripts, no forms, no
 * network, no same-origin access back into the app.
 *
 * The route is capped at **30 renders / minute per actor**, so the hook is
 * debounced 400 ms on top of the caller's `useDeferredValue`, coalesced (one
 * request for the LATEST body) and sequence-guarded (a late answer for an
 * older body can never overwrite a newer one) — the `useRecipientCount`
 * precedent. An empty message never spends a token at all: it is answered
 * locally with the translated empty state (US3-AS6).
 *
 * Only SETTLED answers are stored, keyed by the exact inputs they answer, so
 * `loading` is DERIVED on the same render an input changes and the effect
 * never sets state synchronously (`react-hooks/set-state-in-effect` is an
 * error here).
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';
import { isLocale, type Locale } from '@/i18n/config';

export type PreviewState =
  /** Nothing to render — never a blank box (US3-AS6, FR-043). */
  | { readonly status: 'empty' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly html: string }
  /** 429 — a calm inline line, never a toast per keystroke. */
  | { readonly status: 'paused'; readonly retryAfterSeconds: number }
  | { readonly status: 'error' };

export type PreviewEndpoint =
  | '/api/broadcasts/preview'
  | '/api/admin/broadcasts/preview';

export interface UsePreviewHtmlProps {
  readonly endpoint: PreviewEndpoint;
  readonly subject: string;
  /** Already passed through the caller's `useDeferredValue`. */
  readonly bodyHtml: string;
  /** The UI locale; anything else falls back to the canonical `en`. */
  readonly locale: string;
}

/** On top of the caller's `useDeferredValue` — the route allows 30/min. */
export const PREVIEW_DEBOUNCE_MS = 400;

/** Fallback used when a 429 carries no usable `Retry-After`. */
const PREVIEW_DEFAULT_RETRY_SECONDS = 60;

/**
 * Anything that puts ink on the page even with no text: a picture, a divider,
 * a banner or a table laid out by a design block.
 */
const PREVIEW_VISIBLE_TAG = /<(img|hr|table|figure|iframe)\b/i;

/**
 * Pure: is there anything to preview? Tiptap's empty document is `<p></p>`,
 * and a body of `&nbsp;` is empty to a reader too. Text-only string work —
 * the body is never parsed into this page's DOM.
 */
export function isPreviewBodyEmpty(html: string): boolean {
  if (PREVIEW_VISIBLE_TAG.test(html)) return false;
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(?:160|xa0);/gi, ' ');
  return text.trim() === '';
}

function toPreviewLocale(locale: string): Locale {
  return isLocale(locale) ? locale : 'en';
}

function retryAfterSecondsOf(
  headerValue: string | null,
  body: unknown,
): number {
  const fromHeader = Number(headerValue);
  if (Number.isInteger(fromHeader) && fromHeader > 0) return fromHeader;
  const details =
    typeof body === 'object' && body !== null
      ? ((body as { error?: { details?: { retryAfterSeconds?: unknown } } }).error
          ?.details?.retryAfterSeconds ?? null)
      : null;
  return typeof details === 'number' && Number.isInteger(details) && details > 0
    ? details
    : PREVIEW_DEFAULT_RETRY_SECONDS;
}

export function usePreviewHtml(props: UsePreviewHtmlProps): PreviewState {
  const { endpoint, subject, bodyHtml } = props;
  const locale = toPreviewLocale(props.locale);
  const empty = isPreviewBodyEmpty(bodyHtml);

  // The settled answer carries the exact inputs it answers, so a change is
  // `loading` on the very same render without an effect writing state.
  const [settled, setSettled] = useState<{
    readonly endpoint: string;
    readonly subject: string;
    readonly bodyHtml: string;
    readonly locale: Locale;
    readonly state: PreviewState;
  } | null>(null);
  // Monotonic: only the LATEST request may write.
  const seqRef = useRef(0);

  useEffect(() => {
    // Bumped before the empty check on purpose: a body that becomes empty
    // must invalidate an answer already in flight for the previous one.
    const seq = ++seqRef.current;
    if (empty) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      let next: PreviewState;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subject, bodyHtml, locale }),
          signal: controller.signal,
        });
        if (seq !== seqRef.current) return;
        const body: unknown = await res.json().catch(() => null);
        if (seq !== seqRef.current) return;
        if (res.status === 429) {
          next = {
            status: 'paused',
            retryAfterSeconds: retryAfterSecondsOf(
              res.headers.get('Retry-After'),
              body,
            ),
          };
        } else if (!res.ok) {
          next = { status: 'error' };
        } else {
          const html =
            typeof body === 'object' && body !== null
              ? (body as { html?: unknown }).html
              : null;
          // A 200 without a document is a broken answer, not an empty email.
          next =
            typeof html === 'string' && html !== ''
              ? { status: 'ready', html }
              : { status: 'error' };
        }
      } catch {
        if (seq !== seqRef.current) return;
        next = { status: 'error' };
      }
      setSettled({ endpoint, subject, bodyHtml, locale, state: next });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [endpoint, subject, bodyHtml, locale, empty]);

  if (empty) return { status: 'empty' };
  if (
    settled !== null &&
    settled.endpoint === endpoint &&
    settled.subject === subject &&
    settled.bodyHtml === bodyHtml &&
    settled.locale === locale
  ) {
    return settled.state;
  }
  return { status: 'loading' };
}

export interface PreviewSurfaceProps {
  readonly state: PreviewState;
  /** Recipient width in CSS pixels — 600 desktop, 375 phone (FR-043). */
  readonly width?: number;
  /**
   * Fixed frame height. The frame scrolls internally rather than growing:
   * measuring the document and resizing would move everything below the pane
   * on every keystroke, which is the layout shift T156 goes looking for.
   */
  readonly height: number;
}

/** The outcome of ONE preview request, at ONE width. */
export function PreviewSurface({
  state,
  width,
  height,
}: PreviewSurfaceProps): React.ReactElement {
  const t = useTranslations('broadcast.editor.preview');
  const tFields = useTranslations('portal.broadcasts.compose.fields');

  switch (state.status) {
    case 'empty':
      return (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      );
    case 'loading':
      return (
        <div className="flex flex-col gap-2 px-3 py-3" aria-busy="true">
          <span className="sr-only" role="status">
            {tFields('previewLoading')}
          </span>
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      );
    case 'paused':
      return (
        <p role="status" className="px-3 py-6 text-center text-sm text-warning">
          {t('paused', { seconds: state.retryAfterSeconds })}
        </p>
      );
    case 'error':
      return (
        <div role="alert" className="px-3 py-3 text-sm text-destructive">
          <p className="font-medium">{tFields('previewUnavailable')}</p>
          <p className="text-caption text-muted-foreground">
            {tFields('previewUnavailableHint')}
          </p>
        </div>
      );
    case 'ready':
      return (
        <iframe
          title={t('frameTitle')}
          // `srcdoc` only: no `src`, so the frame makes no request of its own.
          // `sandbox=""` is the empty allow-list — no scripts, no forms, no
          // same-origin access back into the app.
          //
          // `bg-white` is a DELIBERATE, documented exception to
          // ux-standards § theming's "semantic tokens only" (T155 § 15 walk,
          // 2026-09-22). This frame is CONTENT, not chrome: it shows the
          // delivered email, and every mail client composites that document on
          // a white canvas. Theming it to `bg-card` would make the operator
          // approve something nobody receives, and the rule does not reach
          // inside a `sandbox=""` document preview. Keep it.
          //
          // The same argument does NOT carry to the brand LOGO swatch, which
          // is a small chrome-scale patch beside a field — that one is themed
          // with a transparency checker (T155 U16,
          // `brand/brand-settings-form.tsx`).
          srcDoc={state.html}
          sandbox=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="mx-auto block w-full max-w-full border-0 bg-white"
          style={{ height, ...(width !== undefined && { width }) }}
        />
      );
  }
}
