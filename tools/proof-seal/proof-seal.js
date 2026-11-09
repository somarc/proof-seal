/*
 * Proof Seal for Experience Workspace: tool-panel plugin.
 *
 * The panel saves and previews the page, then asks the Proof Seal backend to
 * fingerprint the preview and open a review round with the configured proofing
 * provider (Ziflow, or the built-in Sandbox). The backend publishes only an
 * approved, unchanged version; this panel never publishes.
 *
 * Install: one `library` row in the site (or org) config, for example
 *   title: Proof Seal
 *   path:  https://main--proof-seal--somarc.aem.live/tools/proof-seal/proof-seal.html?api=<backend>
 */
// eslint-disable-next-line import/no-unresolved -- remote ES module served by da.live
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

const DEFAULT_API = 'https://proof-seal.mc-hess.workers.dev';
const ADMIN = 'https://admin.hlx.page';
const POLL_MS = 8000;
const CHAT_MOUNT_MS = 1500;
const LIVE_STATES = ['in-review', 'approved'];
const SEALED_STATES = ['in-review', 'approved', 'published'];

const STATES = {
  none: { label: 'Not sent', tone: 'neutral' },
  'in-review': { label: 'In review', tone: 'info' },
  changes: { label: 'Changes requested', tone: 'warn' },
  approved: { label: 'Approved, publishing', tone: 'info' },
  published: { label: 'Sealed and published', tone: 'ok' },
  broken: { label: 'Seal broken', tone: 'error' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

const state = {
  context: null,
  token: '',
  actions: null,
  seal: null,
  rounds: [],
  audit: [],
  feedback: [],
  health: null,
  busy: '',
  error: '',
  edited: false,
  baselineHtml: null,
  lastHtml: null,
  reviewers: '',
  note: '',
};

let pollTimer;

/* ---------- helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (value === undefined || value === null || value === false) return;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'className') {
      el.className = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, value);
    }
  });
  children.flat().forEach((child) => {
    if (child === undefined || child === null || child === false) return;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  });
  return el;
}

function apiBase() {
  const param = new URL(window.location.href).searchParams.get('api');
  return (param || DEFAULT_API).replace(/\/+$/, '');
}

function pagePath(context) {
  let path = context?.path || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\.html$/, '');
  if (path === '/index') return '/';
  if (path.endsWith('/index')) return path.slice(0, -'index'.length);
  return path;
}

function siteKey() {
  const { org, site, repo } = state.context;
  return `${org}/${site || repo}`;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function parseReviewers(text) {
  return text.split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter((email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    .map((email) => ({ email, role: 'approver' }));
}

async function api(pathname, { method = 'GET', body, auth = true } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  // The IMS token goes only to the Proof Seal backend, which forwards it to
  // admin.hlx.page and Adobe IMS to authorise the caller. It is never stored.
  if (auth) headers.authorization = `Bearer ${state.token}`;
  const resp = await fetch(`${apiBase()}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const error = new Error(data?.error?.message || `Proof Seal backend returned ${resp.status}`);
    error.status = resp.status;
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

/* ---------- data ---------- */

async function loadSeal() {
  const { org } = state.context;
  const site = state.context.site || state.context.repo;
  const query = new URLSearchParams({ org, site, path: pagePath(state.context) });
  const data = await api(`/api/seals?${query}`);
  state.seal = data.seal || null;
  state.rounds = data.rounds || [];
  state.audit = data.audit || [];
  const [latest] = state.rounds;
  if (latest?.roundId) {
    const fb = await api(`/api/rounds/${encodeURIComponent(latest.roundId)}/feedback`)
      .catch(() => ({ items: [] }));
    state.feedback = fb.items || [];
  } else {
    state.feedback = [];
  }
}

async function loadHealth() {
  const { org } = state.context;
  const site = state.context.site || state.context.repo;
  try {
    state.health = await api(`/api/health?${new URLSearchParams({ org, site })}`, { auth: false });
  } catch (error) {
    state.health = {
      ok: false,
      checks: [{
        id: 'backend', ok: false, label: 'Proof Seal backend reachable', hint: error.message,
      }],
    };
  }
}

async function previewPage() {
  const { org, branch } = state.context;
  const site = state.context.site || state.context.repo;
  const ref = branch || 'main';
  // admin.hlx.page is an Adobe host, so the SDK's daFetch may attach the IMS token.
  const resp = await state.actions.daFetch(
    `${ADMIN}/preview/${org}/${site}/${ref}${pagePath(state.context)}`,
    { method: 'POST' },
  );
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('You need preview rights on this site to send it for proof.');
  }
  if (!resp.ok) throw new Error(`Preview failed (${resp.status}).`);
}

/* ---------- actions ---------- */

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!LIVE_STATES.includes(state.seal?.state)) return;
  pollTimer = setTimeout(async () => {
    try {
      await loadSeal();
      state.error = '';
    } catch (error) {
      state.error = error.message;
    }
    // eslint-disable-next-line no-use-before-define
    render();
    schedulePoll();
  }, POLL_MS);
}

