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
 * ## Positive control (three layers, because one is not enough)
 *
 * 1. **Every ALLOWED entry must be FOUND** each run. A rotted pattern makes
 *    `findings` go empty, and a blind gate prints OK — the failure mode this
 *    repo has been burned by before (a role-literal sweep that silently
 *    stopped matching).
 * 2. **Each entry declares how many times it may match** (`expect`), checked
 *    in BOTH directions. Without it one allowlisted line blesses every future
 *    occurrence of the same substring in that file — so someone could add
 *    `recipientEmail: loaded.memberIdentitySnapshot.primary_contact_email` to
 *    `record-payment.ts` and the gate would wave through the exact bug this
 *    file exists to prevent. A read DISAPPEARING is information too.
 * 3. **Per-file floor**: a file whose comment-stripped text has no `import` or
 *    `export` line is almost certainly a stripper bug, not an empty file.
 *    Layers 1 and 2 cannot see that, because the three use cases this feature
 *    changed (`void-invoice`, `issue-credit-note`, `resend-pdf`) hold NO
 *    allowlist entries — the gate could go blind on exactly them and still
 *    report every entry found.
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
// `renewals` is in scope because it owns `mark-paid-offline` and the F4 bridge —
// today it addresses no money email from a snapshot, and the point of a gate is
// that it stays that way when someone adds one.
const SCOPE = [
  'src/modules/invoicing',
  'src/modules/payments',
  'src/modules/renewals',
  'src/app/api',
] as const;

/**
 * Each entry: the file, a substring of the matched line, how many lines in that
 * file may match it, and why this read is NOT a delivery address.
 * "It was already there" is not a reason.
 */
interface AllowedRead {
  readonly file: string;
  readonly contains: string;
  /** Exact number of matching lines permitted. Checked in both directions. */
  readonly expect: number;
  /**
   * Code that must still exist in the same file for this entry's `why` to hold.
   *
   * Without it an entry blesses a LINE while its justification is about the
   * CALL that line feeds — repoint `deps.receiptPdfRenderEnqueue.enqueue` at
   * `deps.outbox.enqueue` and the matched line stays byte-identical, the count
   * stays 1, and a render task quietly becomes a money email addressed from the
   * snapshot. Checked against the whole file rather than a line window because
   * the consumer is often far from the read (60 lines, in the reconcile cron).
   * Deleting or renaming the consumer makes the entry stop matching, which the
   * count check then reports.
   */
  readonly boundTo?: string;
  readonly why: string;
}

const ALLOWED: ReadonlyArray<AllowedRead> = [
  {
    file: 'src/modules/invoicing/application/lib/resolve-money-recipient.ts',
    contains: 'snapshot?.primary_contact_email',
    expect: 1,
    why:
      'the non-member arm: an event buyer has no contact row, so the address an ' +
      'admin typed at issue IS the only address. Every member invoice takes the ' +
      'live branch above it.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/record-payment.ts',
    contains: 'loaded.memberIdentitySnapshot.primary_contact_email',
    expect: 1,
    // Bound to its consumer: this read is only safe because it feeds the
    // RENDER-TASK enqueue. Remove or repoint that call and the entry stops
    // matching — which is the original bug wearing this line's face.
    boundTo: 'receiptPdfRenderEnqueue.enqueue',
    why:
      'the async receipt-PDF RENDER TASK, not an email: notifications_outbox.' +
      'to_email is NOT NULL and the dispatcher routes render rows by ' +
      'notification_type, so the column is filled from the snapshot with a system ' +
      'sentinel fallback. No mail is addressed from it.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/issue-invoice.ts',
    contains: 'memberSnap.primary_contact_email',
    expect: 1,
    why:
      'ISSUE time, and BOTH arms of resolve-invoice-buyer are safe for different ' +
      'reasons — the half-true version of this note said only the first. Member ' +
      'arm: memberSnap is re-read live in this same tx via ' +
      'memberIdentity.getForIssue, so snapshot and live are the same row. ' +
      'Non-member arm: getForIssue is never called (issue-invoice says so ' +
      'explicitly) and the draft-pinned snapshot is used — safe because an event ' +
      'buyer has no contact row that could have moved, exactly like the ' +
      "resolver's own non_member arm.",
  },
  {
    file: 'src/modules/invoicing/application/use-cases/issue-event-invoice-as-paid.ts',
    contains: 'memberSnap.primary_contact_email',
    expect: 1,
    why:
      'same as issue-invoice, including the two-arm reasoning: live re-read for a ' +
      'matched member, draft-pinned for a non-member event buyer who has no ' +
      'contact row.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/create-event-invoice-draft.ts',
    contains: 'primary_contact_email: input.buyer.primary_contact_email',
    // The token appears twice on that one line (destination and source).
    expect: 2,
    why:
      'BUILDING the snapshot for a non-member event buyer from admin-typed input ' +
      '— the write side of the identity record, not a read for delivery.',
  },
  {
    file: 'src/modules/invoicing/application/use-cases/create-event-invoice-draft.ts',
    contains: 'primary_contact_email: z.union',
    expect: 1,
    why: 'zod schema for the admin-typed buyer block — a declaration, not a read.',
  },
  {
    file: 'src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts',
    contains: 'primary_contact_email: primaryContact?.email',
    expect: 1,
    why:
      'BUILDING the identity snapshot from the live primary contact at issue (the ' +
      'write side). This is the read the frozen value comes from.',
  },
  {
    file: 'src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts',
    contains: 'readonly primary_contact_email: string;',
    expect: 1,
    why: 'the type declaration of the snapshot itself.',
  },
  {
    file: 'src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts',
    contains: 'primary_contact_email: z.union([',
    expect: 1,
    why: 'the snapshot zod schema — a declaration, not a read.',
  },
  {
    file: 'src/modules/invoicing/application/lib/resolve-money-recipient.ts',
    contains: 'readonly primary_contact_email?: string | null;',
    expect: 1,
    why: 'the narrowed snapshot type the resolver accepts — a declaration.',
  },
  {
    file: 'src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts',
    contains: 'must be a valid email',
    expect: 1,
    why: 'the zod validation MESSAGE for that field, not a read.',
  },
  {
    file: 'src/app/api/internal/cron/receipt-pdf-reconcile/route.ts',
    contains: '| { primary_contact_email?: string }',
    expect: 1,
    why: 'local cast of the snapshot JSON in the render-reconcile cron — a type.',
  },
  {
    file: 'src/app/api/internal/cron/receipt-pdf-reconcile/route.ts',
    contains: "return snap?.primary_contact_email ??",
    expect: 1,
    // Same binding: safe only as the render-reconcile row's copy-forward.
    boundTo: 'receiptPdfRenderEnqueueAdapter.enqueue',
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
    // Three sites: the field list plus the two SQL redaction literals.
    expect: 3,
    why:
      'GDPR erasure: the field is being redacted OUT of the snapshot, the exact ' +
      'opposite of addressing mail with it.',
  },
];

