/**
 * T059 — `email-validator` package adapter for `EmailValidatorPort` (F7).
 *
 * Wraps the `email-validator@^2` package with lowercase+trim
 * normalisation. RFC-5321 strict mode (default for the package).
 *
 * Length cap: 254 characters per RFC-5321 § 4.5.3.1 (max forward-path).
 */
import { validate as validateRfc5321 } from 'email-validator';
import { err, ok } from '@/lib/result';
import type {
  EmailValidatorPort,
  EmailValidationError,
} from '../../application/ports/email-validator-port';
import type { Result } from '@/lib/result';

const MAX_LENGTH = 254;

export const rfc5321EmailValidator: EmailValidatorPort = {
  validate(raw: string): Result<string, EmailValidationError> {
    if (typeof raw !== 'string') {
      return err({ kind: 'email_validation.empty' });
    }
    const normalised = raw.trim().toLowerCase();
    if (normalised.length === 0) {
      return err({ kind: 'email_validation.empty' });
    }
    if (normalised.length > MAX_LENGTH) {
      return err({ kind: 'email_validation.too_long', raw });
    }
    if (!validateRfc5321(normalised)) {
      return err({ kind: 'email_validation.invalid_format', raw });
    }
    return ok(normalised);
  },
};