async function run(label, task) {
  state.busy = label;
  state.error = '';
  // eslint-disable-next-line no-use-before-define
  render();
  try {
    await task();
  } catch (error) {
    state.error = error.message || String(error);
  } finally {
    state.busy = '';
    // eslint-disable-next-line no-use-before-define
    render();
    schedulePoll();
  }
}

function sendForProof() {
  return run('Saving…', async () => {
    const saved = await state.actions.saveDocument();
    if (!saved?.ok) throw new Error('The document could not be saved. Try again.');
    state.busy = 'Previewing…';
    // eslint-disable-next-line no-use-before-define
    render();
    await previewPage();
    state.busy = 'Sealing and sending…';
    // eslint-disable-next-line no-use-before-define
    render();
    const { org } = state.context;
    const site = state.context.site || state.context.repo;
    const reviewers = parseReviewers(state.reviewers);
    try {
      localStorage.setItem(`proof-seal:reviewers:${siteKey()}`, state.reviewers);
    } catch { /* storage may be partitioned */ }
    await api('/api/rounds', {
      method: 'POST',
      body: {
        org,
        site,
        ref: state.context.branch || 'main',
        path: pagePath(state.context),
        reviewers,
        note: state.note || undefined,
      },
    });
    state.note = '';
    state.baselineHtml = state.lastHtml;
    state.edited = false;
    await loadSeal();
  });
}

function withdraw() {
  const [latest] = state.rounds;
  if (!latest) return Promise.resolve();
  return run('Withdrawing…', async () => {
    await api(`/api/rounds/${encodeURIComponent(latest.roundId)}/withdraw`, { method: 'POST' });
    await loadSeal();
  });
}

function fixWithAssistant(item) {
  const { actions } = state;
  const round = state.rounds[0]?.number || state.seal?.round || '';
  const who = item.author?.name || item.author?.email || 'A reviewer';
  const quote = item.anchor?.quote ? ` It refers to: "${item.anchor.quote}".` : '';
  try {
    const off = actions.subscribeChatTurnCompleted((detail) => {
      off();
      if (detail.status === 'completed') {
        actions.openComparison({ candidate: 'document', baseline: 'live' });
      }
    });
  } catch { /* older host without chat-turn events: skip the comparison */ }
  const prompt = `Proof Seal feedback from ${who} (round ${round}): "${item.body}".${quote} `
    + 'Apply exactly this change to the page and keep everything else unchanged.';
  // Opening the chat and sending in one message sends an empty prompt when the chat
  // panel is not mounted yet. Prefill first (this opens the chat), then send.
  actions.setPrompt(prompt, { autoSend: false });
  setTimeout(() => actions.setPrompt(prompt, { autoSend: true }), CHAT_MOUNT_MS);
}

/* ---------- view ---------- */

function chip(stateId) {
  const def = STATES[stateId] || STATES.none;
  return h('span', { className: `ps-chip ps-tone-${def.tone}` }, def.label);
}

