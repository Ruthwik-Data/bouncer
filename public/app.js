// Bouncer dashboard. Plain DOM, no innerHTML with data: every server string goes through textContent.
const $ = (id) => document.getElementById(id);
const ICON = {
  check: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>',
  x: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>',
  clock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l2.5 2"/></svg>',
  hand: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M5 15L15 5"/></svg>',
  shield: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M10 2.5l6 2.2v4.6c0 3.9-2.6 6.8-6 8.2-3.4-1.4-6-4.3-6-8.2V4.7l6-2.2z"/><path d="M7.3 10l1.9 1.9 3.6-3.8" stroke-linecap="round"/></svg>',
  alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3l7.5 13h-15L10 3z"/><path d="M10 8.5v3.2M10 14.2v.1"/></svg>',
  pause: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M8.2 7.5v5M11.8 7.5v5"/></svg>',
  arrow: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h11M11 6l4 4-4 4"/></svg>',
};

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'icon') el.insertAdjacentHTML('afterbegin', ICON[v]); // constant markup only
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

const STATUS = {
  received: ['t-dim', 'Evaluating', 'clock'],
  pending: ['t-hold', 'Waiting for you', 'pause'],
  allowed: ['t-info', 'Releasing', 'arrow'],
  approved: ['t-info', 'Releasing', 'arrow'],
  released: ['t-ok', 'Sent to Fo', 'arrow'],
  completed: ['t-ok', 'Fo-reported done', 'check'],
  denied: ['t-stop', 'Denied by policy', 'hand'],
  rejected: ['t-stop', 'Rejected', 'x'],
  expired: ['t-dim', 'Expired', 'clock'],
  failed: ['t-fail', 'Failed', 'alert'],
};
function statusOf(r) {
  if (r.status === 'completed' && r.result?.foStatus === 'working') return ['t-ok', 'Fo still working', 'clock'];
  if (r.status === 'completed' && !r.result?.foStatus) return ['t-ok', 'Returned', 'check'];
  return STATUS[r.status] ?? ['t-dim', r.status, 'clock'];
}
const pill = (r) => { const [tone, text, icon] = statusOf(r); return h('span', { class: `pill ${tone}`, icon }, text); };

const FILTERS = [
  ['protected', 'Fo calls gated', null, () => true],
  ['pending', 'Waiting', 't-hold', (r) => r.status === 'pending'],
  ['approved', 'Approved', 't-ok', (r) => r.decision?.decision === 'approved'],
  ['autoAllowed', 'Auto-allowed', 't-info', (r) => r.policy?.effect === 'allow'],
  ['blocked', 'Blocked', 't-stop', (r) => ['denied', 'rejected', 'expired'].includes(r.status)],
  ['failed', 'Failed', 't-fail', (r) => r.status === 'failed'],
];

const state = { data: null, offset: 0, filter: null, open: new Set(), busy: new Set(), errors: new Map() };
const short = (s, n = 10) => (s ? `${s.slice(0, n)}…` : '');
const toolLabel = (t) => ({ mcp__fo__ask_fo: 'Message to Fo', mcp__fo__start_fo_call: 'Voice call', mcp__fo__list_fo_conversations: 'List conversations', mcp__fo__get_fo_conversation: 'Read conversation', mcp__fo__get_fo_reply: 'Check reply' }[t] ?? t.replace('mcp__fo__', ''));
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
function when(ts) {
  const d = new Date(ts);
  return new Date().toDateString() === d.toDateString() ? timeFmt.format(d) : `${dayFmt.format(d)}, ${timeFmt.format(d)}`;
}

function toast(text) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(state.data ? { 'x-csrf-token': state.data.csrf } : {}), ...opts.headers } });
  if (res.status === 401) { showUnpaired(); throw new Error('not paired'); }
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function showUnpaired() {
  $('loading').hidden = true; $('dash').hidden = true; $('bar-meta').hidden = true; $('unpaired').hidden = false;
  state.data = null;
}

let loadTimer = null;
async function load() {
  clearTimeout(loadTimer);
  try {
    const { ok, json } = await api('/api/state');
    if (!ok) throw new Error(json.error || 'state failed');
    state.data = json;
    state.offset = Date.parse(json.serverTime) - Date.now();
    render();
  } catch (e) {
    if (e.message !== 'not paired') loadTimer = setTimeout(load, 2000);
  }
}

