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
    <div
      role="alert"
      aria-labelledby={headingId}
      className="space-y-2 p-3 border border-destructive rounded bg-destructive/10"
    >
      <p id={headingId} className="text-body font-medium text-destructive">
        {t('disallowedSourcesHeading')}
      </p>
      <ul className="text-caption text-destructive list-disc list-inside space-y-1">
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
    </div>
  );
}
