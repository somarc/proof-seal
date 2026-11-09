import HttpError from './errors.js';
import { imsHeaders } from './aem.js';

export const IMS_PROFILE_URL = 'https://ims-na1.adobelogin.com/ims/profile/v1';

/**
 * Admin /status answers anonymously for public sites, so a 200 alone proves nothing.
 * The caller must hold this permission on the preview partition (authors can preview).
 * `preview.permissions` is in the admin API's documented status response.
 */
export const REQUIRED_PREVIEW_PERMISSION = 'write';

export function bearerToken(request) {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
  return match ? match[1] : null;
}

async function profile(token, fetch) {
  try {
    const res = await fetch(IMS_PROFILE_URL, { headers: imsHeaders(token) });
    if (!res.ok) return { name: '', email: '' };
    const p = await res.json();
    return {
      name: p.displayName || p.name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      email: p.email || '',
    };
  } catch {
    return { name: '', email: '' };
  }
}

/**
 * Verifies the caller by forwarding their IMS token to admin /status for the page.
 * Returns { user: {name, email}, status } (status = the admin status body, reused for the
 * fingerprint). The token is used for these two calls only: never stored, never logged.
 */
export async function verifyCaller(request, loc, { aem, fetch }) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'unauthenticated', 'Sign in: an IMS bearer token is required');
  const { status, body } = await aem.status(loc, imsHeaders(token));
  if (status === 401) throw new HttpError(401, 'unauthenticated', 'The IMS token was not accepted by AEM');
  if (status === 403) throw new HttpError(403, 'forbidden', 'You have no access to this site');
  if (status === 404) throw new HttpError(404, 'not_found', 'Unknown site or page');
  if (status !== 200 || !body) throw new HttpError(502, 'aem_unavailable', `AEM status returned ${status}`);
  const permissions = body.preview?.permissions;
  if (!Array.isArray(permissions) || !permissions.includes(REQUIRED_PREVIEW_PERMISSION)) {
    throw new HttpError(403, 'forbidden', 'You need the author role on this site to send pages for proof');
  }
  return { user: await profile(token, fetch), status: body };
}
