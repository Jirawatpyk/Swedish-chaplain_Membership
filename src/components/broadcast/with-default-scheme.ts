/**
 * Spec 122 US12d-2 round 2 (#19) — an author who types `swecham.example/events`
 * into a link or button field means the web page, but the field refused it
 * for having no scheme. A bare domain-shaped address gets `https://` in front;
 * everything else is returned as typed, so the ONE allow-list
 * (`BROADCAST_ALLOWED_URI_REGEXP`) still decides: `javascript:`, `ftp:` and
 * `data:` keep their scheme and are refused, and `info@swecham.example` (no
 * `mailto:`) is not turned into a web address.
 */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BARE_DOMAIN = /^[^\s/@:]+\.[^\s/@:]+(?:[/?#].*)?$/;

export function withDefaultScheme(raw: string): string {
  const value = raw.trim();
  if (value === '' || HAS_SCHEME.test(value)) return value;
  return BARE_DOMAIN.test(value) ? `https://${value}` : value;
}
