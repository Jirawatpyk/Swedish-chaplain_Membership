/**
 * Segment-level error boundary for `/unsubscribe/[token]`.
 *
 * Last-line-of-defence safety net for the GDPR Art. 21 unsubscribe
 * surface. The page itself is contracted "never throws" via the
 * top-level guard inside `processUnsubscribe`, but the surrounding
 * page renderer (i18n key access, `t.rich` callbacks, React hydration)
 * can still throw — e.g. a missing TH/SV i18n key on a release branch
 * or an OTel exporter init throw between the use-case commit and the
 * return. Without this boundary Next.js would render a 500, which is
 * the worst possible outcome for a recipient who clicked an
 * unsubscribe link in good faith.
 *
 * This component MUST be a client component (Next.js error boundary
 * contract) but renders a static EN-only fallback — we deliberately
 * do NOT call `useTranslations()` here because the i18n loader is the
 * most likely source of the throw we are catching. EN is the
 * documented final-fallback locale of the platform.
 */
'use client';

import { useEffect } from 'react';

interface ErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

export default function UnsubscribeErrorBoundary({
  error,
  reset,
}: ErrorProps): React.ReactElement {
  useEffect(() => {
    // The Next.js runtime already logs the throw; this hook is here so
    // the digest is structurally available for future telemetry hooks.
    // Avoid any imports that could themselves throw (i18n, metrics).
    console.error('unsubscribe_page_render_threw', {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6 text-center">
      <article className="w-full rounded-lg border border-border bg-card p-8 shadow-sm">
        <h1 className="mb-4 text-2xl font-semibold">Temporary error</h1>
        <p className="mb-3 text-base text-foreground">
          We could not display this unsubscribe page right now due to a
          temporary system error. Your unsubscribe was NOT recorded —
          please try the link again in a few minutes.
        </p>
        <p className="mb-4 text-sm text-foreground">
          If the problem persists, please reply to the email and ask to
          be removed from broadcasts. We will remove your email manually.
        </p>
        <button
          type="button"
          onClick={reset}
          className="inline-block rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          Try again
        </button>
      </article>
    </main>
  );
}
