/**
 * T070 (F7.1a US2) — `validateImageSourceAllowlist` Application use-case.
 *
 * Runs AFTER the DOMPurify sanitiser (which strips non-http(s) `<img
 * src>` schemes per the `installImgSrcSchemeHook` hook) and BEFORE
 * persistence. Parses surviving `<img src>` hostnames and validates
 * each against the tenant's `ImageAllowlistPort`. Returns the first
 * error with ALL offending srcs accumulated so the editor can
 * highlight every problem at once (FR-011 UX requirement).
 *
 * Audit (broadcast_body_image_source_unsafe): one event per failed
 * submit, payload carries the offending src URLs ONLY — NEVER the
 * full body (privacy: the body may contain in-progress draft text
 * that the member did not intend to be visible in audit logs).
 *
 * Pure Application logic — no framework imports (Constitution
 * Principle III NON-NEGOTIABLE).
 */
import { err, ok, type Result } from '@/lib/result';
import {
  asHostname,
  extractImgSources,
  validateHostname,
} from '../../domain/value-objects/image-source-allowlist';
import type { ImageAllowlistPort } from '../ports/image-allowlist-port';
import type { AuditPort } from '../ports/audit-port';
import type { TenantSlug } from '@/modules/tenants';
import { safeAuditEmit } from './_safe-audit-emit';

export interface ValidateImageSourceAllowlistDeps {
  readonly allowlistPort: ImageAllowlistPort;
  readonly audit: AuditPort;
}

export interface ValidateImageSourceAllowlistInput {
  readonly bodyHtml: string;
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly requestId: string;
}

export type ValidateImageSourceAllowlistError = {
  readonly kind: 'unsafe_image_sources';
  readonly unsafeImageSources: readonly string[];
};

export async function validateImageSourceAllowlist(
  deps: ValidateImageSourceAllowlistDeps,
  input: ValidateImageSourceAllowlistInput,
): Promise<Result<void, ValidateImageSourceAllowlistError>> {
  const sources = extractImgSources(input.bodyHtml);
  if (sources.length === 0) return ok(undefined);

  const allowlist = await deps.allowlistPort.findByTenantId(input.tenantId);
  const unsafe: string[] = [];

  for (const { src } of sources) {
    let hostname: string;
    try {
      hostname = new URL(src).hostname.toLowerCase();
    } catch {
      unsafe.push(src);
      continue;
    }
    const hRes = asHostname(hostname);
    if (!hRes.ok) {
      unsafe.push(src);
      continue;
    }
    const vRes = validateHostname(hRes.value, allowlist);
    if (!vRes.ok) unsafe.push(src);
  }

  if (unsafe.length === 0) return ok(undefined);

  // PR-review fix 2026-05-20 SF-H4: safeAuditEmit preserves the
  // submit-rejection effect even when audit storage hiccups.
  await safeAuditEmit(deps.audit, null, {
    eventType: 'broadcast_body_image_source_unsafe',
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    summary: `Broadcast body has ${unsafe.length} non-allowlisted image source(s)`,
    payload: { unsafeImageSources: unsafe },
    requestId: input.requestId,
  });

  return err({ kind: 'unsafe_image_sources', unsafeImageSources: unsafe });
}
