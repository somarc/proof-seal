import HttpError from './errors.js';
import { sha256Hex } from './crypto.js';
import { markdownUrl, previewUrl } from './aem.js';

/**
 * Fingerprint of a previewed page: sha256 of `{ref}--{site}--{org}.aem.page{path}.md`
 * plus `preview.lastModified` from admin /status (passed in as `status`).
 *
 * The .md is fetched anonymously: the caller's IMS token is never sent to aem.page.
 * TODO(protected previews): sites with preview authentication need a site token here.
 */
export async function fingerprint(loc, { fetch, status }) {
  const previewLastModified = status?.preview?.lastModified;
  if (!previewLastModified || (status.preview.status && status.preview.status !== 200)) {
    throw new HttpError(409, 'not_previewed', 'The page has no preview yet. Preview it, then send it for proof.');
  }
  const res = await fetch(markdownUrl(loc), { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) {
    throw new HttpError(502, 'preview_unreadable', `Preview .md returned ${res.status}`);
  }
  return {
    previewUrl: previewUrl(loc),
    contentHash: await sha256Hex(await res.text()),
    previewLastModified,
  };
}

/** Both parts must match: same bytes and the same preview. */
export const sameFingerprint = (a, b) => Boolean(a && b)
  && a.contentHash === b.contentHash
  && a.previewLastModified === b.previewLastModified;
