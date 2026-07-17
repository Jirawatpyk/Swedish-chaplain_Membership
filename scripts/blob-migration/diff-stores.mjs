/** READ-ONLY: symmetric difference between US and SG stores (list only). */
import { list } from '@vercel/blob';
const OLD = process.env.OLD_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;

async function all(token) {
  const s = new Set(); let c;
  do { const p = await list({ token, cursor: c, limit: 1000 }); for (const b of p.blobs) if (!b.pathname.endsWith('/')) s.add(b.pathname); c = p.cursor; } while (c);
  return s;
}
const isReal = (p) => /(^|\/)swecham\//.test(p);

const us = await all(OLD), sg = await all(NEW);
const usOnly = [...us].filter((k) => !sg.has(k));
const sgOnly = [...sg].filter((k) => !us.has(k));

console.log('US total :', us.size);
console.log('SG total :', sg.size);
console.log('DIFFERENT (US XOR SG):', usOnly.length + sgOnly.length);
console.log('  in US but NOT SG :', usOnly.length, `(swecham-path: ${usOnly.filter(isReal).length}, test/junk: ${usOnly.filter((k) => !isReal(k)).length})`);
console.log('  in SG but NOT US :', sgOnly.length, `(swecham-path: ${sgOnly.filter(isReal).length})`);
