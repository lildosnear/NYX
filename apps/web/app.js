const $ = (id) => document.getElementById(id);
const usd = (cents) => '$' + (cents / 100).toFixed(2);

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function outcomeCell(r) {
  if (r.outcome === 'settled') return '<span class="ok">settled</span>';
  if (r.outcome === 'execution_failed') return '<span class="warn">execution failed</span>';
  return '<span class="bad">blocked</span>';
}

function receiptTable(rows) {
  if (!rows.length) return '<p class="empty">Nothing here yet.</p>';
  const body = rows.map((r) =>
    '<tr><td>' + r.createdAt.slice(0, 19).replace('T', ' ') + '</td>' +
    '<td>' + r.agentId + '</td><td>' + r.vendorId + '</td><td>' + r.resource + '</td>' +
    '<td>' + usd(r.amountCents) + '</td><td>' + outcomeCell(r) + '</td>' +
    '<td>' + r.code + '<br><span class="muted">' + r.reason + '</span></td></tr>'
  ).join('');
  return '<table><tr><th>When</th><th>Agent</th><th>Vendor</th><th>Resource</th><th>Amount</th><th>Outcome</th><th>Detail</th></tr>' + body + '</table>';
}

async function loadOverview() {
  const o = await api('/api/overview');
  const cards = [
    [o.settledCount, 'payments settled'],
    [usd(o.settledTotalCents), 'total settled'],
    [o.blockedCount, 'attempts blocked'],
    [o.executionFailedCount, 'executions failed'],
    [o.pendingApprovals, 'approvals waiting'],
    [o.agents.active + ' / ' + o.agents.total, 'agents active'],
  ];
  $('overviewCards').innerHTML = cards.map((c) =>
    '<div class="card"><div class="num">' + c[0] + '</div><div class="lbl">' + c[1] + '</div></div>'
  ).join('');
  $('approvalBadge').textContent = o.pendingApprovals;
  $('approvalBadge').classList.toggle('hidden', o.pendingApprovals === 0);
  const spendRows = o.spentTodayByAgent.map((s) => {
    const pct = s.dailyBudgetCents > 0 ? Math.min(100, Math.round((s.spentTodayCents / s.dailyBudgetCents) * 100)) : 0;
    const cls = pct >= 100 ? 'bar-fill max' : pct >= 80 ? 'bar-fill hot' : 'bar-fill';
    return '<div class="limit-row"><div class="limit-top"><span>' + s.agentId + '</span>' +
      '<span class="muted">' + usd(s.spentTodayCents) + ' of ' + usd(s.dailyBudgetCents) + ' today</span></div>' +
      '<div class="bar"><div class="' + cls + '" style="width:' + pct + '%"></div></div></div>';
  }).join('');
  $('spendLimits').innerHTML = spendRows || '<p class="empty">No agents yet.</p>';
  const overBudget = o.spentTodayByAgent.some((s) => s.dailyBudgetCents > 0 && s.spentTodayCents >= s.dailyBudgetCents);
  $('limitState').textContent = overBudget ? 'Budget reached' : 'Within budget';
  $('limitState').className = 'pill ' + (overBudget ? 'red' : 'green');
  const pols = await api('/api/policies').catch(() => []);
  if (pols.length) {
    $('capLine').textContent = 'Per payment cap ' + usd(pols[0].perPaymentCapCents) + ' for ' + pols[0].agentId + '. The daily budget is never waived, not even by an approval.';
  }
  const ms = await api('/api/model/status').catch(() => null);
  if (ms) {
    let modelText = ms.mode === 'meta'
      ? 'Meta model live<br>' + ms.model
      : 'Mock model<br>No API key set';
    if (ms.second && ms.second.configured) {
      modelText += '<br>Second model live<br>' + ms.second.provider + ', ' + ms.second.model;
    }
    $('sideModel').innerHTML = modelText;
    $('modelDot').className = 'dot ' + (ms.mode === 'meta' ? 'ok-dot' : 'warn-dot');
  }
  $('vendorList').innerHTML = '<table><tr><th>Vendor</th><th>What it sells</th><th>Resources</th><th>Status</th></tr>' +
    o.vendors.map((v) =>
      '<tr><td>' + v.name + '<br><span class="muted">' + v.id + '</span></td><td>' + v.description + '</td>' +
      '<td>' + v.resources.map((r) => r.label + ' ' + usd(r.priceCents)).join('<br>') + '</td>' +
      '<td>' + (v.approved ? '<span class="ok">approved</span>' : '<span class="bad">not approved</span>') + '</td></tr>'
    ).join('') + '</table>';
  const payments = await api('/api/payments');
  $('recentPayments').innerHTML = receiptTable(payments.slice(-6).reverse());
}

