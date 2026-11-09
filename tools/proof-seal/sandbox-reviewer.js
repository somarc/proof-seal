/*
 * Proof Seal Sandbox reviewer: a stand-in proofing tool.
 *
 * It lets anyone try Proof Seal without a Ziflow account: the reviewer sees the
 * previewed page, leaves a comment, and decides. Decisions go to the Proof Seal
 * backend exactly like a provider webhook would, so the publish gate is the same.
 * Access is limited to whoever holds the per-round secret in the URL.
 */
const params = new URLSearchParams(window.location.search);
const roundId = params.get('round');
const secret = params.get('t');
const apiBase = (params.get('api') || 'https://proof-seal.mc-hess.workers.dev').replace(/\/+$/, '');

const DECISIONS = [
  { id: 'approved', label: 'Approve', className: 'sr-approve' },
  { id: 'approved_with_changes', label: 'Approve with changes', className: '' },
  { id: 'changes_required', label: 'Changes required', className: 'sr-changes' },
];

const view = {
  data: null,
  busy: false,
  error: '',
  done: '',
  name: '',
  email: '',
  comment: '',
};

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

async function call(pathname, options = {}) {
  const resp = await fetch(`${apiBase}${pathname}`, {
    ...options,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Backend returned ${resp.status}`);
  return data;
}

async function load() {
  view.data = await call(`/sandbox/rounds/${encodeURIComponent(roundId)}?t=${encodeURIComponent(secret)}`);
  const frame = document.querySelector('.sr-frame');
  const url = view.data?.seal?.previewUrl;
  if (url && frame.getAttribute('src') !== url) frame.setAttribute('src', url);
}

async function decide(decision) {
  view.busy = true;
  view.error = '';
  // eslint-disable-next-line no-use-before-define
  render();
  try {
    await call(`/sandbox/rounds/${encodeURIComponent(roundId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({
        t: secret,
        decision,
        comment: view.comment || undefined,
        reviewer: { name: view.name || undefined, email: view.email || undefined },
      }),
    });
    view.done = DECISIONS.find((d) => d.id === decision)?.label || decision;
    view.comment = '';
    await load();
  } catch (error) {
    view.error = error.message;
  } finally {
    view.busy = false;
    // eslint-disable-next-line no-use-before-define
    render();
  }
}

function render() {
  const main = document.querySelector('.sr-side');
  if (!roundId || !secret) {
    main.replaceChildren(h('p', { className: 'ps-banner ps-tone-error' }, 'This review link is incomplete.'));
    return;
  }
  const round = view.data?.round;
  const seal = view.data?.seal;
  const feedback = view.data?.feedback || [];
  main.replaceChildren(...[
    h(
      'header',
      { className: 'ps-header' },
      h('h1', { className: 'ps-title' }, 'Sandbox review'),
      h('p', { className: 'ps-muted' }, 'Stand-in proofing tool for Proof Seal demos.'),
    ),
    view.error ? h('p', { className: 'ps-banner ps-tone-error', role: 'alert' }, view.error) : null,
    view.done ? h('p', { className: 'ps-banner ps-tone-ok' }, `Decision recorded: ${view.done}.`) : null,
    h(
      'section',
      { className: 'ps-card' },
      h(
        'dl',
        { className: 'ps-facts' },
        h('dt', {}, 'Page'),
        h('dd', { className: 'ps-mono' }, seal?.path || '…'),
        h('dt', {}, 'Round'),
        h('dd', {}, round?.number ?? '…'),
        h('dt', {}, 'Fingerprint'),
        h('dd', { className: 'ps-mono', title: seal?.contentHash }, (seal?.contentHash || '').slice(0, 12)),
        h('dt', {}, 'Status'),
        h('dd', {}, round?.decision || '…'),
      ),
    ),
    h(
      'section',
      { className: 'ps-card' },
      h('label', { className: 'ps-label', for: 'sr-name' }, 'Your name'),
      h('input', {
        id: 'sr-name', className: 'ps-input', value: view.name, onInput: (e) => { view.name = e.target.value; },
      }),
      h('label', { className: 'ps-label', for: 'sr-email' }, 'Your email'),
      h('input', {
        id: 'sr-email', className: 'ps-input', type: 'email', value: view.email, onInput: (e) => { view.email = e.target.value; },
      }),
      h('label', { className: 'ps-label', for: 'sr-comment' }, 'Comment'),
      h('textarea', {
        id: 'sr-comment', className: 'ps-input', rows: '4', onInput: (e) => { view.comment = e.target.value; },
      }, view.comment),
      h('div', { className: 'sr-decisions' }, DECISIONS.map((d) => h('button', {
        className: `ps-button ${d.className}`,
        type: 'button',
        disabled: view.busy,
        onClick: () => decide(d.id),
      }, d.label))),
    ),
    feedback.length ? h(
      'section',
      { className: 'ps-card' },
      h('h2', { className: 'ps-heading' }, 'Comments'),
      h('ul', { className: 'ps-list' }, feedback.map((item) => h(
        'li',
        { className: 'ps-feedback' },
        h('p', { className: 'ps-meta' }, item.author?.name || item.author?.email || 'Reviewer'),
        h('p', {}, item.body),
      ))),
    ) : null,
  ].filter(Boolean));
}

(async function init() {
  render();
  if (!roundId || !secret) return;
  try {
    await load();
  } catch (error) {
    view.error = error.message;
  }
  render();
}());
