/**
 * T066 (F7.1a US2 / SC-005) — Integration test for ClamAV virus-scan
 * flow.
 *
 * Requires a reachable ClamAV daemon (env `CLAMAV_HOST` + `CLAMAV_PORT`).
 * Skips at runtime when daemon is unconfigured to avoid blocking CI on
 * environments without local Docker ClamAV (per Phase 2 connectivity
 * probe `scripts/verify-clamav-connectivity.ts` exit-code 2 contract).
 *
 * Three cases:
 *   - EICAR signature → verdict='infected' → reject + audit
 *   - clean PNG → verdict='clean' → upload succeeds
 *   - p95 scan latency ≤500ms for ≤2 MB files (SC-005)
 */
import { describe, expect, it } from 'vitest';
import { uploadInlineImage } from '@/modules/broadcasts/application/use-cases/upload-inline-image';
import { makeClamavVirusScanner } from '@/modules/broadcasts/infrastructure/clamav-virus-scanner';
import { makeDrizzleImageAllowlistRepo } from '@/modules/broadcasts/infrastructure/drizzle-image-allowlist-repo';
import { vercelBlobImageStorage } from '@/modules/broadcasts/infrastructure/vercel-blob-image-storage';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

const hasClamAV = !!process.env.CLAMAV_HOST;
const PNG_HEADER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(1024, 0x00),
]);
// EICAR test signature — official harmless virus-test string
const EICAR =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe.skipIf(!hasClamAV)(
  'image virus-scan flow — T066 (F7.1a US2 / SC-005)',
  () => {
    const tenantId = 'tenant_t066_scan';

    it('EICAR signature → verdict=infected → reject upload + audit', async () => {
      const auditEvents: Array<{ eventType: string }> = [];
      const r = await runInTenant(asTenantContext(tenantId), async () => {
        return uploadInlineImage(
          {
            allowlistPort: makeDrizzleImageAllowlistRepo(),
            scanner: makeClamavVirusScanner(),
            storage: vercelBlobImageStorage,
            audit: {
              async emit(_tx, e) {
                auditEvents.push({ eventType: e.eventType });
              },
            },
          },
          {
            tenantId: tenantId as never,
            actorUserId: 'user_test',
            actorEmail: 't@test.local',
            draftId: '11111111-1111-1111-1111-111111111111',
            requestId: 'req-eicar',
            fileBytes: Buffer.from(EICAR),
            filename: 'eicar.txt',
            mimeType: 'image/png',
          },
        );
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('broadcast_image_unsafe');
      expect(auditEvents.map((e) => e.eventType)).toContain(
        'broadcast_image_unsafe',
      );
    });

    it('clean PNG → verdict=clean → upload succeeds', async () => {
      const r = await runInTenant(asTenantContext(tenantId), async () => {
        return uploadInlineImage(
          {
            allowlistPort: makeDrizzleImageAllowlistRepo(),
            scanner: makeClamavVirusScanner(),
            storage: vercelBlobImageStorage,
            audit: { async emit() {} },
          },
          {
            tenantId: tenantId as never,
            actorUserId: 'user_test',
            actorEmail: 't@test.local',
            draftId: '22222222-2222-2222-2222-222222222222',
            requestId: 'req-clean',
            fileBytes: PNG_HEADER,
            filename: 'pixel.png',
            mimeType: 'image/png',
          },
        );
      });
      expect(r.ok).toBe(true);
    });

    it('scan latency p95 ≤500ms for ≤2MB files (SC-005)', async () => {
      const samples: number[] = [];
      for (let i = 0; i < 10; i++) {
        const buf = Buffer.alloc(2 * 1024 * 1024, 0xab);
        const start = performance.now();
        const v = await makeClamavVirusScanner().scan(buf);
        const dur = performance.now() - start;
        samples.push(dur);
        expect(v.verdict).toBe('clean');
      }
      samples.sort((a, b) => a - b);
      const p95Idx = Math.max(0, Math.floor(samples.length * 0.95) - 1);
      const p95 = samples[p95Idx] ?? 0;
      expect(p95).toBeLessThanOrEqual(500);
    });
  },
);
