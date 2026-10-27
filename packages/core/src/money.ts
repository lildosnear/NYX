/** Format integer cents as a dollar string, for example 240 becomes $2.40. */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars}.${rest}`;
}

/** Money must be a positive whole number of cents. */
export function assertAmountCents(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive whole number of cents, got ${value}`);
  }
}

/** UTC day bucket, YYYY MM DD with dots avoided; ISO date slice is stable. */
export function dayKeyUtc(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
