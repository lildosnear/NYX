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
  const spend = o.spentTodayByAgent.map((s) =>
    '<div>' + s.agentId + ': ' + usd(s.spentTodayCents) + ' of ' + usd(s.dailyBudgetCents) + ' daily budget used</div>'
  ).join('');
  $('overviewCards').innerHTML += '<div class="card"><div class="lbl">Spent today</div>' + spend + '</div>';
  const ms = await api('/api/model/status').catch(() => null);
  if (ms) {
    let modelText = ms.mode === 'meta'
      ? 'Meta model live, ' + ms.model
      : 'Mock model, no API key set';
    if (ms.second && ms.second.configured) {
      modelText += '<br>Second model live, ' + ms.second.provider + ', ' + ms.second.model;
    }
    $('overviewCards').innerHTML += '<div class="card"><div class="lbl">Model mode</div><div>' + modelText + '</div></div>';
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

async function loadAgents() {
  const agents = await api('/api/agents');
  if (!agents.length) { $('agentList').innerHTML = '<p class="empty">No agents yet.</p>'; return; }
  $('agentList').innerHTML = '<table><tr><th>Agent</th><th>Status</th><th>Authorized callers</th><th>Actions</th></tr>' +
    agents.map((a) =>
      '<tr><td>' + a.name + '<br><span class="muted">' + a.id + '</span></td>' +
      '<td>' + a.status + '</td><td>' + a.authorizedCallers.join(', ') + '</td>' +
      '<td>' +
      '<button class="secondary" data-act="pause" data-id="' + a.id + '">Pause</button> ' +
      '<button class="secondary" data-act="resume" data-id="' + a.id + '">Resume</button> ' +
      '<button class="danger" data-act="revoke" data-id="' + a.id + '">Revoke</button>' +
      '</td></tr>'
    ).join('') + '</table>';
  $('agentList').querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api('/api/agents/' + btn.dataset.id + '/' + btn.dataset.act, { method: 'POST' });
      await refresh();
    });
  });
}

async function loadPolicies() {
  const policies = await api('/api/policies');
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

async function refresh() {
  await Promise.all([loadOverview(), loadAgents(), loadPolicies(), loadPayments(), loadApprovals()]);
}

document.querySelectorAll('.navbtn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.navbtn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    $('view-' + btn.dataset.view).classList.remove('hidden');
  });
});

$('taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('taskResult').innerHTML = '<p class="muted">Running...</p>';
  try {
    const result = await api('/api/tasks/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: $('taskInput').value }),
    });
    $('taskResult').innerHTML = '<p>' + result.summary + '</p>' + receiptTable(result.attempts.map((a) => ({
      createdAt: new Date().toISOString(),
      agentId: 'agent_research',
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
    await refresh();
  } catch (err) {
    $('agentFormMsg').textContent = err.message;
  }
});

refresh().catch((err) => console.error(err));
