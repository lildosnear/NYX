import { dayKeyUtc } from './money.js';

/**
 * Budget ledger.
 *
 * Only settled payments count against the daily budget. Blocked attempts and
 * failed executions never consume budget. Used quote nonces are remembered
 * forever, so a quote can never be paid twice.
 *
 * Concurrency rule: the policy engine serializes decisions per agent, and
 * this ledger is only mutated inside that serialized section, so two
 * attempts racing the same budget can never both slip through.
 */
export class BudgetLedger {
  private readonly usedNonces = new Set<string>();
  private readonly settledByDay = new Map<string, number>();

  private nonceKey(vendorId: string, nonce: string): string {
    return `${vendorId}:${nonce}`;
  }

  private spendKey(agentId: string, nowMs: number): string {
    return `${agentId}:${dayKeyUtc(nowMs)}`;
  }

  hasNonce(vendorId: string, nonce: string): boolean {
    return this.usedNonces.has(this.nonceKey(vendorId, nonce));
  }

  /** Claim a nonce. Returns false when it was already claimed. */
  claimNonce(vendorId: string, nonce: string): boolean {
    const key = this.nonceKey(vendorId, nonce);
    if (this.usedNonces.has(key)) return false;
    this.usedNonces.add(key);
    return true;
  }

  spentToday(agentId: string, nowMs: number): number {
    return this.settledByDay.get(this.spendKey(agentId, nowMs)) ?? 0;
  }

  recordSettled(agentId: string, amountCents: number, nowMs: number): void {
    const key = this.spendKey(agentId, nowMs);
    this.settledByDay.set(key, (this.settledByDay.get(key) ?? 0) + amountCents);
  }
}