function healthChip(ok) {
  return h('span', { className: `ps-chip ps-tone-${ok ? 'ok' : 'warn'}` }, ok ? 'Ready' : 'Needs setup');
}

function sealCard() {
  const { seal } = state;
  const [round] = state.rounds;
  if (!seal) {
    return h(
      'section',
      { className: 'ps-card' },
      h('div', { className: 'ps-row' }, chip('none')),
      h('p', { className: 'ps-muted' }, 'Send this page for proof. Reviewers see the preview; '
        + 'their approval publishes exactly the version they saw.'),
    );
  }
  return h(
    'section',
    { className: 'ps-card' },
    h(
      'div',
      { className: 'ps-row' },
      chip(seal.state),
      round ? h('span', { className: 'ps-muted' }, `Round ${round.number || seal.round}`) : null,
    ),
    h(
      'dl',
      { className: 'ps-facts' },
      h('dt', {}, 'Fingerprint'),
      h('dd', { className: 'ps-mono', title: seal.contentHash }, (seal.contentHash || '').slice(0, 12)),
      h('dt', {}, 'Provider'),
      h('dd', {}, round?.provider || '—'),
      h('dt', {}, 'Sent by'),
      h('dd', {}, seal.createdBy?.name || seal.createdBy?.email || '—'),
      h('dt', {}, round ? `Round ${round.number} sent` : 'Sent'),
      h('dd', {}, formatTime(round?.createdAt || seal.createdAt)),
      seal.publishedAt ? h('dt', {}, 'Published') : null,
      seal.publishedAt ? h('dd', {}, formatTime(seal.publishedAt)) : null,
    ),
    round?.reviewerUrl ? h('a', {
      className: 'ps-link', href: round.reviewerUrl, target: '_blank', rel: 'noopener',
    }, 'Open the review ↗') : null,
  );
}

function warnings() {
  const items = [];
  if (state.edited && SEALED_STATES.includes(state.seal?.state)) {
    items.push(h('p', { className: 'ps-banner ps-tone-warn' }, 'This page changed after it was sent. '
      + 'Reviewers are looking at an older version, and their approval will not publish it. '
      + 'Send a new round.'));
  }
  if (state.seal?.state === 'broken') {
    items.push(h('p', { className: 'ps-banner ps-tone-error' }, 'The content changed after approval, '
      + 'so nothing was published. Send a new round to get the current version approved.'));
  }
  if (state.error) items.push(h('p', { className: 'ps-banner ps-tone-error', role: 'alert' }, state.error));
  return items;
}

function sendForm() {
  const seal = state.seal?.state;
  const nextRound = (state.seal?.round || 0) + 1;
  const label = !state.seal || seal === 'withdrawn' ? 'Send for proof' : `Send round ${nextRound}`;
  const canWithdraw = LIVE_STATES.includes(seal) && !state.busy;
  return h(
    'section',
    { className: 'ps-card' },
    h('label', { className: 'ps-label', for: 'ps-reviewers' }, 'Approvers (emails)'),
    h('input', {
      id: 'ps-reviewers',
      className: 'ps-input',
      type: 'text',
      placeholder: 'legal@example.com, brand@example.com',
      value: state.reviewers,
      onInput: (e) => { state.reviewers = e.target.value; },
    }),
    h('label', { className: 'ps-label', for: 'ps-note' }, 'Note to reviewers (optional)'),
    h('textarea', {
      id: 'ps-note',
      className: 'ps-input',
      rows: '2',
      onInput: (e) => { state.note = e.target.value; },
    }, state.note),
    h(
      'div',
      { className: 'ps-actions' },
      h('button', {
        className: 'ps-button ps-primary', type: 'button', disabled: Boolean(state.busy), onClick: sendForProof,
      }, state.busy || label),
      canWithdraw ? h('button', {
        className: 'ps-button', type: 'button', onClick: withdraw,
      }, 'Withdraw') : null,
    ),
  );
}

