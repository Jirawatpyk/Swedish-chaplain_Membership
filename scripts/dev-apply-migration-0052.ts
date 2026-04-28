/** DEV-ONLY — apply migration 0052 (add payment_acknowledged_terminal_state enum value). */
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
      `DO $$ BEGIN ALTER TYPE "audit_event_type" ADD VALUE 'payment_acknowledged_terminal_state'; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
    );
    console.log('✓ payment_acknowledged_terminal_state added to audit_event_type enum');
  } finally {
    await client.end();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