function agentActions(a) {
  if (a.status === 'active') {
    return '<button class="secondary" data-act="pause" data-id="' + a.id + '">Pause</button> ' +
      '<button class="danger" data-act="revoke" data-id="' + a.id + '">Revoke</button>';
  }
  if (a.status === 'paused') {
    return '<button class="secondary" data-act="resume" data-id="' + a.id + '">Resume</button> ' +
      '<button class="danger" data-act="revoke" data-id="' + a.id + '">Revoke</button>';
  }
  return '<span class="muted">revoke is final</span>';
}

async function loadAgents() {
  const agents = await api('/api/agents');
  if (!agents.length) { $('agentList').innerHTML = '<p class="empty">No agents yet.</p>'; return; }
  $('agentList').innerHTML = '<table><tr><th>Agent</th><th>Status</th><th>Authorized callers</th><th>Actions</th></tr>' +
    agents.map((a) =>
      '<tr><td>' + a.name + '<br><span class="muted">' + a.id + '</span></td>' +
      '<td><span class="' + (a.status === 'active' ? 'ok' : a.status === 'paused' ? 'warn' : 'bad') + '">' + a.status + '</span></td>' +
      '<td>' + a.authorizedCallers.join(', ') + '</td>' +
      '<td>' + agentActions(a) + '</td></tr>'
    ).join('') + '</table>';
  $('agentList').querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const updated = await api('/api/agents/' + btn.dataset.id + '/' + btn.dataset.act, { method: 'POST' });
        $('agentActionMsg').textContent = updated.id + ' is now ' + updated.status + '.';
      } catch (err) {
        $('agentActionMsg').textContent = err.message;
      }
      await refresh();
    });
  });
}

async function loadPolicies() {
  const policies = await api('/api/policies');
  if (!policies.length) { $('policyList').innerHTML = '<p class="empty">No policies yet. Register an agent first, and its policy will appear here.</p>'; return; }
  const vendors = ['vendor_data_api', 'vendor_research_api', 'vendor_design_tool', 'vendor_shadow_leads'];
  $('policyList').innerHTML = policies.map((p) =>
    '<div class="risk" style="margin-bottom:12px"><strong>' + p.agentId + '</strong> (version ' + p.version + ')<br>' +
    '<label>Per payment cap, cents <input type="number" id="cap-' + p.agentId + '" value="' + p.perPaymentCapCents + '"></label> ' +
    '<label>Daily budget, cents <input type="number" id="budget-' + p.agentId + '" value="' + p.dailyBudgetCents + '"></label><br>' +
    vendors.map((v) =>
      '<label style="display:inline-block;margin-right:12px"><input type="checkbox" class="vendorbox" data-agent="' + p.agentId + '" value="' + v + '"' +
      (p.approvedVendors.includes(v) ? ' checked' : '') + '> ' + v + '</label>'
    ).join('') +
    '<br><button data-save="' + p.agentId + '">Save policy</button> <span class="muted" id="msg-' + p.agentId + '"></span></div>'
  ).join('');
  $('policyList').querySelectorAll('button[data-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.save;
      const approvedVendors = [...document.querySelectorAll('.vendorbox[data-agent="' + id + '"]:checked')].map((b) => b.value);
      const saved = await api('/api/policies/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          perPaymentCapCents: Number($('cap-' + id).value),
          dailyBudgetCents: Number($('budget-' + id).value),
          approvedVendors,
        }),
      });
      $('msg-' + id).textContent = 'Saved as version ' + saved.version + '.';
      await loadOverview();
    });
  });
}

