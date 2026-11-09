import HttpError from './core/errors.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 'https://*.aem.live' -> /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.aem\.live$/i (one or more labels). */
export function compileOrigins(list) {
  return list.map((pattern) => new RegExp(`^${pattern.split('*').map(escapeRe).join('[a-z0-9-]+(?:\\.[a-z0-9-]+)*')}$`, 'i'));
}

export const isAllowedOrigin = (origin, patterns) => Boolean(origin)
  && patterns.some((re) => re.test(origin));

const CORS_ALLOW = {
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(error) {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  // Unexpected errors: generic message only; never echo internals (could include secrets).
  return json({ error: { code: 'internal', message: 'Internal error' } }, 500);
}

/** Minimal router: patterns like '/api/rounds/:id/feedback'. */
export function createRouter() {
  const routes = [];
  const router = {
    add(method, pattern, handler) {
      const names = [];
      const re = new RegExp(`^${pattern.replace(/:([a-z]+)/gi, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
      routes.push({
        method, re, names, handler,
      });
      return router;
    },
    match(method, pathname) {
      const hits = routes
        .map((r) => ({ r, m: r.re.exec(pathname) }))
        .filter(({ m }) => m);
      const hit = hits.find(({ r }) => r.method === method);
      if (!hit) return { allowed: hits.map(({ r }) => r.method) };
      const params = Object.fromEntries(hit.r.names
        .map((n, i) => [n, decodeURIComponent(hit.m[i + 1])]));
      return { handler: hit.r.handler, params };
    },
  };
  return router;
}

/** Dispatch with CORS: preflight answered here; ACAO only echoed for allowed origins. */
export async function serve(request, { router, origins }) {
  const origin = request.headers.get('origin');
  const allowed = isAllowedOrigin(origin, origins);
  const cors = allowed ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };

  if (request.method === 'OPTIONS') {
    if (origin && !allowed) {
      return json({ error: { code: 'origin_not_allowed', message: 'Origin not allowed' } }, 403, { vary: 'Origin' });
    }
    return new Response(null, { status: 204, headers: { ...cors, ...CORS_ALLOW } });
  }

  const url = new URL(request.url);
  let response;
  try {
    const { handler, params, allowed: methods } = router.match(request.method, url.pathname);
    if (!handler) {
      throw methods.length
        ? new HttpError(405, 'method_not_allowed', `Use ${methods.join(', ')}`)
        : new HttpError(404, 'not_found', 'No such route');
    }
    response = await handler({ request, url, params });
  } catch (e) {
    response = errorResponse(e);
  }
  const headers = new Headers(response.headers);
  Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
  return new Response(response.body, { status: response.status, headers });
}
