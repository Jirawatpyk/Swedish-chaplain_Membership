'use client';

/**
 * PR-review fix 2026-05-20 UX-C1 — F7.1a US2 FR-011 + AS2 closure.
 *
 * Renders the accumulated list of `<img src>` URLs the server rejected
 * because their hostname is not in the tenant's image-source allowlist.
 * The list is `role="alert"` so screen readers announce it immediately
 * (the submit attempt is the trigger event). Each item shows the full
 * URL the author put in their body + a locale-aware "replace or remove"
 * call-to-action so the member can action it without re-reading the
 * spec.
 *
 * Wired by `compose-form.tsx` when the submit response is
 * `broadcast_body_image_source_unsafe` and the route payload carries
 * `details.disallowedSources: string[]`.
 */
import { useTranslations } from 'next-intl';
import { Alert } from '@jirawatpyk/aura-react';

interface Props {
  readonly urls: ReadonlyArray<string>;
  readonly headingId?: string;
}

export function UnsafeImageSourcesList({
  urls,
  headingId = 'unsafe-image-sources-heading',
}: Props): React.ReactElement | null {
  const t = useTranslations('portal.broadcasts.compose.imageUpload');
  if (urls.length === 0) return null;

  return (
    // Spec 122 US12d-3 (T1270) — AURA's danger Alert (it was a hand-drawn
    // red box on the legacy kit's tokens), still a `role="alert"` named by its
    // heading.
    <Alert tone="danger" role="alert" titleId={headingId} title={t('disallowedSourcesHeading')}>
      <ul className="list-inside list-disc space-y-1">
        {urls.map((url) => {
          let host: string;
          try {
            host = new URL(url).hostname;
          } catch {
            // Defensive: spec guarantees parseable URL but if a future
            // bypass slips a non-URL into the audit payload, render
            // the raw string rather than throwing.
            host = url;
          }
          return (
            <li key={url}>
              {t('disallowedSourceItem', { host })}
            </li>
          );
        })}
      </ul>
    </Alert>
  );
}