async function loadPayments() {
  const payments = await api('/api/payments');
  $('paymentList').innerHTML = receiptTable([...payments].reverse());
  const blocked = await api('/api/blocked');
  $('blockedList').innerHTML = receiptTable([...blocked].reverse());
}

async function loadApprovals() {
  const approvals = await api('/api/approvals');
  if (!approvals.length) { $('approvalList').innerHTML = '<p class="empty">No approvals yet.</p>'; return; }
  $('approvalList').innerHTML = [...approvals].reverse().map((a) =>
    '<div class="risk" style="margin-bottom:12px">' +
    '<strong>' + usd(a.request.quote.amountCents) + '</strong> to ' + a.request.quote.vendorId +
    ' for ' + a.request.quote.resource + ' by ' + a.request.agentId +
    ' &nbsp; <span class="' + (a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'ok' : 'bad') + '">' + a.status + '</span><br>' +
    '<span class="muted">' + a.code + ': ' + a.reason + '</span>' +
    '<p>' + a.riskExplanation + '</p>' +
    (a.status === 'pending'
      ? '<button data-approve="' + a.approvalId + '">Approve this one payment</button> ' +
        '<button class="danger" data-deny="' + a.approvalId + '">Deny</button>'
      : (a.denyReason ? '<p class="muted">Deny reason: ' + a.denyReason + '</p>' : '')) +
    '</div>'
  ).join('');
  $('approvalList').querySelectorAll('button[data-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api('/api/approvals/' + btn.dataset.approve + '/approve', { method: 'POST' });
      await refresh();
    });
  });
  $('approvalList').querySelectorAll('button[data-deny]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const reason = window.prompt('Why are you denying this payment?', 'Not needed.');
      if (reason === null) return;
      await api('/api/approvals/' + btn.dataset.deny + '/deny', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      await refresh();
    });
  });
}

function decisionLabel(outcome) {
  if (outcome === 'settled') return '<span class="ok">settled</span>';
  if (outcome === 'approval_required') return '<span class="warn">held for the owner</span>';
  if (outcome === 'execution_failed') return '<span class="warn">execution failed</span>';
  return '<span class="bad">blocked</span>';
}

