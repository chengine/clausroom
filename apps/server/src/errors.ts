/**
 * Typed HTTP errors matching the binding ApiError envelope and the
 * code -> status mapping in docs/API-CONTRACT.md §7.
 */
import type { ErrorCode } from '@clausroom/protocol';
import type { ZodError } from 'zod';

export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const unauthorized = (message = 'Missing, invalid, revoked, or used token.'): HttpError =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'You are not allowed to perform this action.'): HttpError =>
  new HttpError(403, 'forbidden', message);

export const notFound = (message = 'Not found.'): HttpError =>
  new HttpError(404, 'not_found', message);

export const conflict = (message = 'Conflicting state transition.'): HttpError =>
  new HttpError(409, 'conflict', message);

export const tooLarge = (message = 'Payload too large.'): HttpError =>
  new HttpError(413, 'too_large', message);

export const validation = (message = 'Validation failed.'): HttpError =>
  new HttpError(422, 'validation', message);

/** Flatten a ZodError into a single human-readable message. */
export function zodMessage(error: ZodError): string {
  return error.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}
