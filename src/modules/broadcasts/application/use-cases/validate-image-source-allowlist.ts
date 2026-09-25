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
  evaluateImageSources,
  extractImgSources,
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
  // F119 — the rule itself is the Domain's (`evaluateImageSources`), shared
  // with the approval round's send and promotion re-checks.
  const unsafe = evaluateImageSources(input.bodyHtml, allowlist).map((image) => image.src);

  if (unsafe.length === 0) return ok(undefined);

  await emitUnsafeImageSourcesAudit(deps.audit, { ...input, unsafeImageSources: unsafe });

  return err({ kind: 'unsafe_image_sources', unsafeImageSources: unsafe });
}

/**
 * The refusal audit, shared with the F119 approval round (save / send /
 * promotion), which evaluate the body against a pre-read allow-list instead
 * of calling the validator above. Offending srcs only — never the body.
 */
export async function emitUnsafeImageSourcesAudit(
  audit: AuditPort,
  input: {
    readonly tenantId: TenantSlug;
    readonly actorUserId: string;
    readonly requestId: string;
    readonly unsafeImageSources: readonly string[];
  },
): Promise<void> {
  // PR-review fix 2026-05-20 SF-H4: safeAuditEmit preserves the
  // submit-rejection effect even when audit storage hiccups.
  await safeAuditEmit(audit, null, {
    eventType: 'broadcast_body_image_source_unsafe',
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    summary: `Broadcast body has ${input.unsafeImageSources.length} non-allowlisted image source(s)`,
    payload: { unsafeImageSources: [...input.unsafeImageSources] },
    requestId: input.requestId,
  });
}
