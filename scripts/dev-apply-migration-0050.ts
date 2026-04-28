/** DEV-ONLY — apply migration 0050 (add stale_pending_refund_detected enum value). */
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const lower = url.toLowerCase();
  if (
    process.env.NODE_ENV === 'production' ||
    lower.includes('vercel-storage') ||
    lower.includes('-prod') ||
    lower.includes('.prod.') ||
    lower.includes('-live') ||
    lower.includes('.live.')
  ) {
    throw new Error('REFUSED: production-looking DATABASE_URL. Set DEV_SCRIPT_FORCE=1 to bypass.');
  }
  const client = postgres(url, { max: 1 });
  try {
    await client.unsafe(
      `DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'stale_pending_refund_detected'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    console.log('✓ stale_pending_refund_detected added to audit_event_type enum');
  } finally {
    await client.end();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
