import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp, createSystem } from '@nyx_meta/api';
import { createTestSystem, AGENT_ID, CALLER_ID } from './helpers.js';

/**
 * Agent lifecycle rules the dashboard buttons rely on: an id can only be
 * registered once, revoking is final, and policy amounts are whole cents,
 * zero or more. Before these guards, a duplicate registration silently
 * replaced an agent and a revoked agent could be resumed back to life.
 */
describe('agent lifecycle in the engine', () => {
  it('refuses to register the same agent id twice', () => {
    const sys = createTestSystem();
    expect(() =>
      sys.engine.registerAgent(
        { id: AGENT_ID, name: 'Impostor', status: 'active', authorizedCallers: [CALLER_ID] },
        {
          agentId: AGENT_ID,
          perPaymentCapCents: 500,
          dailyBudgetCents: 5000,
          approvedVendors: [...sys.approvedVendorIds],
          version: 1,
        },
      ),
    ).toThrow('already exists');
    expect(sys.engine.getAgent(AGENT_ID)?.name).toBe('Test Agent');
  });

  it('treats revoking as final', () => {
    const sys = createTestSystem();
    sys.engine.setAgentStatus(AGENT_ID, 'revoked');
    expect(() => sys.engine.setAgentStatus(AGENT_ID, 'active')).toThrow('revoking is final');
    expect(() => sys.engine.setAgentStatus(AGENT_ID, 'paused')).toThrow('revoking is final');
    expect(sys.engine.getAgent(AGENT_ID)?.status).toBe('revoked');
  });

  it('still allows pause and resume', () => {
    const sys = createTestSystem();
    sys.engine.setAgentStatus(AGENT_ID, 'paused');
    expect(sys.engine.setAgentStatus(AGENT_ID, 'active').status).toBe('active');
  });

  it('rejects negative and fractional policy amounts, accepts zero', () => {
    const sys = createTestSystem();
    expect(() => sys.engine.updatePolicy(AGENT_ID, { perPaymentCapCents: -1 })).toThrow('whole number of cents');
    expect(() => sys.engine.updatePolicy(AGENT_ID, { dailyBudgetCents: 12.5 })).toThrow('whole number of cents');
    const zeroed = sys.engine.updatePolicy(AGENT_ID, { perPaymentCapCents: 0 });
    expect(zeroed.perPaymentCapCents).toBe(0);
  });
});

describe('agent lifecycle over http', () => {
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

  const postJson = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('answers a duplicate registration with a 400, not a silent replacement', async () => {
    const first = await postJson('/api/agents', { id: 'agent_dup', name: 'First', authorizedCallers: ['runner'] });
    expect(first.status).toBe(201);
    const second = await postJson('/api/agents', { id: 'agent_dup', name: 'Second', authorizedCallers: ['runner'] });
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toContain('already exists');
    const agents = (await (await fetch(`${base}/api/agents`)).json()) as { id: string; name: string }[];
    expect(agents.find((a) => a.id === 'agent_dup')?.name).toBe('First');
  });

  it('refuses to resume a revoked agent, and 404s an unknown one', async () => {
    await postJson('/api/agents', { id: 'agent_gone', name: 'Gone', authorizedCallers: ['runner'] });
    await postJson('/api/agents/agent_gone/revoke');
    const res = await postJson('/api/agents/agent_gone/resume');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('revoking is final');
    const missing = await postJson('/api/agents/agent_nope/pause');
    expect(missing.status).toBe(404);
  });

  it('rejects a negative policy amount with a 400 and keeps 404 for unknown agents', async () => {
    const bad = await fetch(`${base}/api/policies/agent_research`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perPaymentCapCents: -500 }),
    });
    expect(bad.status).toBe(400);
    const missing = await fetch(`${base}/api/policies/agent_nope`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perPaymentCapCents: 100 }),
    });
    expect(missing.status).toBe(404);
  });
});
