/**
 * `/admin/compliance` section index.
 *
 * The Compliance section currently has a single page — the DPO
 * erasure-evidence log. Without a route file here the `compliance` path
 * segment 404s, which (a) makes the breadcrumb's "compliance" crumb a dead
 * link, and (b) — under the strict `'nonce-…' 'strict-dynamic'` CSP — can
 * abort client-side (soft) navigation to `/admin/compliance/erasure-log`:
 * the 404 on the intermediate segment pushes Next.js onto a fallback chunk
 * load that drops the nonce, so `'strict-dynamic'` blocks the chunk and the
 * navigation silently fails (incident 2026-07-18).
 *
 * Making this a real route (a thin redirect to the only child) lets the
 * segment tree resolve normally. RBAC is enforced at the destination
 * (erasure-log is admin-only and `notFound()`s for non-admins), so this
 * redirect adds no gate of its own.
 *
 * `redirect` (307) — NOT `permanentRedirect` (308) — is intentional: the
 * Compliance section is expected to gain sibling pages, at which point this
 * becomes a real index. A 308 would be browser-cached and sticky.
 */
import { redirect } from 'next/navigation';

export default function ComplianceIndexPage(): never {
  redirect('/admin/compliance/erasure-log');
}
