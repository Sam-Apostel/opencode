# PATCHES.md — `‹Agent›` fork divergence from upstream `opencode`

This file is the **rebase checklist** for the hardened Copilot-agent fork
(Product A / `‹Agent›` in the platform handoff). It lists every upstream file
this fork modifies and why. When rebasing onto a new upstream tag, re-verify
each entry against the new code (line numbers drift; symbol names are stable).

**Governing principle:** *fork to subtract.* We only edit upstream files to
**remove capabilities** and **close the egress boundary**. Everything additive
(branding, ADO tickets, knowledge, Atlas) is built as new modules/MCP/config,
not edits here, to keep the rebase tax survivable.

All paths are under `packages/opencode/src/`.

---

## Phase 2 — agent hardening (this pass): remove first-party remote surfaces

The goal is that the ban-triggering "phone-home" capabilities are **not in the
binary**, independent of the network allowlist (which is the separate, primary
guarantee enforced outside this repo).

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | `share/share-next.ts` | `disabled` is now a hard `const disabled: boolean = true` instead of reading `OPENCODE_DISABLE_SHARE`. | Permanently disables session sharing. Skips all event subscribers and short-circuits every network path (create/flush/sync/remove) to the share server (`opncd.ai` / console). Service + layer kept intact so the Effect dependency graph still resolves for all callers. |
| 2 | `server/routes/instance/httpapi/handlers/session.ts` | `share` / `unshare` handlers no longer call `shareSvc`; they return the session unchanged. | Removes the share capability at the HTTP API boundary. Routes stay registered so the API contract/types are unchanged for clients. |
| 3 | `server/shared/ui.ts` | Removed the `https://app.opencode.ai` web-UI reverse-proxy fallback (`UI_UPSTREAM`, `upstreamURL`, proxy helpers). `serveUIEffect` now serves only the build-time embedded UI and returns 404 otherwise. | We do not serve opencode's hosted web UI; this removes an outbound proxy path to opencode's servers. |
| 4 | `installation/index.ts` | `latest()` returns the installed `InstallationVersion` (no brew/npm/GitHub/chocolatey/scoop queries). `upgrade()` returns a typed `UpgradeFailedError` (no package-manager exec). `upgradeCurl()` no longer fetches+pipes `https://opencode.ai/install`. | Distribution/updates come from the **internal feed**, not opencode's public release channels. Removes all updater egress + the curl-to-bash installer. |
| 5 | `server/routes/instance/httpapi/handlers/global.ts` | `/global/upgrade` route returns a `403 disabled` response and no longer binds/uses the `Installation` service. | Defense-in-depth: in-app self-upgrade is disabled at the route, not just the service. |
| 6 | `cli/cmd/import.ts` | `opencode import <url>` (remote share import) is disabled; only local JSON file import remains. Removed the raw `fetch()` to share servers and the `ShareNext` dependency. | The remote-import path is the read-side of the share feature and the last live caller of `ShareNext.url()/request()`; removing it eliminates an arbitrary-URL `fetch()` egress. |

### KEPT — do not strip (the Copilot data path)
- `plugin/github-copilot/copilot.ts` — host logic (`api.githubcopilot.com` /
  `copilot-api.{enterprise}`), enterprise URL config. This is the sanctioned
  inference route and the whole reason `‹Agent›` exists.
- `provider/provider.ts` `BUNDLED_PROVIDERS` `@ai-sdk/github-copilot` entry and
  `github-copilot*` routing.

### Acknowledged but NOT changed in this pass (intentional / follow-up)
- **OpenTelemetry** (`config/config.ts` `experimental.openTelemetry`): off by
  default, opt-in, and only exports to a configured OTLP collector. Left as-is;
  point it at our collector via config if/when we want agent telemetry. No
  uncontrolled egress in the default build.
- **Dead installer helpers** left in `installation/index.ts` after the body
  rewrites (`run`, `getBrewFormula`, the release-response schemas, `http`/
  `httpOk`): retained so the layer's `HttpClient` requirement still matches its
  explicit type annotation. They contain **no external URLs** (verified) and are
  unreachable. A lint-only cleanup pass can remove them later; not a security
  concern.

---

## Phase 2.5 — Copilot-only provider lock + models.dev egress cut

Locks the agent to GitHub Copilot. Three enforcement layers + a catalog-egress cut.