const READ = /(?<![\w$])primary_contact_email(?![\w$])/g;

/**
 * Layer-3 sentinel. Deliberately NOT a keyword match: the first attempt looked
 * for an `import`/`export` line in the stripped text and reported EVERY file as
 * blind — a useful reminder that a sentinel you have not watched fail is not a
 * sentinel. This one states the failure directly: a file with real content whose
 * stripped form has no non-empty line left means the stripper ate it, and the
 * scan of that file saw nothing.
 */
function looksStripped(raw: string, lines: readonly string[]): boolean {
  const rawHasContent = raw.split(String.fromCharCode(10)).some((l) => l.trim().length > 0);
  const anySurvived = lines.some((l) => l.trim().length > 0);
  return rawHasContent && !anySurvived;
}

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
const matchCounts = new Map<number, number>();
const blindFiles: string[] = [];
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
    // Per-file floor (layer 3). Every source file in scope has at least one
    // import or export; a file that has none AFTER stripping means the stripper
    // ate it, and the gate would then be blind to that file while still
    // reporting every allowlist entry found.
    if (looksStripped(raw, lines)) {
      blindFiles.push(shown);
    }
    READ.lastIndex = 0;
    for (const m of code.matchAll(READ)) {
      const lineNo = lineOfIndex(code, m.index ?? 0);
      const lineText = lines[lineNo] ?? '';
      const idx = ALLOWED.findIndex(
        (a) =>
          a.file === shown &&
          lineText.includes(a.contains) &&
          (a.boundTo === undefined || code.includes(a.boundTo)),
      );
      if (idx >= 0) {
        matchCounts.set(idx, (matchCounts.get(idx) ?? 0) + 1);
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

if (blindFiles.length > 0) {
  console.error(
    'check:money-recipient ABORT — comment-stripping left a file with NO ' +
      'non-empty line at all, so the scan of it saw nothing. Fires only on ' +
      'TOTAL loss (an unterminated block comment, say); a PARTIAL loss is not ' +
      'covered — see Honest limits. Affected:\n  ' +
      blindFiles.join('\n  '),
  );
  process.exit(1);
}

const drifted = ALLOWED.map((a, i) => ({ a, found: matchCounts.get(i) ?? 0 })).filter(
  ({ a, found }) => found !== a.expect,
);
if (drifted.length > 0) {
  console.error(
    'check:money-recipient ABORT — allowlist drift. Each entry declares how ' +
      'many times it may match; a HIGHER count means a new unreviewed read hid ' +
      'behind an allowlisted one, a LOWER count means the entry is stale or the ' +
      'scanner stopped seeing it:\n  ' +
      drifted
        .map(
          ({ a, found }) =>
            `${a.file} :: ${a.contains} — expected ${a.expect}, found ${found}`,
        )
        .join('\n  '),
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

const justified = [...matchCounts.values()].reduce((a, b) => a + b, 0);
console.log(
  `check:money-recipient — OK (${scanned} file(s); 0 snapshot-addressed emails, ` +
    `${justified} justified read(s) across ${ALLOWED.length} allowlist entries).`,
);
