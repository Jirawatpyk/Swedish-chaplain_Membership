import postgres from 'postgres';
const url = process.env.DATABASE_URL!;
const client = postgres(url, { max: 1 });
client`SELECT enumlabel FROM pg_enum WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'audit_event_type') ORDER BY enumsortorder`.then(rows => {
  const labels = (rows as unknown as Array<{enumlabel:string}>).map(r => r.enumlabel);
  console.log('payment_method_switched present:', labels.includes('payment_method_switched'));
  console.log('total enum values:', labels.length);
  return client.end();
}).catch(e => { console.error(e); process.exit(1); });
