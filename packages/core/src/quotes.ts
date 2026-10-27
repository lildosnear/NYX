import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Quote } from './types.js';
import { assertAmountCents } from './money.js';

/**
 * Signed, expiring, single use price quotes.
 *
 * Quotes are authenticated with HMAC SHA256 under a per vendor secret, so a
 * quote cannot be edited in transit: changing the amount, the vendor, the
 * resource or the expiry breaks the signature. The policy engine only ever
 * verifies through this class, so the signing scheme can be replaced later
 * without touching the engine.
 */

type UnsignedQuote = Omit<Quote, 'signature'>;

function canonicalQuotePayload(quote: UnsignedQuote): string {
  return [
    `quoteId=${quote.quoteId}`,
    `vendorId=${quote.vendorId}`,
    `resource=${quote.resource}`,
    `amountCents=${quote.amountCents}`,
    `currency=${quote.currency}`,
    `issuedAt=${quote.issuedAt}`,
    `expiresAt=${quote.expiresAt}`,
    `nonce=${quote.nonce}`,
  ].join('|');
}

export class QuoteSigner {
  constructor(private readonly secret: string) {
    if (secret.length < 8) throw new Error('quote signing secret is too short');
  }

  sign(unsigned: UnsignedQuote): string {
    return createHmac('sha256', this.secret).update(canonicalQuotePayload(unsigned)).digest('hex');
  }

  issue(input: {
    vendorId: string;
    resource: string;
    amountCents: number;
    ttlMs?: number;
    now?: Date;
  }): Quote {
    assertAmountCents(input.amountCents, 'quote amount');
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? 5 * 60 * 1000;
    const unsigned: UnsignedQuote = {
      quoteId: `q_${randomBytes(10).toString('hex')}`,
      vendorId: input.vendorId,
      resource: input.resource,
      amountCents: input.amountCents,
      currency: 'USD',
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      nonce: randomBytes(12).toString('hex'),
    };
    return { ...unsigned, signature: this.sign(unsigned) };
  }

  /** Constant time comparison so a forged signature cannot be probed. */
  verify(quote: Quote): boolean {
    const { signature, ...unsigned } = quote;
    const expected = this.sign(unsigned);
    const a = Buffer.from(signature, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
