import HttpError from './errors.js';

export const AEM_ADMIN = 'https://admin.hlx.page';

/**
 * How the site API key (role `publish`) is presented to the admin API.
 * The admin API docs (login section) say `authorization: token $API_KEY`; its OpenAPI also
 * lists a `BearerToken` (JWT) scheme, and older docs mention `x-auth-token`.
 * UNVERIFIED against a live key: change this one constant if the spike shows otherwise.
 */
export const SITE_KEY_AUTH = { header: 'authorization', scheme: 'token' };

export const siteKeyHeaders = (key) => ({ [SITE_KEY_AUTH.header]: `${SITE_KEY_AUTH.scheme} ${key}` });

/** The caller's IMS token. Only ever sent to admin.hlx.page and ims-na1.adobelogin.com. */
export const imsHeaders = (token) => ({ authorization: `Bearer ${token}` });

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** Validates org/site/ref/path; returns a normalized location or throws 400. */
export function parseLocation({
  org, site, ref = 'main', path,
} = {}) {
  if (!NAME.test(org || '') || !NAME.test(site || '') || !NAME.test(ref || '')) {
    throw new HttpError(400, 'bad_request', 'org, site and ref must be simple names');
  }
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512
    || /[?#\\\s]|\/\/|\/\.\.?(\/|$)/.test(path)) {
    throw new HttpError(400, 'bad_request', 'path must be an absolute page path like /en/page');
  }
  return {
    org: org.toLowerCase(),
    site: site.toLowerCase(),
    ref: ref.toLowerCase(),
    path: path.replace(/\.(html|md)$/, ''),
  };
}

export const siteId = ({ org, site }) => `${org}/${site}`;
export const pageId = ({ org, site, path }) => `${org}/${site}${path}`;

const host = ({ org, site, ref }, tld) => `https://${ref}--${site}--${org}.${tld}`;

export const previewUrl = (loc) => `${host(loc, 'aem.page')}${loc.path}`;

export const markdownUrl = (loc) => `${host(loc, 'aem.page')}${loc.path.endsWith('/') ? `${loc.path}index` : loc.path}.md`;

const adminUrl = (route, {
  org, site, ref, path,
}) => `${AEM_ADMIN}/${route}/${org}/${site}/${ref}${path}`;

export function createAemClient({ fetch }) {
  return {
    /** GET /status. Returns { status, body } and never throws on HTTP errors. */
    async status(loc, headers) {
      const res = await fetch(adminUrl('status', loc), { headers });
      return { status: res.status, body: res.ok ? await res.json() : null };
    },
    /** POST /live with the site API key. Throws HttpError(502) when AEM refuses. */
    async publish(loc, siteKey) {
      const res = await fetch(adminUrl('live', loc), { method: 'POST', headers: siteKeyHeaders(siteKey) });
      if (!res.ok) {
        const reason = res.headers.get('x-error') || '';
        throw new HttpError(502, 'publish_failed', `AEM publish returned ${res.status}${reason ? `: ${reason}` : ''}`);
      }
      return res.json().catch(() => ({}));
    },
  };
}
