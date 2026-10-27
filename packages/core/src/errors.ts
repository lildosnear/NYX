import type { DecisionCode } from './types.js';

/** Typed Nyx failure. Denials surface with a code, never a bare string. */
export class NyxError extends Error {
  readonly code: DecisionCode;

  constructor(code: DecisionCode, reason: string) {
    super(`${code}: ${reason}`);
    this.name = 'NyxError';
    this.code = code;
  }
}
