/**
 * check:money-recipient — a money email's DELIVERY address is never read from
 * the frozen buyer snapshot.
 *
 * ## Why this exists
 *
 * An invoice carries two different facts that look identical in code:
 *
 *   • WHO WAS BILLED — `member_identity_snapshot.primary_contact_email`,
 *     frozen at issue. Thai Revenue Code §86/4 requires the tax document to
 *     keep naming the buyer as they were then. It must never move.
 *   • WHERE THE EMAIL GOES — the member's primary contact RIGHT NOW.
 *
 * Reading the first to answer the second is a one-token mistake that compiles,
 * type-checks and passes every test pinning the snapshot — and it shipped:
 * every F4 auto-email (receipt, void notice, credit note, resend) addressed the
 * snapshot, so after a member promoted a new primary contact their invoices
 * kept reaching the person who left. The reverse mistake is just as quiet: a
 * PDF that renders the LIVE contact silently rewrites a tax document.
 *
 * Nothing in the type system separates them — both are `string`. This gate is
 * the separation.
 *
 * ## What it checks
 *
 * Every `primary_contact_email` read under `src/modules/invoicing/**`,
 * `src/modules/payments/**` and `src/app/api/**`, on comment-stripped source,
 * must match an ALLOWED entry naming the file, the code it appears in, and why
 * that read is about IDENTITY (or an issue-time equivalence), not delivery.
 *
 * ## Positive control
 *
 * Every ALLOWED entry must be FOUND on each run. If the pattern rots or the
 * comment stripper changes shape, `findings` goes empty and a broken gate would
 * print OK while seeing nothing — the failure mode this repo has been burned by
 * before (a role-literal sweep that silently stopped matching).
 *
 * ## Honest limits
 *
 * A read laundered through a variable is caught at the read site only, which is
 * the point: the allowlist entry must then justify what that variable is for. A
 * dynamic key (`snap['primary' + '_contact_email']`) is not caught — the
 * behavioural net for that shape is the live-recipient tests under
 * `tests/integration/invoicing/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { lineOfIndex, stripCommentLines } from './lib/source-scan';

const ROOT = process.cwd();
const SCOPE = ['src/modules/invoicing', 'src/modules/payments', 'src/app/api'] as const;

/**
 * Each entry: the file, a substring of the matched line, and why this read is
 * NOT a delivery address. "It was already there" is not a reason.
 */
const ALLOWED: ReadonlyArray<{ file: string; contains: string; why: string }> = [
  {
    file: 'src/modules/invoicing/application/lib/resolve-money-recipient.ts',
    contains: 'snapshot?.primary_contact_email',
    why:
      'the non-member arm: an event buyer has no contact row, so the address an ' +
      'admin typed at issue IS the only address. Every member invoice takes the ' +
      'live branch above it.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/record-payment.ts',
    contains: 'loaded.memberIdentitySnapshot.primary_contact_email',
    why:
      'the async receipt-PDF RENDER TASK, not an email: notifications_outbox.' +
      'to_email is NOT NULL and the dispatcher routes render rows by ' +
      'notification_type, so the column is filled from the snapshot with a system ' +
      'sentinel fallback. No mail is addressed from it.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/issue-invoice.ts',
    contains: 'memberSnap.primary_contact_email',
    why:
      'ISSUE time: memberSnap was just built in this same tx from the live ' +
      'primary contact (memberIdentity.getForIssue), so snapshot and live are the ' +
      'same row. There is no window in which they can differ.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts',
    contains: 'memberSnap.primary_contact_email',
    why: 'same as issue-invoice — the snapshot is taken live in the issuing tx.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/create-event-invoice-draft.ts',
    contains: 'primary_contact_email: input.buyer.primary_contact_email',
    why:
      'BUILDING the snapshot for a non-member event buyer from admin-typed input ' +
      '— the write side of the identity record, not a read for delivery.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/create-event-invoice-draft.ts',
    contains: 'primary_contact_email: z.union',
    why: 'zod schema for the admin-typed buyer block — a declaration, not a read.',
  },
  {
    file: 'src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts',
    contains: 'primary_contact_email: primaryContact?.email',
    why:
      'BUILDING the identity snapshot from the live primary contact at issue (the ' +
      'write side). This is the read the frozen value comes from.',
  },
  {
    file: 'src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts',
    contains: 'readonly primary_contact_email: string;',
    why: 'the type declaration of the snapshot itself.',
  },
  {
    file: 'src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts',
    contains: 'primary_contact_email: z.union([',
    why: 'the snapshot zod schema — a declaration, not a read.',
  },
  {
    file: 'src/modules/invoicing/application/lib/resolve-money-recipient.ts',
    contains: 'readonly primary_contact_email?: string | null;',
    why: 'the narrowed snapshot type the resolver accepts — a declaration.',
  },
  {
    file: 'src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts',
    contains: 'must be a valid email',
    why: 'the zod validation MESSAGE for that field, not a read.',
  },
  {
    file: 'src/app/api/internal/cron/receipt-pdf-reconcile/route.ts',
    contains: '| { primary_contact_email?: string }',
    why: 'local cast of the snapshot JSON in the render-reconcile cron — a type.',
  },
  {
    file: 'src/app/api/internal/cron/receipt-pdf-reconcile/route.ts',
    contains: "return snap?.primary_contact_email ??",
    why:
      'the render-reconcile cron re-enqueues a RENDER TASK, not an email ' +
      '(renderReceiptPdf never reads this field). notifications_outbox.to_email ' +
      'is NOT NULL, so the row copies the snapshot value forward for audit ' +
      'readability with a system sentinel fallback. Same class as the ' +
      'record-payment render enqueue above.',
  },
  {
    file: 'src/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step.ts',
    contains: "'primary_contact_email',",
    why:
      'GDPR erasure: the field is being redacted OUT of the snapshot, the exact ' +
      'opposite of addressing mail with it.',
  },
];

