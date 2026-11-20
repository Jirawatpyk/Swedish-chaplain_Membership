/**
 * #739 B3a — the class chain of a thrown value: what the events module
 * stores about a failure (the `webhook_rolled_back` audit payload's
 * `errClass`). It replaces R5.4's `formatErrorWithCause`, which rendered
 * `${e.message} (cause: ${name}: ${message})`: a drizzle error's message
 * quotes bound parameters, so that text put emails and names into a
 * 5-year audit row.
 *
 * Contract:
 *   - non-Error → `unknown`;
 *   - Error → its class (`e.name` when it is a token other than `Error`,
 *     so a synthetic cause's discriminator survives; else the constructor);
 *   - Error with an Error cause → `Outer(cause:Inner)`; any other cause is
 *     dropped.
 *
 * The failure stage stays on its own field (`failureStage`), and the log
 * line carries `errLogFields(e)`.
 */
import { errKind } from '@/lib/log-id';

const CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function className(e: Error): string {
  return e.name !== 'Error' && CLASS_NAME.test(e.name) ? e.name : errKind(e);
}

export function formatErrorClass(e: unknown): string {
  if (!(e instanceof Error)) return 'unknown';
  return e.cause instanceof Error ? `${className(e)}(cause:${className(e.cause)})` : className(e);
}
