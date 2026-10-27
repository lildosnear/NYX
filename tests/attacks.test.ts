import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { ATTACKS, buildApp, createSystem, runAttack } from '@nyx_meta/api';

/**
 * The attack lab scenarios, run against a real wired system. Each attack
 * must end where the dashboard says it ends: owner rule breaks wait in the
 * approvals queue, hard blocks land in Blocked attempts, and no attack ever
 * settles or moves the settled total.
 */
describe('attack lab', () => {
  it('lists six attacks with unique kinds', () => {
    expect(ATTACKS).toHaveLength(6);
    expect(new Set(ATTACKS.map((a) => a.kind)).size).toBe(6);
    for (const attack of ATTACKS) {
      expect(attack.title.length).toBeGreaterThan(0);
      expect(attack.story.length).toBeGreaterThan(0);
      expect(attack.expected.length).toBeGreaterThan(0);
    }
  });

  it('holds an over cap purchase for the owner', async () => {
    const system = createSystem();
    const result = await runAttack(system, 'over_cap');
    expect(result.decision.outcome).toBe('approval_required');
    expect(result.decision.code).toBe('CAP_EXCEEDED');
    expect(result.landedIn).toBe('approvals');
    expect(system.engine.approvals.list('pending')).toHaveLength(1);
    expect(system.engine.receipts.settledTotalCents()).toBe(0);
  });

  it('holds an unapproved vendor purchase for the owner', async () => {
    const system = createSystem();
    const result = await runAttack(system, 'unapproved_vendor');
    expect(result.decision.outcome).toBe('approval_required');
    expect(result.decision.code).toBe('VENDOR_NOT_APPROVED');
    expect(result.landedIn).toBe('approvals');
    expect(system.engine.receipts.settledTotalCents()).toBe(0);
  });

  it('holds the prompt injection purchase for the owner', async () => {
    const system = createSystem();
    const result = await runAttack(system, 'prompt_injection');
    expect(result.decision.outcome).toBe('approval_required');
    expect(result.decision.code).toBe('VENDOR_NOT_APPROVED');
    expect(result.landedIn).toBe('approvals');
    expect(system.engine.receipts.settledTotalCents()).toBe(0);
  });

  it('blocks a replayed quote after the honest first use settles', async () => {
    const system = createSystem();
    const result = await runAttack(system, 'replayed_quote');
    expect(result.setupDecision?.outcome).toBe('settled');
    expect(result.decision.outcome).toBe('blocked');
    expect(result.decision.code).toBe('QUOTE_REPLAYED');
    expect(result.landedIn).toBe('blocked');
    const blocked = system.engine.receipts.blockedAttempts();
    expect(blocked.some((r) => r.code === 'QUOTE_REPLAYED')).toBe(true);
    // Only the honest first use settled, exactly once.
    expect(system.engine.receipts.settledTotalCents()).toBe(120);
  });

  it('blocks an expired quote', async () => {
    const system = createSystem();
    const result = await runAttack(system, 'expired_quote');
    expect(result.decision.outcome).toBe('blocked');
    expect(result.decision.code).toBe('QUOTE_EXPIRED');
    expect(result.landedIn).toBe('blocked');
    expect(system.engine.receipts.settledTotalCents()).toBe(0);
  });

  it('blocks an unauthorized caller', async () => {
    const system = createSystem();
    const result = await runAttack(system, 'unauthorized_caller');
    expect(result.decision.outcome).toBe('blocked');
    expect(result.decision.code).toBe('CALLER_NOT_AUTHORIZED');
    expect(result.landedIn).toBe('blocked');
    expect(system.engine.receipts.settledTotalCents()).toBe(0);
  });
});

describe('attack lab routes', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = buildApp(createSystem());
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the attack list', async () => {
    const res = await fetch(`${base}/api/attacks`);
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ kind: string }>;
    expect(list).toHaveLength(6);
    expect(list.map((a) => a.kind)).toContain('expired_quote');
  });

  it('runs an attack over HTTP and reports where it landed', async () => {
    const res = await fetch(`${base}/api/attacks/expired_quote/run`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      decision: { outcome: string; code: string };
      landedIn: string;
    };
    expect(body.decision.outcome).toBe('blocked');
    expect(body.decision.code).toBe('QUOTE_EXPIRED');
    expect(body.landedIn).toBe('blocked');
  });

  it('rejects an unknown attack kind with a clear error', async () => {
    const res = await fetch(`${base}/api/attacks/not_a_real_attack/run`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('unknown attack');
  });
});
