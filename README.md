# Proof Seal for Experience Workspace

**What goes live is what was approved.**

Proof Seal sends a page from Experience Workspace to a proofing tool, and publishes exactly the version the reviewers approved. If anyone changes the page after approval, the seal breaks and nothing is published until a new round is approved.

- Site (built with itself): https://main--proof-seal--somarc.aem.live/
- Demo page that gets proofed: https://main--proof-seal--somarc.aem.page/demo/winter-savings
- Design of the proofing seam: [`docs/proofing-seam.md`](docs/proofing-seam.md)

> Status: under construction for the Experience Workspace Extension Challenge (9–16 November 2026). The panel, the Sandbox reviewer and the backend core are in place. The Ziflow adapter is written against Ziflow's public docs and is being verified against a live account.

## How it works

1. **Send for proof.** The author opens the Proof Seal panel in Experience Workspace and sends the page. The panel saves the document and previews it with the author's own rights. The backend then records a fingerprint: a SHA-256 hash of the previewed page plus its preview timestamp.
2. **Review where reviewers work.** The backend opens a review round in the configured proofing tool: Ziflow, or the built-in Sandbox reviewer for demos. Reviewers comment on the rendered preview; external reviewers need no Adobe account.
3. **Fix with the assistant.** Feedback appears in the panel. "Fix with assistant" hands a comment to the Experience Workspace assistant, then opens Review changes when the assistant is done.
4. **Approval publishes the seal.** When the final decision is "approved", the backend fingerprints the preview again. If it matches, the backend publishes that version with a site API key. If it does not, the seal is broken: nothing is published, the round is cancelled, and the audit trail records why.

### Why authors cannot publish around it

An Experience Workspace extension cannot block the Publish button. Edge Delivery admin roles can, so Proof Seal uses them:

- Authors get the `author` (or `basic_author`) role: they can preview, but not publish.
- Only the Proof Seal backend holds a site API key with the `publish` role.
- Hide the now-unusable Publish card with the `editor.hidePublish` config key for the gated paths.

## Repository layout

| Path | What it is |
|---|---|
| `tools/proof-seal/proof-seal.html` | The Experience Workspace panel (library plugin) |
| `tools/proof-seal/sandbox-reviewer.html` | The Sandbox reviewer, a stand-in proofing tool |
| `worker/` | The backend: a Cloudflare Worker with the provider-agnostic core, the Sandbox and Ziflow adapters, and tests. Not served by Edge Delivery (see `.hlxignore`). |
| `docs/proofing-seam.md` | The adapter contract every proofing tool implements |
| `blocks/`, `scripts/`, `styles/` | The Edge Delivery site that explains Proof Seal. It is authored in Experience Workspace and wired for Canvas (`scripts/scripts.js`). |

## Install

You need: an Edge Delivery site authored in Experience Workspace, admin rights on its configuration, and somewhere to run the backend (Cloudflare Workers free tier is enough).

1. **Deploy the backend.** Follow [`worker/README.md`](worker/README.md): create the KV namespace, set the secrets, `npm run deploy`.
2. **Create the site publish key** for the backend (needs `config_admin`):
   ```bash
   curl -X POST "https://admin.hlx.page/config/{org}/sites/{site}/apiKeys.json" \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
     -d '{"description":"Proof Seal publisher","roles":["publish"],"expiresIn":31536000}'
   ```
   Store the returned value as the backend secret `SITE_KEYS` (`{"{org}/{site}":"<value>"}`).
3. **Make authors preview-only.** Map your authors to `author` and only approvers to `publish`:
   ```bash
   curl -X POST "https://admin.hlx.page/config/{org}/sites/{site}/access/admin.json" \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
     -d '{"role":{"author":["*@example.com"],"publish":["approver@example.com"]}}'
   ```
   Without a role mapping, the default role can publish, and the seal is only advisory.
4. **Add the panel** as one row in the `library` sheet of your site (or org) configuration at `https://da.live/config#/{org}/{site}/`:

   | title | path | experience |
   |---|---|---|
   | Proof Seal | `https://main--proof-seal--somarc.aem.live/tools/proof-seal/proof-seal.html?api=https://<your-backend>` | inline |

5. Open a page in Experience Workspace, open **Proof Seal** from the tool panel, and check that every line of **Setup check** is green.

## Develop

```bash
npm ci
npx -y @adobe/aem-cli up        # site and panel at http://localhost:3000
npm test                        # backend tests (node:test, no network)
npm run lint
```

Load the panel from your machine by opening the page in Experience Workspace with `?ref=local`.

## Security

- The panel sends the author's IMS token only to the Proof Seal backend. The backend uses it only to call `admin.hlx.page` (to confirm the author can access the page) and Adobe IMS (for the author's name). It never stores or logs the token.
- Proofing-tool credentials and the site publish key live only in backend secrets, never in configuration sheets or the browser.
- Webhooks are rejected unless their signature verifies. Sandbox decisions need the per-round secret from the reviewer link.

## Limitations

- Previews must be publicly reachable for the fingerprint check and live-URL proofs. Protected previews need preview credentials (not yet supported).
- Between the final fingerprint check and the publish call, an author could still re-preview. The window is short, and the backend checks again after publishing and records any mismatch.

## License

Apache License 2.0
