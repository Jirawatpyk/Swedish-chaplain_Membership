/**
 * F119 T105 — `TestCopyMailerPort` (FR-037; research R23, V4 RESOLVED).
 *
 * The test copy is SYNCHRONOUS and NON-DURABLE — the result is reported
 * in-band — through the shared TRANSACTIONAL sender (`emailSender`,
 * `src/modules/auth/infrastructure/email/resend-client.ts`), never the
 * Resend Broadcasts surface: a test must not enter the marketing
 * suppression list or the reputation pool. No outbox row, no sixth
 * `notification_type`. Composed in `src/lib/broadcast-brand-deps.ts`.
 */
import type { Result } from '@/lib/result';

export interface TestCopyMessage {
  /** The SESSION user's own address — resolved server-side, never from the body. */
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

export type TestCopyMailerError = {
  readonly code: 'upstream-unavailable' | 'invalid-recipient';
  readonly message: string;
};

export interface TestCopyMailerPort {
  send(message: TestCopyMessage): Promise<Result<{ readonly messageId: string }, TestCopyMailerError>>;
}
