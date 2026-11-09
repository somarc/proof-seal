# Proof Seal for Experience Workspace (APS): backend

A Cloudflare Worker that seals a previewed page, sends it to a proofing tool, and publishes it
only when the final decision is publishable **and** the page is still byte-for-byte the version
that was reviewed. The contract is [`docs/proofing-seam.md`](../docs/proofing-seam.md).

The core (`src/core`, `src/providers`, `src/app.js`, `src/router.js`) uses only Web-standard APIs
(`fetch`, `Request`, `Response`, `crypto.subtle`, `URL`) and has no runtime dependencies;
`src/index.js` is the only Cloudflare-specific file.

```
src/
  index.js            Worker entry: env + KV -> createApp
  app.js              routes and handlers
  router.js           tiny router, CORS, JSON errors
  config.js           env parsing (SITE_KEYS, PROOF_PROVIDER, SITE_PROVIDERS, SITE_POLICIES, ALLOWED_ORIGINS)
  core/
    aem.js            admin.hlx.page client (status, live publish), URL helpers, site-key auth constant
    auth.js           caller check: IMS token -> admin /status (needs preview write) + IMS profile
    fingerprint.js    sha256 of the aem.page .md + preview.lastModified
    policy.js         shared Decision -> action (seam §4)
    seals.js          seal state machine + store layout
    gate.js           event -> policy -> re-fingerprint -> publish | break -> audit
    store.js          memory and KV stores
    crypto.js         sha256, HMAC, constant-time compare, random tokens
  providers/
    contract.js       ProofProvider typedefs, DECISIONS, assertProvider()
    sandbox.js        built-in fake reviewer (EDS-hosted reviewer page)
    ziflow.js         Ziflow adapter; every unverified detail in ZIFLOW_ASSUMPTIONS
test/                 node:test, offline (fetch stub + in-memory store) + Ziflow fixtures
```

## Flow

1. The EW panel saves the document and previews it with the author's IMS token, then calls
   `POST /api/rounds` with `Authorization: Bearer <IMS>`.
2. The backend checks the caller: the token goes to admin `GET /status/{org}/{site}/{ref}{path}`;
   the response must be 200 **and** `preview.permissions` must include `write` (status is readable
   anonymously on public sites, so 200 alone proves nothing). Name/email come from the IMS profile.
   The token is never stored or logged and is sent only to `admin.hlx.page` and `ims-na1.adobelogin.com`.
3. Fingerprint: `sha256(https://{ref}--{site}--{org}.aem.page{path}.md)` plus `preview.lastModified`.
   The `.md` is fetched anonymously (protected previews: TODO).
4. The provider creates a round; the seal (`in-review`) and round are stored.
5. The provider's decision arrives (webhook, or the sandbox page). The gate applies the policy.
   For `approved` it re-reads status (with the site key) and the `.md`; if both parts of the
   fingerprint match it calls `POST /live/{org}/{site}/{ref}{path}` with the site's publish key.
   If not, the seal is **broken**: no publish, the round is cancelled, the change is audited.

Seal states: `in-review -> changes | approved -> published | broken | withdrawn`.

## HTTP API

| Route | Auth | Returns |
|---|---|---|
| `GET /api/health?org=&site=` | none | `{ ok, provider: { id, ok, detail, capabilities }, checks: [{ id, ok, label, hint }] }` (no secret values) |
| `POST /api/rounds` `{org, site, ref?='main', path, reviewers?:[{email, role}], note?}` | IMS | `201 { seal, round, reviewerUrl }` |
| `GET /api/seals?org=&site=&path=[&ref=]` | IMS | `{ seal \| null, rounds: [newest first], latestDecision, audit: [{ at, type, actor, detail, data? }] }` |
| `GET /api/rounds/:id/feedback[?since=]` | IMS | `{ items: [{ id, author: {name, email, external}, body, createdAt, resolved, anchor? }] }` |
| `POST /api/rounds/:id/withdraw` | IMS | `{ seal, round }` |
| `POST /webhooks/:provider` | provider signature | `{ ok, outcome, reason }`; `401` when unverifiable |
| `GET /sandbox/rounds/:id?t=` | round secret | `{ round, seal: { path, previewUrl, contentHash }, feedback }` |
| `POST /sandbox/rounds/:id/decision` `{t, decision, comment?, reviewer?:{name,email}}` | round secret | `{ ok, outcome, seal }` |

Errors are `{ error: { code, message } }` with a matching status (400, 401, 403, 404, 405, 409,
422, 502, 503). CORS is answered for `ALLOWED_ORIGINS` only.

Sandbox reviewer links look like
`${SANDBOX_REVIEWER_URL}?round=<id>&t=<per-round secret>&api=<this worker's origin>`.

## Setup

```sh
cd worker
npx wrangler kv namespace create APS_STORE      # paste the id into wrangler.toml
npx wrangler secret put SITE_KEYS               # {"org/site":"<admin API key with role publish>"}
npx wrangler secret put ZIFLOW_API_KEY          # only when a site uses Ziflow
npx wrangler secret put ZIFLOW_WEBHOOK_SECRET   # the signature key set on the Ziflow webhook
npm run deploy
```

Vars (in `wrangler.toml` or the dashboard): `PROOF_PROVIDER` (`sandbox` default), `SITE_PROVIDERS`
(`{"org/site":"ziflow"}`), `SITE_POLICIES` (`{"org/site":{"autoPublish":true,"minorChangesAllowed":false}}`),
`ALLOWED_ORIGINS` (comma list, `https://*.aem.live` wildcards; default
`https://*.aem.live,https://*.aem.page,https://*.preview.da.live,https://da.live,http://localhost:3000`),
`SANDBOX_REVIEWER_URL`, `ZIFLOW_WEBHOOK_URL` (the exact URL registered in Ziflow, if it differs
from what the Worker sees). Missing or malformed config fails closed and shows in `/api/health`.

In Ziflow: Settings > API Settings > Webhooks, add `https://<worker>/webhooks/ziflow` with a
signature key, and subscribe to decision events.

### The site publish key (role `publish`)

Authors keep the `author` role and cannot publish; only this backend can, with a site API key:

```sh
curl -X POST "https://admin.hlx.page/config/{org}/sites/{site}/apiKeys.json" \
  -H "authorization: token $ADMIN_KEY_OR_LOGIN_TOKEN" -H "content-type: application/json" \
  -d '{"description":"Proof Seal publisher","roles":["publish"],"expiresIn":31536000}'
```

Put the returned `value` into `SITE_KEYS` under `"org/site"`. The key is presented as
`authorization: token <key>` (one constant, `SITE_KEY_AUTH` in `src/core/aem.js`).

### Author roles

```sh
curl -X POST "https://admin.hlx.page/config/{org}/sites/{site}/access/admin.json" \
  -H "content-type: application/json" \
  -d '{"role":{"author":["author1@example.com","*@example.com"],"publish":["lead@example.com"]}}'
```

With no role mapping, every authenticated user gets the default role `basic_publish`, which can
publish directly and so bypasses the seal. Map authors to `author` to make the seal the only path
to live.

## Development

```sh
npm test            # from the repo root: node --test worker/test (offline)
cd worker && npm run dev
```

Notes: KV is eventually consistent and `append` is read-modify-write. Two near-simultaneous
deliveries of the same decision could both pass the duplicate check on different edge
locations; the second publish is of identical content. There is also a short window between the
re-fingerprint and `POST /live`.