const READ = /(?<![\w$])primary_contact_email(?![\w$])/g;

/** The scanner quotes the literals it authorises, so it must skip itself. */
const SELF = 'scripts/check-money-email-recipient.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const findings: string[] = [];
const matchedEntries = new Set<number>();
let scanned = 0;

for (const root of SCOPE) {
  const abs = join(ROOT, root);
  let files: string[];
  try {
    files = walk(abs);
  } catch {
    console.error(`check:money-recipient ABORT — scope root missing: ${root}`);
    process.exit(1);
  }
  for (const file of files) {
    const shown = relative(ROOT, file).replace(/\\/g, '/');
    if (shown === SELF) continue;
    scanned += 1;
    const raw = readFileSync(file, 'utf8');
    const lines = stripCommentLines(raw);
    const code = lines.join('\n');
    READ.lastIndex = 0;
    for (const m of code.matchAll(READ)) {
      const lineNo = lineOfIndex(code, m.index ?? 0);
      const lineText = lines[lineNo] ?? '';
      const idx = ALLOWED.findIndex(
        (a) => a.file === shown && lineText.includes(a.contains),
      );
      if (idx >= 0) {
        matchedEntries.add(idx);
        continue;
      }
      findings.push(`  ✗ ${shown}:${lineNo + 1}: ${lineText.trim()}`);
    }
  }
}

if (scanned === 0) {
  console.error('check:money-recipient ABORT — scanned 0 files.');
  process.exit(1);
}

if (matchedEntries.size !== ALLOWED.length) {
  const missing = ALLOWED.filter((_, i) => !matchedEntries.has(i)).map(
    (a) => `${a.file} :: ${a.contains}`,
  );
  console.error(
    `check:money-recipient ABORT — allowlist drift: ${matchedEntries.size} of ` +
      `${ALLOWED.length} justified read(s) were found. Either an entry is stale ` +
      '(delete it) or the scanner stopped seeing them:\n  ' +
      missing.join('\n  '),
  );
  process.exit(1);
}

if (findings.length > 0) {
  console.error(
    `check:money-recipient — ${findings.length} snapshot recipient read(s):\n` +
      findings.join('\n') +
      '\n\nA money email goes to the member LIVE primary contact: resolve it with ' +
      '`resolveMoneyRecipient` (invoicing) or `BillingRecipientPort` (payments). ' +
      'The frozen `member_identity_snapshot` fixes WHO WAS BILLED on the tax ' +
      'document (§86/4) — never where the mail goes. If this read really is about ' +
      'identity, add it to ALLOWED in this script with the reason.',
  );
  process.exit(1);
}

console.log(
  `check:money-recipient — OK (${scanned} file(s); 0 snapshot-addressed emails, ` +
    `${matchedEntries.size} justified read(s)).`,
);
