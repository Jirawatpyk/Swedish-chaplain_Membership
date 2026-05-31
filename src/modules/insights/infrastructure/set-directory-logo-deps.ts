/**
 * F9 US5 — logo use-case composition root (T079).
 *
 * SEPARATE from `insights-deps.ts`: this binds the `sharp` adapter (a native
 * `server-only` libvips dep). The main barrel does NOT re-export this, so pages
 * importing `@/modules/insights` never pull `sharp` into their bundle. Only the
 * logo upload server action / route imports this module.
 */
import { insightsAuditAdapter } from './audit/insights-audit-adapter';
import { makeDrizzleDirectoryRepo } from './repos/drizzle-directory-repo';
import { sharpLogoAdapter } from './logo/sharp-logo-adapter';
import { publicLogoBlobAdapter } from './logo/public-logo-blob-adapter';
import type {
  RemoveDirectoryLogoDeps,
  SetDirectoryLogoDeps,
} from '../application/use-cases/set-directory-logo';

export function makeSetDirectoryLogoDeps(tenantId: string): SetDirectoryLogoDeps {
  return {
    directoryRepo: makeDrizzleDirectoryRepo(tenantId),
    image: sharpLogoAdapter,
    logoStore: publicLogoBlobAdapter,
    audit: insightsAuditAdapter,
  };
}

export function makeRemoveDirectoryLogoDeps(
  tenantId: string,
): RemoveDirectoryLogoDeps {
  return {
    directoryRepo: makeDrizzleDirectoryRepo(tenantId),
    logoStore: publicLogoBlobAdapter,
    audit: insightsAuditAdapter,
  };
}
