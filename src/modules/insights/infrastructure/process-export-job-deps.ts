/**
 * F9 US5 — `processExportJob` worker composition root (T071).
 *
 * SEPARATE from `insights-deps.ts` on purpose: this binds the react-pdf
 * artefact adapter (`@react-pdf/renderer` is heavy). The main barrel does NOT
 * re-export this, so App-Router pages that import `@/modules/insights` never
 * drag react-pdf into their client/server bundle (`check:bundle-budgets`). Only
 * the `process-export-jobs` cron route imports this module.
 */
import { systemClock } from './insights-deps';
import { insightsAuditAdapter } from './audit/insights-audit-adapter';
import { makeDrizzleDirectoryRepo } from './repos/drizzle-directory-repo';
import { makeDrizzleExportJobRepo } from './repos/drizzle-export-job-repo';
import { directoryArtefactAdapter } from './directory-artefact-adapter';
import { privateBlobAdapter } from './blob/private-blob-adapter';
import type { ProcessExportJobDeps } from '../application/use-cases/process-export-job';

/**
 * Single-tenant MVP chamber name (mirrors the F7 `TenantDisplayNamePort` adapter
 * + `admin/layout.tsx` sidebar). F10 multi-tenant reads `tenants.display_name`.
 */
const TENANT_DISPLAY_NAME = process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham';

export function makeProcessExportJobDeps(tenantId: string): ProcessExportJobDeps {
  return {
    exportJobRepo: makeDrizzleExportJobRepo(tenantId),
    directoryRepo: makeDrizzleDirectoryRepo(tenantId),
    artefact: directoryArtefactAdapter,
    blob: privateBlobAdapter,
    audit: insightsAuditAdapter,
    clock: systemClock,
    tenantName: TENANT_DISPLAY_NAME,
    // FR-026 — SweCham's default display locale is EN; F10 reads tenant config.
    tenantDefaultLocale: 'en',
  };
}
