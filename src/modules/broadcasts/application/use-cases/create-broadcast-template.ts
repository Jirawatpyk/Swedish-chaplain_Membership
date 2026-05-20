/**
 * T099 (F7.1a US7) — `createBroadcastTemplate` Application use-case.
 *
 * Admin-only template create flow per contracts/broadcast-template.md
 * § 1.1 + FR-046:
 *   1. zod validate name (≤100) + subject (≤200) + body (≤200KB)
 *   2. Body validated against tenant image-source allowlist (FR-017
 *      — same enforcement as broadcast submit, no template bypass)
 *   3. Atomic mutation+audit via port.withTx (Constitution Principle I
 *      clause 3) — port.create + audit.emit(tx, ...) in ONE tx so a
 *      transient audit-storage failure rolls back the template row
 *   4. Audit payload: actor + templateId + name + subject (body
 *      excluded to keep audit row size bounded)
 *
 * Pure Application logic — no framework imports (Constitution Principle
 * III NON-NEGOTIABLE).
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  BroadcastTemplatesPort,
  TemplateCreateError,
  TemplateLocale,
} from '../ports/broadcast-templates-port';
import type { AuditPort } from '../ports/audit-port';
import {
  validateImageSourceAllowlist,
  type ValidateImageSourceAllowlistDeps,
} from './validate-image-source-allowlist';
import type { TenantSlug } from '@/modules/tenants';

const MAX_NAME = 100;
const MAX_SUBJECT = 200;
const MAX_BODY = 200 * 1024;

export interface CreateBroadcastTemplateDeps {
  readonly port: BroadcastTemplatesPort;
  readonly audit: AuditPort;
  readonly validateImageSourceAllowlist: ValidateImageSourceAllowlistDeps;
}

export interface CreateBroadcastTemplateInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  readonly name: string;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly locale: TemplateLocale;
  readonly requestId: string;
}

export type CreateBroadcastTemplateError =
  | { readonly kind: 'invalid_input'; readonly detail: string }
  | {
      readonly kind: 'template_body_unsafe';
      readonly unsafeImageSources: readonly string[];
    }
  | TemplateCreateError;

export interface CreateBroadcastTemplateOutput {
  readonly templateId: string;
}

export async function createBroadcastTemplate(
  deps: CreateBroadcastTemplateDeps,
  input: CreateBroadcastTemplateInput,
): Promise<
  Result<CreateBroadcastTemplateOutput, CreateBroadcastTemplateError>
> {
  // 1. Input validation — fast-fail before any port/audit work.
  if (input.name.length === 0 || input.name.length > MAX_NAME) {
    return err({
      kind: 'invalid_input',
      detail: `name length must be 1..${MAX_NAME}`,
    });
  }
  if (input.subject.length === 0 || input.subject.length > MAX_SUBJECT) {
    return err({
      kind: 'invalid_input',
      detail: `subject length must be 1..${MAX_SUBJECT}`,
    });
  }
  if (input.bodyHtml.length > MAX_BODY) {
    return err({
      kind: 'invalid_input',
      detail: `body length must be ≤${MAX_BODY}`,
    });
  }

  // 2. Image-source allowlist check (FR-017) — emits its own audit on
  //    rejection (broadcast_body_image_source_unsafe).
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

  // 3. Atomic mutation + audit (Constitution Principle I clause 3).
  return deps.port.withTx(input.tenantId, async (tx) => {
    const createRes = await deps.port.create(
      input.tenantId,
      {
        name: input.name,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        locale: input.locale,
        createdByUserId: input.actorUserId,
      },
      tx,
    );
    if (!createRes.ok) return err(createRes.error);

    const template = createRes.value;
    await deps.audit.emit(tx, {
      eventType: 'broadcast_template_created',
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      summary: `Template created — ${template.name} (${template.locale})`,
      payload: {
        templateId: template.id,
        name: template.name,
        subject: template.subject,
        locale: template.locale,
        // body excluded to keep audit row bounded (FR-021 + privacy)
      },
      requestId: input.requestId,
    });
    return ok({ templateId: template.id });
  });
}