async function loadAttacks() {
  const attacks = await api('/api/attacks');
  $('attackList').innerHTML = attacks.map((a) =>
    '<div class="risk" style="margin-bottom:12px">' +
    '<strong>' + a.title + '</strong><br>' +
    '<span>' + a.story + '</span><br>' +
    '<span class="muted">What should happen: ' + a.expected + '</span><br>' +
    '<button data-run="' + a.kind + '">Run this attack</button> ' +
    '<span class="muted" id="attack-status-' + a.kind + '"></span>' +
    '<div id="attack-result-' + a.kind + '" style="margin-top:8px"></div>' +
    '</div>'
  ).join('');
  $('attackList').querySelectorAll('button[data-run]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.run;
      btn.disabled = true;
      $('attack-status-' + kind).textContent = 'Running...';
      try {
        const result = await api('/api/attacks/' + kind + '/run', { method: 'POST' });
        let html = '';
        if (result.setupDecision) {
          html += '<p style="margin:4px 0">First, the honest step: ' + decisionLabel(result.setupDecision.outcome) +
            ' <span class="muted">(' + result.setupDecision.code + ': ' + result.setupDecision.reason + ')</span></p>';
        }
        html += '<p style="margin:4px 0">The attack itself: ' + decisionLabel(result.decision.outcome) +
          ' <span class="muted">(' + result.decision.code + ': ' + result.decision.reason + ')</span></p>' +
          '<p style="margin:4px 0"><strong>' + result.landedText + '</strong></p>';
        const gotoView = result.landedIn === 'approvals' ? 'approvals' : 'payments';
        const gotoLabel = result.landedIn === 'approvals' ? 'See it in Approvals'
          : result.landedIn === 'blocked' ? 'See it in Blocked attempts' : 'See it in Payments';
        html += '<p style="margin:6px 0"><button class="secondary" data-goto="' + gotoView + '">' + gotoLabel + '</button></p>';
        $('attack-result-' + kind).innerHTML = html;
        $('attack-status-' + kind).textContent = '';
        await refresh();
      } catch (err) {
        $('attack-status-' + kind).textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function loadAgentOptions() {
  const agents = await api('/api/agents');
  const sel = $('taskAgent');
  const current = sel.value;
  sel.innerHTML = agents.map((a) =>
    '<option value="' + a.id + '">' + a.name + ' (' + a.id + ') · ' + a.status + '</option>'
  ).join('');
  if (agents.some((a) => a.id === current)) sel.value = current;
}

async function refresh() {
  await Promise.all([loadOverview(), loadAgents(), loadPolicies(), loadPayments(), loadApprovals(), loadAgentOptions()]);
}

const TITLES = {
  overview: ['Overview', 'Every payment your agents tried to make, and what Nyx did with it.'],
  agents: ['Agents', 'The agents that can spend, and the callers allowed to direct them.'],
  policies: ['Spending policies', 'The rules the policy engine enforces on every payment.'],
  payments: ['Payments', 'Receipts for everything that settled, failed, or was blocked.'],
  approvals: ['Approvals', 'Payments outside the rules wait here. No money moves until you decide.'],
  attacks: ['Attack Lab', 'Real attacks against the live system. Watch where each one lands.'],
};

document.querySelectorAll('.navbtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.navbtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('view-' + btn.dataset.view).classList.remove('hidden');
    const t = TITLES[btn.dataset.view];
    if (t) { $('pageTitle').textContent = t[0]; $('pageSub').textContent = t[1]; }
  });
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-goto]');
  if (!btn) return;
  const nav = document.querySelector('.navbtn[data-view="' + btn.dataset.goto + '"]');
  if (nav) nav.click();
});

$('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('taskResult').innerHTML = '<p class="muted">Running...</p>';
  try {
    const result = await api('/api/tasks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: $('taskInput').value, agentId: $('taskAgent').value }),
    });
    $('taskResult').innerHTML = '<p>' + result.summary + '</p>' + receiptTable(result.attempts.map((a) => ({
      createdAt: new Date().toISOString(),
      agentId: result.agentId || $('taskAgent').value,
      vendorId: a.vendorId,
      resource: a.resource,
      amountCents: a.amountCents,
      outcome: a.decision.outcome === 'approval_required' ? 'blocked' : a.decision.outcome,
      code: a.decision.code,
      reason: a.decision.reason,
    })));
    await refresh();
  } catch (err) {
    $('taskResult').innerHTML = '<p class="bad">' + err.message + '</p>';
  }
});

$('agentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: $('agentId').value.trim(),
        name: $('agentName').value.trim(),
        authorizedCallers: $('agentCallers').value.split(',').map((s) => s.trim()).filter(Boolean),
      }),
    });
    $('agentFormMsg').textContent = 'Agent registered.';
    $('agentId').value = '';
    $('agentName').value = '';
    await refresh();
  } catch (err) {
    $('agentFormMsg').textContent = err.message;
  }
});

refresh().catch((err) => console.error(err));
loadAttacks().catch((err) => console.error(err));