| # | File | Change | Why |
|---|------|--------|-----|
| 7 | `provider/provider.ts` — `isProviderAllowed` | Authoritative gate now allows **only** `github-copilot*` providers **and** providers explicitly declared in `cfg.provider` (operator-configured, e.g. a sanctioned internal OpenAI-compatible gateway). Every auto-loaded / catalog / branded provider (anthropic, openai, google, bedrock, azure, xai, …) is blocked regardless of `enabled_providers`/`disabled_providers` or env API keys. | Code-enforced Copilot-only usage that config/env cannot bypass. The final provider set is filtered through this gate (`provider.ts` ~line 1487). |
| 8 | `provider/provider.ts` — `BUNDLED_PROVIDERS` | Trimmed to three SDK loaders: `@ai-sdk/github-copilot` (Copilot), `@ai-sdk/anthropic` (Copilot's `/v1/messages` shim — see `plugin/github-copilot/models.ts`, models tagged npm `@ai-sdk/anthropic`), and `@ai-sdk/openai-compatible` (generic base for the Copilot foundation + operator-config providers). All branded loaders removed → their packages are never imported. | "Not in the binary" for branded providers. |
| 9 | `plugin/index.ts` — `internalPlugins` | Returns only `CopilotAuthPlugin`. Removed Codex/OpenAI, GitLab, Poe, Cloudflare (×2), Azure, DigitalOcean, xAI auth plugins + their imports. | No login flow / endpoint for any non-Copilot provider exists in the build. |
| 10 | `packages/core/src/models-dev.ts` | **Removed the `https://models.dev/api.json` fetch + scheduled refresh + Flock + HTTP client entirely.** Catalog now sourced only from local data (on-disk `OPENCODE_MODELS_PATH`/cache, or the build-time `OPENCODE_MODELS_DEV` snapshot), falling back to a minimal `github-copilot` scaffold; `refresh()` is a no-op. | Cuts the off-allowlist models.dev egress. Copilot's real model list is fetched live from the Copilot API by the auth plugin and attaches onto the scaffold (empty `models` map is correct). Copilot-only *usage* is enforced by the gate above, not by filtering the catalog (keeps the catalog usable for tests/local config). |

### KEPT
- `@ai-sdk/openai-compatible` SDK loader (generic; not a branded provider).
- The core `plugin/provider/*.ts` transform modules (llmgateway/openrouter/nvidia/…)
  are untouched — they're inert without a corresponding allowed provider, and
  their unit tests still pass. Optional further cleanup, not required.

### Test-suite impact (this is the "fix tests" half)
A strong Copilot-only lock invalidates opencode's multi-provider test suite. Changes made so CI is green:
- **Deleted** wholly-obsolete branded-provider test files: `test/provider/{digitalocean,amazon-bedrock,gitlab-duo,cf-ai-gateway-e2e}.test.ts`.
- **`.skip`** on individual cases that exercise removed behavior (branded providers / share / updater / UI proxy), with the rest of each file intact:
  `test/provider/provider.test.ts` (catalog/branded/Google-Vertex/opencode-loader cases), `test/provider/header-timeout.test.ts` (OpenAI), `test/server/httpapi-provider.test.ts`, `test/session/llm.test.ts` (OpenAI responses), plus the Phase-2 fallout: `test/share/share-next.test.ts` (4), `test/server/httpapi-ui.test.ts` (proxy, 6), `test/server/httpapi-global.test.ts` (upgrade), and `describe.skip` for `test/installation/installation.test.ts` (`latest`/`upgrade`) and `test/session/llm-native-recorded.test.ts` (branded replay scenarios).
- Rewrote `packages/core/test/models.test.ts` to assert the no-egress contract (mock HttpClient is never called) instead of the old fetch/cache behavior.
- **Pre-existing/unrelated failures in this sandbox (NOT caused by these changes, left as-is):** `tool.write > throws error when OS denies write access` (runs as root), `HttpApi Server.listen > … does not emit Effect HTTP response logs`, and `continues loading tui config when legacy source cannot be stripped`. Verified they fail with these changes stashed.

---

## Rebase procedure
1. `git fetch upstream && git rebase <chosen upstream tag>`.
2. For each row above, confirm the upstream symbol still exists and re-apply the
   subtraction. If upstream changed the shape of a stripped surface, prefer
   re-deriving the minimal subtraction over force-keeping our hunk.
3. Re-run the egress capture (logging forward-proxy, exercise every flow) and the
   egress-allowlist CI guard — that, not this file, is the binding guarantee.
4. Grep the tree for residual upstream hostnames as a smoke check:
   `opencode.ai`, `app.opencode.ai`, `opncd.ai`, `formulae.brew.sh`,
   `api.github.com/repos/anomalyco`, `community.chocolatey.org`.
