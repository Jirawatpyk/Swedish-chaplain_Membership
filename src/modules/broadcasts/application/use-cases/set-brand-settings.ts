/**
 * F119 T024 — `setBrandSettings` (FR-041b/c).
 *
 * Writes ONE primary colour and the chamber postal address. A colour whose
 * contrast with white text is below WCAG AA 4.5:1 is refused with the
 * computed ratio and the previous colour stays in force (spec § Edge Cases
 * "Brand colour too light"). The write and its audit row
 * (`broadcast_brand_settings_changed { previous, next, actor_role }`) share
 * one tenant tx — a failed audit emit rolls the write back.
 *
 * The read is `findForUpdate` (create-then-lock), never `find`: the write
 * merges the untouched field from it, so two admins saving DIFFERENT fields
 * at once must serialise — otherwise the second write reverts the first and
 * its audit `previous` names a state that no longer existed.
 *
 * Voids NOTHING: brand chrome is not content (FR-012). This use case has no
 * port for versions, stages or `approved_version_id`, so it cannot touch
 * them by construction.
 *
 * The payload carries the VALUES (a colour and a postal address are the
 * chamber's configuration, not text a member wrote) — the one F119 audit
 * payload that legitimately does. `actor_role` is the session role passed
 * in, `?? null`, never a literal (`check:actor-role-truth`).
 *
 * 100 % branch pinned (T157). Pure Application — no framework imports.
 */
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import {
  BRAND_POSTAL_ADDRESS_MAX,
  parseBrandPostalAddress,
  parseBrandPrimaryColor,
} from '../../domain/brand/brand-settings';
import { AA_MIN_CONTRAST, contrastRatioOnWhite, meetsAaOnWhiteText } from '../../domain/brand/contrast';
import type { AuditPort } from '../ports/audit-port';
import type { BrandSettingsRecord, BrandSettingsRepo } from '../ports/brand-settings-repo';

export interface SetBrandSettingsDeps {
  readonly repo: BrandSettingsRepo;
  readonly audit: AuditPort;
}

export interface SetBrandSettingsInput {
  readonly tenantId: TenantSlug;
  readonly actorUserId: string;
  /** The session role — recorded as-is (`null` when absent), never defaulted. */
  readonly actorRole: string | null;
  readonly requestId: string;
  /** `undefined` = leave unchanged; `null` = clear; string = `#RRGGBB`. */
  readonly primaryColor: string | null | undefined;
  /** `undefined` = leave unchanged; `null` = clear; string ≤ 300 chars. */
  readonly postalAddress: string | null | undefined;
}

export type SetBrandSettingsError =
  | { readonly kind: 'invalid_color_format' }
  | { readonly kind: 'colour_contrast'; readonly ratio: number; readonly required: typeof AA_MIN_CONTRAST }
  | { readonly kind: 'address_too_long'; readonly max: typeof BRAND_POSTAL_ADDRESS_MAX }
  /**
   * `detail` is raw Postgres text that can embed SQL param VALUES (the postal
   * address) — never logged. `errKind` is the error CLASS (F7-5), the one
   * PII-free field on-call can read.
   */
  | { readonly kind: 'storage_error'; readonly detail: string; readonly errKind: string };

export async function setBrandSettings(
  deps: SetBrandSettingsDeps,
  input: SetBrandSettingsInput,
): Promise<Result<BrandSettingsRecord, SetBrandSettingsError>> {
  // Every refusal is decided ABOVE the first write (a refusal inside the tx
  // would still commit whatever preceded it).
  let nextColor: string | null | undefined;
  if (input.primaryColor !== undefined) {
    const parsed = parseBrandPrimaryColor(input.primaryColor);
    if (!parsed.ok) return err({ kind: 'invalid_color_format' });
    if (parsed.value !== null && !meetsAaOnWhiteText(parsed.value)) {
      return err({ kind: 'colour_contrast', ratio: contrastRatioOnWhite(parsed.value), required: AA_MIN_CONTRAST });
    }
    nextColor = parsed.value;
  }
  let nextAddress: string | null | undefined;
  if (input.postalAddress !== undefined) {
    const parsed = parseBrandPostalAddress(input.postalAddress);
    if (!parsed.ok) return err({ kind: 'address_too_long', max: parsed.error.max });
    nextAddress = parsed.value;
  }

  try {
    return await deps.repo.withTx(input.tenantId, async (tx) => {
      const previous = await deps.repo.findForUpdate(input.tenantId, tx);
      const next = {
        primaryColor: nextColor === undefined ? previous.primaryColor : nextColor,
        postalAddress: nextAddress === undefined ? previous.postalAddress : nextAddress,
      };
      if (next.primaryColor === previous.primaryColor && next.postalAddress === previous.postalAddress) {
        return ok(previous);
      }
      const saved = await deps.repo.save(
        input.tenantId,
        { ...next, updatedByUserId: input.actorUserId },
        tx,
      );
      await deps.audit.emit(tx, {
        eventType: 'broadcast_brand_settings_changed',
        tenantId: input.tenantId,
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        summary: 'E-Blast brand settings changed',
        payload: {
          previous: { primaryColor: previous.primaryColor, postalAddress: previous.postalAddress },
          next,
          actor_role: input.actorRole ?? null,
        },
      });
      return ok(saved);
    });
  } catch (e) {
    return err({ kind: 'storage_error', detail: e instanceof Error ? e.message : String(e), errKind: errKind(e) });
  }
}
