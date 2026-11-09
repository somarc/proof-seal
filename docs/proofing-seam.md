# APS (Adobe Proof Seal): the proofing seam

APS asks a proofing tool to review a previewed page. The approval is bound to the exact version that was previewed, and only an approved, unchanged version is published.
The **seam** is the one place where proofing tools differ. Everything else is shared core and does not depend on which tool is used.

**Build scope this week:** the core, the **Ziflow** adapter, and a **Sandbox** adapter (a fake reviewer, used for "Try it" and tests).
Other tools appear below as mappings only. No code is written for them until someone needs it.

## 1. What belongs to the core and what belongs to an adapter

| Shared core (written once) | Adapter (one per proofing tool) |
|---|---|
| The EW panel, and the panel ↔ backend API | Creating a review round from a URL or a snapshot |
| The fingerprint: SHA-256 of `aem.page{path}.md` plus `preview.lastModified` | Reading round status and reviewer decisions |
| Policy: which decisions allow publishing | Listing feedback (comments and pins) |
| The gate: re-check the fingerprint, then `POST /live` with the site key | Verifying and parsing webhooks into one shared event format |
| The audit log (a DA sheet), "seal broken" handling, the setup checker | Cancelling a round; a health check of the tool's credentials |
| Secrets: the site publish key, and how each adapter's credentials are stored | Mapping the tool's decision names to the shared ones |

The panel **never talks to a proofing tool directly**. It talks only to the APS backend, so tool credentials never reach the browser.

## 2. Data model (shared across tools)

```js
/** Seal: one page version that was sent for review */
{ sealId, org, site, path, previewUrl,
  contentHash,            // sha256 of the previewed .md
  previewLastModified,    // from admin /status
  round, createdBy, createdAt,
  state: 'in-review' | 'changes' | 'approved' | 'published' | 'broken' | 'withdrawn' }

/** Round: one proof version in the proofing tool, for one seal */
{ roundId, sealId, provider, providerRef, reviewerUrl, source: 'url' | 'snapshot',
  decision: Decision, reviewers: [{ name, email, external, decision, at }], updatedAt }

/** Decision, the shared names that every tool's decisions map to */
'pending' | 'approved' | 'approved_with_changes' | 'changes_required' | 'rejected' | 'cancelled'

/** Feedback item */
{ id, author: { name, email, external }, body, createdAt, resolved,
  anchor?: { kind: 'region' | 'text', x, y, w, h, viewport, pageUrl, quote },
  thumbnailUrl? }

/** Event, built from a tool's webhook */
{ type: 'decision' | 'feedback' | 'status', providerRef, decision?, actor?, at, raw }
```

## 3. The adapter contract (six methods plus capabilities)

```js
/**
 * @typedef {object} ProofProvider
 * @property {string} id                       'ziflow' | 'sandbox' | …
 * @property {Capabilities} capabilities
 * @property {(req: CreateRound) => Promise<{providerRef, reviewerUrl, decision}>} createRound
 * @property {(providerRef) => Promise<{decision, reviewers, updatedAt}>}            getRound
 * @property {(providerRef, {since}) => Promise<Feedback[]>}                         listFeedback
 * @property {(request: Request) => Promise<Event|null>}                             parseWebhook   // verifies the signature first; returns null when invalid
 * @property {(providerRef, reason) => Promise<void>}                                cancelRound
 * @property {() => Promise<{ok, detail}>}                                           health
 *
 * @typedef {object} Capabilities
 * { liveUrl, snapshot, stages, externalReviewers, pinnedFeedback, webhooks, versions }
 *
 * @typedef {object} CreateRound
 * { seal, source: { kind: 'url', url } | { kind: 'snapshot', url, file },
 *   reviewers: [{ email, role: 'approver' | 'reviewer' }], stages?, previousRound? }
 */
```

Rules that every adapter must follow:
1. **Never publish, and never read or write site content.** Only the core gate publishes.
2. **Keep a tool's decision names inside the adapter.** Return only the shared `Decision` values.
3. **Make `parseWebhook` safe to run twice**, and make it reject anything it cannot verify.
4. **Prefer a new version of an existing proof** (`previousRound`) when the tool supports versions, so reviewers see one history thread.
5. **Report capabilities honestly.** The core uses them to choose a URL or a snapshot source and to show or hide UI.