// ---------------- render ----------------
function render() {
  const d = state.data;
  $('loading').hidden = true; $('unpaired').hidden = true; $('dash').hidden = false; $('bar-meta').hidden = false;
  renderChain(d.chain);
  renderLedger(d.stats);
  renderQueue(d.requests.filter((r) => r.status === 'pending').reverse());
  renderFeed(d.requests);
}

function renderChain(c) {
  const b = $('chain');
  b.dataset.ok = String(c.ok);
  b.replaceChildren();
  b.insertAdjacentHTML('afterbegin', c.ok ? ICON.shield : ICON.alert);
  b.append(h('span', { class: 'chain-text' }, c.ok ? `Audit chain intact · ${c.count}` : `Audit chain broken at line ${c.line}`));
  b.title = c.ok ? `Every audit entry hashes the one before it. ${c.count} entries, head ${c.head}` : c.reason;
  b.setAttribute('aria-label', b.title);
}

function renderLedger(stats) {
  $('ledger').replaceChildren(...FILTERS.map(([key, label, tone]) => {
    const n = stats[key];
    const active = state.filter === key;
    return h('button', { type: 'button', class: tone || '', 'aria-pressed': String(active), onclick: () => { state.filter = active || key === 'protected' ? null : key; render(); } },
      h('span', { class: `n${n ? '' : ' zero'}` }, n), h('span', { class: 'l' }, label));
  }));
  $('clear-filter').hidden = !state.filter;
}

function recipientsOf(r) { return r.policy?.facts?.recipients ?? []; }

function renderQueue(pending) {
  const q = $('queue');
  $('queue-count').textContent = pending.length ? `${pending.length} pending` : '';
  document.title = pending.length ? `(${pending.length}) Bouncer` : 'Bouncer';
  if (!pending.length) {
    q.replaceChildren(h('div', { class: 'empty', icon: 'check' }, h('div', {}, h('b', {}, 'Nothing is waiting'),
      h('p', {}, 'When the agent asks Fo to do something that needs you, it appears here within a second, with exactly what Fo will receive.'))));
    return;
  }
  const existing = new Map([...q.querySelectorAll('.card')].map((c) => [c.dataset.id, c]));
  const next = pending.map((r) => existing.get(r.id) ?? card(r));
  for (const [id, el] of existing) if (!pending.some((r) => r.id === id)) el.remove();
  q.replaceChildren(...next);
  for (const r of pending) updateCard(r);
  tick();
}

function card(r) {
  const self = state.data.policy.self.map((s) => s.toLowerCase());
  const rec = recipientsOf(r);
  return h('article', { class: 'card', 'data-id': r.id, 'aria-label': `Pending: ${toolLabel(r.toolName)}` },
    h('div', { class: 'timer' }, h('i')),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-top' }, h('span', { class: 'pill t-hold', icon: 'pause' }, 'Needs your approval'), h('span', { class: 'left', 'data-left': '' }, '')),
      rec.length ? [h('p', { class: 'label' }, 'Reaches'), h('div', { class: 'to' }, rec.map((e) => h('span', { class: `chip${self.includes(e) ? ' self' : ''}` }, self.includes(e) ? `${e} (you)` : e)))] : null,
      h('p', { class: 'label' }, r.toolInput?.conversationId ? 'Fo will receive this reply, word for word' : 'Fo will receive exactly this'),
      h('div', { class: 'message' }, r.toolInput?.message ?? JSON.stringify(r.toolInput, null, 2)),
      h('div', { class: 'why', icon: 'pause' }, h('div', {}, h('b', {}, r.policy.rule), h('span', {}, r.policy.reason))),
      h('div', { class: 'meta' }, h('span', {}, toolLabel(r.toolName)), h('span', {}, `Received ${when(r.createdAt)}`),
        h('span', { class: 'mono', title: r.hash }, `sha256 ${short(r.hash, 12)}`), h('span', { class: 'mono' }, r.id))),
    h('p', { class: 'card-error', role: 'alert', hidden: true }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-reject', type: 'button', icon: 'x', onclick: () => decide(r, 'reject') }, 'Reject'),
      h('button', { class: 'btn btn-approve', type: 'button', icon: 'check', onclick: () => decide(r, 'approve') }, 'Approve')));
}

