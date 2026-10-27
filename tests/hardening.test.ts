import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp, createSystem } from '@nyx_meta/api';

/**
 * Hardening checks at the HTTP edge: the run endpoints carry a rate limit,
 * malformed JSON gets a plain language 400, and an unknown api route gets a
 * JSON 404 instead of a web framework error page.
 */
describe('api hardening', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    const app = buildApp(createSystem(), { runLimitPerMinute: 3 });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rate limits the run endpoints with a clear 429', async () => {
    for (let i = 0; i < 3; i += 1) {
      const res = await fetch(`${base}/api/attacks/expired_quote/run`, { method: 'POST' });
      expect(res.status).toBe(200);
    }
    const fourth = await fetch(`${base}/api/attacks/expired_quote/run`, { method: 'POST' });
    expect(fourth.status).toBe(429);
    const body = (await fourth.json()) as { error: string };
    expect(body.error).toContain('Wait a moment');
  });

  it('answers malformed JSON with a plain language 400', async () => {
    const res = await fetch(`${base}/api/tasks/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{this is not json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('valid JSON');
  });

  it('answers an unknown api route with a JSON 404', async () => {
    const res = await fetch(`${base}/api/does_not_exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('does not exist');
  });
});