## 4. Policy (shared across tools)

| Decision | Default policy |
|---|---|
| `approved` (final, all required stages) | **Publishable.** The gate re-checks the fingerprint, then publishes. |
| `approved_with_changes` | **Not publishable** by default: the content has to change, so a new round is needed. A site can turn on `minorChangesAllowed` to publish after the author's fix, with an approver acknowledgement. |
| `changes_required` / `rejected` | The seal moves to `changes`, and the panel shows the feedback. |
| `cancelled` | The seal is withdrawn. |
| Any decision on a fingerprint that has since changed | The seal is **broken**. The change is logged, and a new round is required. |

Per-site configuration lives in a DA config sheet named `proof-seal`. Its keys are `provider`, `defaultReviewers`, `stages`, `gatedPaths`, `autoPublish` (default true), `minorChangesAllowed` and `notify` (optional Slack or Teams webhook).

## 5. Flow

```
Panel ──POST /rounds {path} + IMS token──▶ Core: saveDocument done by panel → POST preview (user) →
                                             fingerprint → provider.createRound → store seal + round
Provider ──webhook──▶ Core: provider.parseWebhook → Event → policy →
                       approved? re-fingerprint → match? POST /live (site key) → audit → notify
                                               → mismatch? seal = broken → provider.cancelRound → audit
Panel ──GET /seals/{path}──▶ seal, rounds, decisions, provider.listFeedback (cached)
```

Panel ↔ backend API: `POST /rounds`, `GET /seals/{path}`, `GET /rounds/{id}/feedback`, `POST /rounds/{id}/withdraw`, `GET /health`.
Auth: the user's IMS token is checked by calling the site's admin `/status` with it. The token is never stored.

## 6. Decision and capability mapping by tool

| | Ziflow (**build**) | Sandbox (**build**) | PageProof | Filestage | Workfront Proof (legacy) | Workfront Unified Review & Approval |
|---|---|---|---|---|---|---|
| Source | live URL or snapshot (per the docs) | URL | HTML or live URL | live website | `Hash=web` (snapshot) or `web-interactive` (live) | **snapshot only** (no URL proofing today, per #ask-wf-frame) |
| Decisions → shared | Approved / Approved with changes / Changes required / Not relevant → approved / approved_with_changes / changes_required / cancelled | buttons emit the shared values directly | to verify | to verify | to verify (`makeProofDecision` exists; values not yet read) | Approval Stage Participant `decision`, values to verify |
| Events | webhooks (signature key) | in-process | webhooks (signing secret, Teams Plus or above) | webhooks | event subscription on **Proof Approval** (one 2023 report of missing update events) | event subscriptions **Approval / Stage / Participant** |
| Auth | API key (backend) | none | SDK (end-to-end encrypted) | API key | Proof SOAP session from an integration user's authToken | Adobe server-to-server credentials |
| Eligible for the challenge | ✅ | demo aid | ✅ | ✅ | ❌ Adobe | ❌ Adobe |

## 7. Conformance kit (how the seam stays honest)

One shared test suite runs against every adapter, with recorded HTTP fixtures:
1. `createRound` returns a `providerRef` and a reviewer URL.
2. Every decision the tool can produce maps to a shared `Decision`; unknown values throw.
3. `parseWebhook` rejects a bad signature, accepts a replayed event without harm, and returns the shared event format.
4. `health` fails clearly when credentials are missing.

The Sandbox adapter passes the kit with no network access, which also makes it the basis for the core's end-to-end test: approve, then the fingerprint matches, then publish is called. A second scenario covers an edit after approval: the seal breaks and publish is not called.

## 8. Naming note

"Adobe Proof Seal" works as an internal name. In the **public repo and README**, consider **Proof Seal for Experience Workspace**, with APS as the short form. Names of the form "Adobe <X>" usually need brand approval, and the entry's whole point is being a third-party integration. Worth a quick check with the organisers.