function updateCard(r) {
  const el = $('queue').querySelector(`.card[data-id="${r.id}"]`);
  if (!el) return;
  const busy = state.busy.has(r.id);
  el.querySelectorAll('.btn').forEach((b) => { b.disabled = busy; });
  const err = el.querySelector('.card-error');
  const msg = state.errors.get(r.id);
  err.hidden = !msg; err.textContent = msg ?? '';
}

function tick() {
  if (!state.data) return;
  const now = Date.now() + state.offset;
  const total = state.data.policy.holdTimeoutSeconds * 1000;
  for (const el of document.querySelectorAll('.card')) {
    const r = state.data.requests.find((x) => x.id === el.dataset.id);
    if (!r?.expiresAt) continue;
    const left = Math.max(0, Date.parse(r.expiresAt) - now);
    const s = Math.ceil(left / 1000);
    el.querySelector('[data-left]').textContent = left ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left` : 'Expiring…';
    el.querySelector('.timer > i').style.transform = `scaleX(${left / total})`;
    el.dataset.urgent = String(left < 30000);
    if (!left) load();
  }
}
setInterval(tick, 1000);

async function decide(r, decision) {
  state.busy.add(r.id); state.errors.delete(r.id); updateCard(r);
  try {
    const { ok, json } = await api(`/api/requests/${r.id}/decision`, { method: 'POST', body: JSON.stringify({ decision, hash: r.hash }) });
    if (!ok) { state.errors.set(r.id, `Not recorded: ${json.reason || json.error}.`); return; }
    const el = $('queue').querySelector(`.card[data-id="${r.id}"]`);
    if (el) { el.classList.add('leaving'); await new Promise((res) => setTimeout(res, 300)); }
    toast(decision === 'approve' ? 'Approved. Bouncer is releasing it to Fo.' : 'Rejected. It will never reach Fo.');
  } catch (e) {
    if (e.message !== 'not paired') state.errors.set(r.id, 'Couldn’t reach Bouncer. Nothing was recorded, so try again.');
  } finally {
    state.busy.delete(r.id);
    await load();
    updateCard(r);
  }
}

// ---------------- activity feed ----------------
const EVENT = {
  'request.received': ['t-dim', () => 'Agent called Fo. Bouncer intercepted it before dispatch'],
  'policy.decided': [(d) => ({ allow: 't-info', deny: 't-stop', hold: 't-hold' }[d.effect]), (d) => `Policy: ${{ allow: 'allow', deny: 'deny', hold: 'hold for a human' }[d.effect]} (${d.rule})`],
  'approval.decided': [(d) => (d.decision === 'approved' ? 't-ok' : 't-stop'), (d) => `${d.decision === 'approved' ? 'Approved' : 'Rejected'} on ${d.by}`],
  'approval.refused': ['t-dim', (d) => `A ${d.attempted} attempt was refused: ${d.reason}`],
  'release.granted': ['t-ok', (d) => `Released to Fo (${d.via}), exactly once`],
  'release.refused': ['t-stop', (d) => `Release refused: ${d.reason}`],
  'request.expired': ['t-dim', (d) => d.reason],
  'result.recorded': [(d) => (d.ok ? 't-ok' : 't-fail'), (d) => (d.ok ? `Fo-reported status: ${d.foStatus ?? 'unknown'}` : `Failed${d.error ? `: ${d.error}` : d.foStatus ? `: Fo-reported ${d.foStatus}` : ''}`)],
};

// ---------------- tasks ----------------
// A task is one thing the agent tried to get done through Fo. Follow-ups that carry a Fo conversationId join the
// task that opened that conversation. Every stage below is read from audit events; nothing is inferred from an approval.
function tasksOf(requests) {
  const byConv = new Map(); const tasks = [];
  for (const r of [...requests].reverse()) {
    const conv = r.toolInput?.conversationId;
    let t = conv && byConv.get(conv);
    if (!t) { t = { id: r.id, calls: [] }; tasks.push(t); }
    t.calls.push(r);
    const c = r.result?.conversationId || conv;
    if (c) byConv.set(c, t);
  }
  return tasks.reverse();
}

const has = (r, type) => r.events.some((e) => e.type === type);
function foText(res) {
  if (!res) return null;
  if (res.error) return res.error;
  try { const j = JSON.parse(res.text); if (typeof j.response === 'string') return j.response; } catch {}
  return res.text ?? null;
}
const verOf = (t) => t.calls.map((r) => state.data.verifications?.[r.id]).find(Boolean);

function taskStatus(t) {
  const last = t.calls[t.calls.length - 1];
  const v = verOf(t);
  if (t.calls.some((r) => r.status === 'pending')) return ['t-hold', 'Waiting for you', 'pause'];
  if (!t.calls.some((r) => has(r, 'release.granted'))) return ['t-stop', 'Stopped before Fo', 'hand'];
  if (v?.outcome === 'confirmed') return ['t-ok', 'Independently confirmed', 'shield'];
  if (v?.outcome === 'not-found') return ['t-fail', 'Check found nothing', 'alert'];
  if (last.status === 'failed') return ['t-fail', 'Failed', 'alert'];
  if (last.status === 'completed' && t.calls.every((r) => r.policy?.ruleId === 'read-only')) return ['t-dim', 'Read only · returned', 'check'];
  if (last.status === 'completed') return ['t-info', 'Fo reports done', 'check'];
  return statusOf(last);
}

function stage(tone, label, body, extra) {
  return h('li', { class: `stage ${tone}` }, h('span', { class: 'st-label' }, label), h('div', { class: 'st-body' }, body, extra ?? null));
}

function callStages(r) {
  const p = r.policy;
  const policyTone = p ? { allow: 't-info', deny: 't-stop', hold: 't-hold' }[p.effect] : 't-dim';
  const human = !p ? stage('t-dim', 'Human', 'Policy not decided yet')
    : p.effect === 'deny' ? stage('t-dim', 'Human', 'Not asked. Policy blocked it outright')
    : p.effect === 'allow' ? stage('t-dim', 'Human', 'Not needed. Policy allows this kind of call')
    : r.decision ? stage(r.decision.decision === 'approved' ? 't-ok' : 't-stop', 'Human', `${r.decision.decision === 'approved' ? 'Approved' : 'Rejected'} on ${r.decision.by}`, h('span', { class: 'st-fine' }, ` · bound to sha256 ${short(r.decision.hash ?? r.hash, 12)}`))
    : r.status === 'pending' ? stage('t-hold', 'Human', 'Waiting for your decision')
    : stage('t-dim', 'Human', r.expiredReason || 'No decision recorded');
  const released = has(r, 'release.granted');
  const text = foText(r.result);
  const fo = !released ? stage('t-stop', 'Fo', 'Never released to Fo. Fo received nothing')
    : !r.result ? stage('t-dim', 'Fo', 'Released to Fo. No result recorded yet')
    : stage(r.result.ok ? 't-info' : 't-fail', 'Fo says', h('span', {}, r.result.ok ? `“${text ?? '(no text)'}”` : `Failed: ${text ?? 'no detail'}`),
      h('span', { class: 'st-fine' }, ' · Fo’s own report, not a delivery check'));
  return [
    stage('t-dim', 'Agent asked', h('span', { class: 'quote' }, r.toolInput?.message ?? toolLabel(r.toolName)), h('span', { class: 'st-fine' }, ` · ${toolLabel(r.toolName)}${r.toolInput?.conversationId ? ' · follow-up in Fo conversation' : ''}`)),
    stage(policyTone, 'Policy', p ? h('span', {}, h('b', {}, `${{ allow: 'Allow', deny: 'Deny', hold: 'Hold for a human' }[p.effect]} · ${p.rule}. `), p.reason) : 'Evaluating'),
    human, fo,
  ];
}

function verifyStage(t) {
  const v = verOf(t);
  if (v) return stage(v.outcome === 'confirmed' ? 't-ok' : 't-fail', 'Independent check',
    h('span', {}, h('b', {}, v.outcome === 'confirmed' ? 'Confirmed outside Fo. ' : 'Checked outside Fo, not found. '), v.detail ?? ''),
    h('span', { class: 'st-fine' }, ` · ${v.method} · by ${v.by} · ${v.checkedAt} · recorded by hand, outside the audit chain`));
  if (!t.calls.some((r) => has(r, 'release.granted'))) return stage('t-dim', 'Independent check', 'Nothing to check. The audit shows no release to Fo');
  if (t.calls.every((r) => r.policy?.ruleId === 'read-only')) return stage('t-dim', 'Independent check', 'Not needed. A read-only call changes nothing');
  return stage('t-dim', 'Independent check', 'Not verified. Only Fo’s own report exists for this task');
}

function renderFeed(requests) {
  const f = FILTERS.find(([k]) => k === state.filter);
  const tasks = tasksOf(requests).filter((t) => !f || t.calls.some(f[3]));
  $('task-count').textContent = tasks.length ? `${tasks.length} task${tasks.length === 1 ? '' : 's'}` : '';
  if (!tasks.length) {
    $('feed').replaceChildren(h('li', { class: 'feed-empty' }, requests.length ? 'Nothing matches this filter.' : 'No Fo calls yet. Start the agent with bin/agent.sh and ask it to do something through Fo.'));
    return;
  }
  $('feed').replaceChildren(...tasks.map((t) => {
    const [tone, text, icon] = taskStatus(t);
    const first = t.calls[0];
    const open = state.open.has(t.id);
    const approvals = t.calls.filter((r) => r.decision?.decision === 'approved').length;
    const sub = [toolLabel(first.toolName), t.calls.length > 1 ? `${t.calls.length} Fo calls` : null, approvals ? `${approvals} human approval${approvals > 1 ? 's' : ''}` : first.policy?.effect === 'allow' ? 'no human step' : null].filter(Boolean).join(' · ');
    return h('li', {},
      h('button', { class: `row ${tone}`, type: 'button', 'aria-expanded': String(open), onclick: () => { open ? state.open.delete(t.id) : state.open.add(t.id); renderFeed(state.data.requests); } },
        h('span', { class: 'rail' }),
        h('span', {}, h('div', { class: 'title' }, first.toolInput?.message ?? toolLabel(first.toolName)), h('div', { class: 'sub2' }, sub)),
        h('span', { class: 'end' }, h('span', { class: `pill ${tone}`, icon }, text), h('time', { datetime: first.createdAt }, when(first.createdAt)))),
      open ? taskDetail(t) : null);
  }));
}

function taskDetail(t) {
  return h('div', { class: 'detail' },
    t.calls.map((r, i) => [
      t.calls.length > 1 ? h('p', { class: 'label' }, `Fo call ${i + 1} of ${t.calls.length}`) : null,
      h('ol', { class: 'stages' }, callStages(r)),
    ]),
    h('ol', { class: 'stages final' }, verifyStage(t)),
    h('details', { class: 'raw' }, h('summary', {}, 'Audit entries'),
      t.calls.map((r) => [
        h('ol', { class: 'trail', 'aria-label': 'Audit trail' }, r.events.map((e) => {
          const [tone, text] = EVENT[e.type] ?? ['t-dim', () => e.type];
          return h('li', { class: typeof tone === 'function' ? tone(e.data) : tone }, h('span', { class: 'ts' }, `#${e.seq} · ${new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19)}Z`), text(e.data));
        })),
        h('div', { class: 'hash' }, `${r.id} · sha256 ${r.hash}`)])));
}

// ---------------- live updates ----------------
let es;
function connect() {
  es?.close();
  es = new EventSource('/api/events');
  const live = $('live');
  es.onopen = () => { live.dataset.state = 'live'; $('live-text').textContent = 'Live'; load(); };
  es.onmessage = () => { clearTimeout(connect.t); connect.t = setTimeout(load, 80); };
  es.onerror = () => { live.dataset.state = 'down'; $('live-text').textContent = 'Reconnecting'; };
}

// ---------------- pairing ----------------
$('pair-btn').addEventListener('click', async () => {
  const { ok, json } = await api('/api/pair-codes', { method: 'POST', body: '{}' });
  if (!ok) return toast(json.error || 'Could not create a pairing link.');
  $('pair-links').replaceChildren(...json.links.map((l) => h('li', {}, h('span', {}, l.label), h('input', { readonly: true, value: l.url, onfocus: (e) => e.target.select() }))));
  $('pair-dialog').showModal();
});
$('pair-close').addEventListener('click', () => $('pair-dialog').close());
$('logout-btn').addEventListener('click', async () => { await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {}); $('pair-dialog').close(); showUnpaired(); });
$('clear-filter').addEventListener('click', () => { state.filter = null; render(); });

load().then(() => { if (state.data) connect(); });
