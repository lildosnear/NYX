import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp, createSystem } from '@nyx_meta/api';
import { AgentRunner, MockModelAdapter } from '@nyx_meta/agent';
import { createTestSystem, AGENT_ID, CALLER_ID } from './helpers.js';

/**
 * Agent switching: a task can run for any registered agent, and the spend
 * lands on that agent's own budget. Without a choice, the default agent
 * runs, exactly as before. An unknown agent is refused in plain language.
 */
describe('agent switching in the runner', () => {
  it('runs the task for the chosen agent and spends from that agent budget', async () => {
    const sys = createTestSystem();
    sys.engine.registerAgent(
      { id: 'agent_two', name: 'Second Agent', status: 'active', authorizedCallers: [CALLER_ID] },
      {
        agentId: 'agent_two',
        perPaymentCapCents: 500,
        dailyBudgetCents: 5000,
        approvedVendors: [...sys.approvedVendorIds],
        version: 1,
      },
    );
    const runner = new AgentRunner(sys.engine, sys.merchants, new MockModelAdapter(), AGENT_ID, CALLER_ID);
    const result = await runner.runTask('research the market and write a brief', new Date(), 'agent_two');
    expect(result.agentId).toBe('agent_two');
    expect(result.settledTotalCents).toBe(720);
    expect(sys.engine.spentToday('agent_two')).toBe(720);
    expect(sys.engine.spentToday(AGENT_ID)).toBe(0);
  });

  it('keeps the default agent when none is chosen', async () => {
    const sys = createTestSystem();
    const runner = new AgentRunner(sys.engine, sys.merchants, new MockModelAdapter(), AGENT_ID, CALLER_ID);
    const result = await runner.runTask('research the market and write a brief');
    expect(result.agentId).toBe(AGENT_ID);
    expect(sys.engine.spentToday(AGENT_ID)).toBe(720);
  });
});

describe('agent switching over http', () => {
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

  const postJson = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('runs a task for a registered second agent and charges its budget', async () => {
    const reg = await postJson('/api/agents', {
      id: 'agent_field',
      name: 'Field Agent',
      authorizedCallers: ['runner'],
    });
    expect(reg.status).toBe(201);
    const res = await postJson('/api/tasks/run', {
      task: 'research the market and write a brief',
      agentId: 'agent_field',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string; settledTotalCents: number };
    expect(body.agentId).toBe('agent_field');
    expect(body.settledTotalCents).toBe(720);
    const overview = (await (await fetch(`${base}/api/overview`)).json()) as {
      spentTodayByAgent: { agentId: string; spentTodayCents: number }[];
    };
    const row = overview.spentTodayByAgent.find((s) => s.agentId === 'agent_field');
    expect(row?.spentTodayCents).toBe(720);
    const research = overview.spentTodayByAgent.find((s) => s.agentId === 'agent_research');
    expect(research?.spentTodayCents).toBe(0);
  });

  it('rejects an unknown agent with a plain message', async () => {
    const res = await postJson('/api/tasks/run', {
      task: 'research the market and write a brief',
      agentId: 'agent_ghost',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('does not exist');
  });

  it('runs the default agent when no agent is chosen', async () => {
    const res = await postJson('/api/tasks/run', { task: 'research the market and write a brief' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agentId: string };
    expect(body.agentId).toBe('agent_research');
  });
});
