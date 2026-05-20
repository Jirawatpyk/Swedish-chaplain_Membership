/**
 * T100 (F7.1a US7) — `updateBroadcastTemplate` Application use-case.
 *
 * Admin edit per contracts/broadcast-template.md § 1.2:
 *   1. Validate input lengths (subset of T099 — only changed fields)
 *   2. Load existing template (RLS-scoped) — null → cross-tenant probe
 *      audit + not_found
 *   3. If bodyHtml is provided, validate against image-source allowlist
 *   4. Atomic mutation+audit via port.withTx — audit payload records
 *      before/after value for forensic visibility (FR-021)
 *
 * Snapshot invariant (FR-019): drafts already started from this
 * template are NOT modified (the broadcasts.body_html column is
 * independent of broadcast_templates.body_html — `updateDraft` and
 * `updateDraftFromTemplate` are the only writers to draft body).
 *
 * Pure Application logic.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  BroadcastTemplatesPort,
  TemplateUpdateError,
} from '../ports/broadcast-templates-port';
import type { AuditPort } from '../ports/audit-port';
import { safeAuditEmit } from './_safe-audit-emit';
import {
  validateImageSourceAllowlist,
  type ValidateImageSourceAllowlistDeps,
} from './validate-image-source-allowlist';
import type { TenantSlug } from '@/modules/tenants';

const MAX_NAME = 100;
const MAX_SUBJECT = 200;
const MAX_BODY = 200 * 1024;

export interface UpdateBroadcastTemplateDeps {
  readonly port: BroadcastTemplatesPort;
  readonly audit: AuditPort;
  readonly validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
}

export interface UpdateBroadcastTemplateInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly templateId: string;
  readonly name?: string;
  readonly subject?: string;
  readonly bodyHtml?: string;
  readonly requestId: string;
}

export type UpdateBroadcastTemplateError =
  | { readonly kind: 'invalid_input'; readonly detail: string }
  | {
      readonly kind: 'template_body_unsafe';
      readonly unsafeImageSources: readonly string[];
    }
  | TemplateUpdateError;

export interface UpdateBroadcastTemplateOutput {
  readonly templateId: string;
}

export async function updateBroadcastTemplate(
  deps: UpdateBroadcastTemplateDeps,
  input: UpdateBroadcastTemplateInput,
): Promise<
  Result<UpdateBroadcastTemplateOutput, UpdateBroadcastTemplateError>
> {
  // 1. Validate only the fields being changed.
  if (
    input.name !== undefined &&
    (input.name.length === 0 || input.name.length > MAX_NAME)
  ) {
    return err({
      kind: 'invalid_input',
      detail: `name length must be 1..${MAX_NAME}`,
    });
  }
  if (
    input.subject !== undefined &&
    (input.subject.length === 0 || input.subject.length > MAX_SUBJECT)
  ) {
    return err({
      kind: 'invalid_input',
      detail: `subject length must be 1..${MAX_SUBJECT}`,
    });
  }
  if (input.bodyHtml !== undefined && input.bodyHtml.length > MAX_BODY) {
    return err({
      kind: 'invalid_input',
      detail: `body length must be ≤${MAX_BODY}`,
    });
  }

  // 2. Load existing for before-value + cross-tenant probe detection.
  const existing = await deps.port.findById(input.tenantId, input.templateId);
  if (!existing) {
    // RLS-confined SELECT returned null → either no such id (admin
    // bug) or cross-tenant probe (security event). Emit the probe
    // audit best-effort + return not_found regardless (FR-021 +
    // Constitution Principle I).
    await safeAuditEmit(deps.audit, null, {
      eventType: 'broadcast_cross_tenant_probe',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Cross-tenant probe on update-template ${input.templateId}`,
      payload: {
        probedTenantId: input.tenantId,
        probedTemplateId: input.templateId,
        resourceKind: 'template',
      },
      requestId: input.requestId,
    });
    return err({ kind: 'not_found' });
  }

  // 3. Image-source allowlist check on new bodyHtml (if changed).
  if (input.bodyHtml !== undefined) {
    const allowlistCheck = await validateImageSourceAllowlist(
      deps.validateImageSourceAllowlist,
      {
        bodyHtml: input.bodyHtml,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
      },
    );
    if (!allowlistCheck.ok) {
      return err({
        kind: 'template_body_unsafe',
        unsafeImageSources: allowlistCheck.error.unsafeImageSources,
      });
    }
  }

  // 4. Atomic mutation + audit. The audit payload records before/after
  //    so admins can see WHAT changed during forensic review.
  return deps.port.withTx(input.tenantId, async (tx) => {
    // Build patch with only the fields actually being changed.
    // `exactOptionalPropertyTypes: true` rejects `{ name: undefined }`,
    // so we conditionally spread instead.
    const patch: Parameters<typeof deps.port.update>[2] = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.bodyHtml !== undefined ? { bodyHtml: input.bodyHtml } : {}),
    };
    const updateRes = await deps.port.update(
      input.tenantId,
      input.templateId,
      patch,
      tx,
    );
    if (!updateRes.ok) return err(updateRes.error);

    const after = updateRes.value;
    await deps.audit.emit(tx, {
      eventType: 'broadcast_template_updated',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Template updated — ${after.name}`,
      payload: {
        templateId: after.id,
        before: {
          name: existing.name,
          subject: existing.subject,
          // bodyHtml excluded from before/after (size + privacy)
        },
        after: {
          name: after.name,
          subject: after.subject,
        },
      },
      requestId: input.requestId,
    });
    return ok({ templateId: after.id });
  });
}