function feedbackList() {
  if (!state.feedback.length) return null;
  return h(
    'section',
    { className: 'ps-card' },
    h('h2', { className: 'ps-heading' }, 'Feedback'),
    h('ul', { className: 'ps-list' }, state.feedback.map((item) => h(
      'li',
      { className: `ps-feedback${item.resolved ? ' ps-resolved' : ''}` },
      h(
        'p',
        { className: 'ps-meta' },
        item.author?.name || item.author?.email || 'Reviewer',
        item.author?.external ? h('span', { className: 'ps-tag' }, 'external') : null,
        h('span', { className: 'ps-muted' }, formatTime(item.createdAt)),
      ),
      h('p', {}, item.body),
      item.anchor?.quote ? h('blockquote', {}, item.anchor.quote) : null,
      h('button', {
        className: 'ps-button ps-small', type: 'button', onClick: () => fixWithAssistant(item),
      }, 'Fix with assistant'),
    ))),
  );
}

function activity() {
  if (!state.audit.length) return null;
  return h(
    'details',
    { className: 'ps-card' },
    h('summary', { className: 'ps-heading' }, 'Activity'),
    h('ol', { className: 'ps-list ps-audit' }, state.audit.slice(0, 20).map((entry) => h(
      'li',
      {},
      h('span', { className: 'ps-muted' }, formatTime(entry.at)),
      ` ${entry.type}`,
      entry.actor?.name || entry.actor?.email ? ` · ${entry.actor.name || entry.actor.email}` : '',
      entry.detail ? h('span', { className: 'ps-muted' }, ` — ${typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)}`) : '',
    ))),
  );
}

function setupCheck() {
  const checks = state.health?.checks || [];
  const ok = state.health?.ok;
  return h(
    'details',
    { className: 'ps-card', open: state.health && !ok },
    h('summary', { className: 'ps-heading' }, 'Setup check ', state.health ? healthChip(ok) : null),
    h('ul', { className: 'ps-list ps-checks' }, checks.map((check) => h(
      'li',
      { className: check.ok ? 'ps-ok' : 'ps-fail' },
      h('span', { 'aria-hidden': 'true' }, check.ok ? '✓ ' : '✕ '),
      check.label,
      !check.ok && check.hint ? h('span', { className: 'ps-muted ps-hint' }, check.hint) : null,
    ))),
    h('p', { className: 'ps-muted ps-mono' }, `Backend: ${apiBase()}`),
  );
}

function render() {
  const main = document.querySelector('main.ps');
  if (!state.context) return;
  main.replaceChildren(...[
    h(
      'header',
      { className: 'ps-header' },
      h('h1', { className: 'ps-title' }, 'Proof Seal'),
      h('p', { className: 'ps-path ps-mono' }, pagePath(state.context)),
    ),
    ...warnings(),
    sealCard(),
    sendForm(),
    feedbackList(),
    activity(),
    setupCheck(),
  ].filter(Boolean));
}

/* ---------- boot ---------- */

function watchDocument() {
  try {
    state.actions.subscribeLiveDocument(({ html }) => {
      state.lastHtml = html;
      if (state.baselineHtml === null) {
        state.baselineHtml = html;
        return;
      }
      const edited = html !== state.baselineHtml;
      if (edited !== state.edited) {
        state.edited = edited;
        render();
      }
    });
  } catch { /* host without live document support */ }
}

function watchToken() {
  window.addEventListener('message', (e) => {
    const trusted = e.origin === 'https://da.live' || /^https:\/\/[a-z0-9-]+\.da\.live$/.test(e.origin);
    if (trusted && typeof e.data?.token === 'string') state.token = e.data.token;
  });
}

(async function init() {
  const { context, token, actions } = await DA_SDK;
  state.context = context;
  state.token = token;
  state.actions = actions;
  try {
    state.reviewers = localStorage.getItem(`proof-seal:reviewers:${siteKey()}`) || '';
  } catch { /* storage may be partitioned */ }
  watchToken();
  watchDocument();
  render();
  await Promise.all([
    loadHealth(),
    loadSeal().catch((error) => { state.error = error.message; }),
  ]);
  render();
  schedulePoll();
}());
