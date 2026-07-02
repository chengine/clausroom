/**
 * Small route helpers: async handler wrapper (express 4 does not catch async
 * rejections) and zod body parsing that maps failures to 422 validation.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z, ZodTypeAny } from 'zod';
import { validation, zodMessage } from '../errors.js';

/** Wrap an async handler so rejections flow into the express error handler. */
export function h(
  fn: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** Parse an external input with a zod schema; failures -> 422 validation. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw validation(zodMessage(result.error));
  return result.data as z.output<S>;
}
