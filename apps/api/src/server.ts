import express, { type Request, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentStatus } from '@nyx_meta/core';
import { createSystem, type NyxSystem } from './system.js';
import { ATTACKS, isAttackKind, runAttack } from './attacks.js';

export { createSystem, type NyxSystem } from './system.js';
export { ATTACKS, runAttack, type AttackKind, type AttackResult } from './attacks.js';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

export interface BuildAppOptions {
  /** How many task or attack runs one client may start per minute. */
  runLimitPerMinute?: number;
}

const RUN_WINDOW_MS = 60_000;

/**
 * A small in memory rate limit for the run endpoints. Running a task is the
 * one expensive thing a visitor can ask this server to do, so it gets a
 * simple, honest ceiling: past the limit the answer is a clear 429, never a
 * silent failure.
 */
function makeRunLimiter(limitPerMinute: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: () => void): void => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    const recent = (hits.get(key) ?? []).filter((t) => now - t < RUN_WINDOW_MS);
    if (recent.length >= limitPerMinute) {
      fail(res, 429, 'Too many runs in a short time. Wait a moment, then try again.');
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

/** Builds the owner API on top of a wired Nyx system. */
export function buildApp(system: NyxSystem, opts: BuildAppOptions = {}): express.Express {
  const { engine } = system;
  const app = express();
  const runLimiter = makeRunLimiter(opts.runLimitPerMinute ?? 30);
  app.use(express.json());
  app.use((err: unknown, _req: Request, res: Response, next: (err?: unknown) => void) => {
    const type = (err as { type?: string } | null)?.type;
    if (err instanceof SyntaxError || type === 'entity.parse.failed') {
      return fail(res, 400, 'The request body must be valid JSON.');
    }
    return next(err);
  });

  app.get('/api/overview', (_req: Request, res: Response) => {
    const agents = engine.listAgents();
    const receipts = engine.receipts.list();
    res.json({
      agents: {
        total: agents.length,
        active: agents.filter((a) => a.status === 'active').length,
        paused: agents.filter((a) => a.status === 'paused').length,
        revoked: agents.filter((a) => a.status === 'revoked').length,
      },
      settledTotalCents: engine.receipts.settledTotalCents(),
      settledCount: receipts.filter((r) => r.outcome === 'settled').length,
      blockedCount: receipts.filter((r) => r.outcome === 'blocked').length,
      executionFailedCount: receipts.filter((r) => r.outcome === 'execution_failed').length,
      pendingApprovals: engine.approvals.list('pending').length,
      spentTodayByAgent: agents.map((a) => ({
        agentId: a.id,
        spentTodayCents: engine.spentToday(a.id),
        dailyBudgetCents: engine.getPolicy(a.id)?.dailyBudgetCents ?? 0,
      })),
      vendors: [...system.merchants.values()].map((m) => ({
        id: m.info.id,
        name: m.info.name,
        description: m.info.description,
        approved: system.approvedVendorIds.includes(m.info.id),
        resources: m.info.resources,
      })),
    });
  });

  app.get('/api/model/status', (_req: Request, res: Response) => {
    res.json(system.modelInfo);
  });

  app.get('/api/agents', (_req: Request, res: Response) => {
    res.json(engine.listAgents());
  });

  app.post('/api/agents', (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isRecord(body) || typeof body.id !== 'string' || typeof body.name !== 'string') {
      return fail(res, 400, 'agent id and name are required');
    }
    const callers = Array.isArray(body.authorizedCallers)
      ? body.authorizedCallers.filter((c): c is string => typeof c === 'string')
      : ['runner'];
    const policyBody = isRecord(body.policy) ? body.policy : {};
    try {
      engine.registerAgent(
        { id: body.id, name: body.name, status: 'active', authorizedCallers: callers },
        {
          agentId: body.id,
          perPaymentCapCents:
            typeof policyBody.perPaymentCapCents === 'number' ? policyBody.perPaymentCapCents : 500,
          dailyBudgetCents:
            typeof policyBody.dailyBudgetCents === 'number' ? policyBody.dailyBudgetCents : 5000,
          approvedVendors: Array.isArray(policyBody.approvedVendors)
            ? policyBody.approvedVendors.filter((v): v is string => typeof v === 'string')
            : [...system.approvedVendorIds],
          version: 1,
        },
      );
    } catch (err) {
      return fail(res, 400, err instanceof Error ? err.message : String(err));
    }
    return res.status(201).json(engine.getAgent(body.id));
  });

  const statusRoute = (status: AgentStatus) => (req: Request, res: Response) => {
    try {
      return res.json(engine.setAgentStatus(req.params.id, status));
    } catch (err) {
      return fail(res, 404, err instanceof Error ? err.message : String(err));
    }
  };
  app.post('/api/agents/:id/pause', statusRoute('paused'));
  app.post('/api/agents/:id/resume', statusRoute('active'));
  app.post('/api/agents/:id/revoke', statusRoute('revoked'));

  app.get('/api/policies', (_req: Request, res: Response) => {
    res.json(engine.listPolicies());
  });

  app.get('/api/policies/:agentId', (req: Request, res: Response) => {
    const policy = engine.getPolicy(req.params.agentId);
    if (!policy) return fail(res, 404, 'policy not found');
    return res.json(policy);
  });

  app.put('/api/policies/:agentId', (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isRecord(body)) return fail(res, 400, 'policy patch is required');
    try {
      const policy = engine.updatePolicy(req.params.agentId, {
        perPaymentCapCents:
          typeof body.perPaymentCapCents === 'number' ? body.perPaymentCapCents : undefined,
        dailyBudgetCents:
          typeof body.dailyBudgetCents === 'number' ? body.dailyBudgetCents : undefined,
        approvedVendors: Array.isArray(body.approvedVendors)
          ? body.approvedVendors.filter((v): v is string => typeof v === 'string')
          : undefined,
      });
      return res.json(policy);
    } catch (err) {
      return fail(res, 404, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/payments', (_req: Request, res: Response) => {
    res.json(engine.receipts.list());
  });

  app.get('/api/blocked', (_req: Request, res: Response) => {
    res.json(engine.receipts.blockedAttempts());
  });

  app.get('/api/approvals', (req: Request, res: Response) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status === 'pending' || status === 'approved' || status === 'denied') {
      return res.json(engine.approvals.list(status));
    }
    return res.json(engine.approvals.list());
  });

  app.post('/api/approvals/:id/approve', async (req: Request, res: Response) => {
    try {
      const decision = await engine.approveApproval(req.params.id);
      return res.json({ decision, approval: engine.approvals.get(req.params.id) });
    } catch (err) {
      return fail(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/approvals/:id/deny', (req: Request, res: Response) => {
    const body: unknown = req.body;
    const reason =
      isRecord(body) && typeof body.reason === 'string' && body.reason.length > 0
        ? body.reason
        : 'No reason given.';
    try {
      return res.json(engine.denyApproval(req.params.id, reason));
    } catch (err) {
      return fail(res, 400, err instanceof Error ? err.message : String(err));
    }
  });

  app.post('/api/tasks/run', runLimiter, async (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isRecord(body) || typeof body.task !== 'string' || body.task.length === 0) {
      return fail(res, 400, 'a task text is required');
    }
    try {
      const result = await system.runner.runTask(body.task);
      return res.json(result);
    } catch (err) {
      return fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/attacks', (_req: Request, res: Response) => {
    res.json(ATTACKS);
  });

  app.post('/api/attacks/:kind/run', runLimiter, async (req: Request, res: Response) => {
    const kind = req.params.kind;
    if (!isAttackKind(kind)) {
      return fail(res, 404, `unknown attack: ${kind}`);
    }
    try {
      const result = await runAttack(system, kind);
      return res.json(result);
    } catch (err) {
      return fail(res, 500, err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/audit', (_req: Request, res: Response) => {
    res.setHeader('Content-Disposition', 'attachment; filename="nyx_audit.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      agents: engine.listAgents(),
      policies: engine.listPolicies(),
      receipts: engine.receipts.list(),
      approvals: engine.approvals.list(),
    });
  });

  app.use('/api', (_req: Request, res: Response) => {
    return fail(res, 404, 'That endpoint does not exist.');
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = process.env.NYX_WEB_DIR ?? path.join(here, '..', '..', 'web');
  app.use(express.static(webRoot));

  return app;
}

export function start(port: number = Number(process.env.PORT ?? 8390)): void {
  const app = buildApp(createSystem());
  app.listen(port, () => {
    console.log(`Nyx dashboard and API listening on http://localhost:${port}`);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) start();
