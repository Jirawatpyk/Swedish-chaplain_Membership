/**
 * F119 T140/T145 (FR-039, FR-046) — the tenant's E-Blast templates WITH their
 * content, for the compose screens.
 *
 * The picker used to hand a template id to the server through
 * `?template=<id>`, which is why the form was remounted and typed text was
 * lost. Selecting a template is now a client-side re-seed, so the content has
 * to be on the client before the choice is made: this resolves every template
 * the member's locale cascade offers, with `substituteChamberName` already
 * applied — the same substitution the `?template=` deep link performs — so the
 * two paths can never produce different copy.
 *
 * Both compose pages call it (member and staff compose-on-behalf), which is
 * the whole reason it is not inlined in either.
 *
 * Failures degrade to an empty list, exactly as the picker already did: a DB
 * or RLS problem must not take the compose surface down with it.
 */
import { hashId } from '@/lib/log-id';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import {
  envTenantDisplayName,
  listBroadcastTemplates,
  makeListBroadcastTemplatesDeps,
  substituteChamberName,
} from '@/modules/broadcasts';
import type { ComposeTemplateOption } from '@/components/broadcast/compose/template-picker-field';

export async function loadComposeTemplateOptions(
  tenant: TenantContext,
  locale: 'en' | 'th' | 'sv',
  /** Hashed into the failure log so a recurring failure can be correlated. */
  userId: string,
): Promise<readonly ComposeTemplateOption[]> {
  try {
    const rows = await runInTenant(tenant, async () =>
      listBroadcastTemplates(makeListBroadcastTemplatesDeps(tenant.slug), {
        tenantId: tenant.slug,
        currentUserLocale: locale,
      }),
    );
    const chamberName = await envTenantDisplayName.resolve(tenant.slug);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      locale: r.locale,
      isSeeded: r.isSeeded,
      subject: substituteChamberName(r.subject, chamberName),
      bodyHtml: substituteChamberName(r.bodyHtml, chamberName),
    }));
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        tenantId: tenant.slug,
        userIdHash: hashId(userId),
      },
      'broadcasts.compose.template_picker_list_failed',
    );
    return [];
  }
}
