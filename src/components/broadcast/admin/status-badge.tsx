/**
 * The staff stage badge on the E-Blast detail page.
 *
 * Async server component — uses next-intl/server.
 *
 * Spec 122 US12c-1 (T1222) — an AURA `StatusPill` in the tone
 * `getBroadcastStatusTone` gives the stage, the same pill and tone as the
 * queue's Stage column (US12b), so one stage reads the same in the list and
 * on its page.
 *
 * F119 UX review H3 (T120's rule) — a long label (SV runs up to +28 %) must
 * not overflow a 320 px header: the pill wraps its words inside itself
 * (`wrap`, AURA 5.51 #158), so nothing is cut off.
 */
import { getTranslations } from 'next-intl/server';
import { StatusPill } from '@jirawatpyk/aura-react/server';
import type { BroadcastStatus } from '@/modules/broadcasts';
import { getBroadcastStatusTone } from '@/components/broadcast/status-badge-mapping';

export interface StatusBadgeProps {
  readonly status: BroadcastStatus;
}

export async function StatusBadge({
  status,
}: StatusBadgeProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.queue.status');
  return (
    <StatusPill tone={getBroadcastStatusTone(status)} wrap className="max-w-full">
      {t(status)}
    </StatusPill>
  );
}
