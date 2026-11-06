import type { ErrorCode } from '../core/types';

export class DistillError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DistillError';
  }
}
