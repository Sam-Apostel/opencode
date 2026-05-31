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
- **Non-Copilot providers** (anthropic/openai/google/xai/openrouter, their
  `HTTP-Referer: https://opencode.ai/` headers, and the `opencode.ai/zen|go`
  upsell links): marked *optional* removal in the handoff. They are
  **config-gated** (`disabled_providers` / `enabled_providers` in
  `config/config.ts`) and blocked by the egress allowlist regardless. Recommended
  to lock to Copilot-only via shipped default config rather than deleting
  provider code (deletion cascades through the provider registry and raises the
  rebase tax). Tracked as a config-overlay task, not an upstream edit.
- **Dead installer helpers** left in `installation/index.ts` after the body
  rewrites (`run`, `getBrewFormula`, the release-response schemas, `http`/
  `httpOk`): retained so the layer's `HttpClient` requirement still matches its
  explicit type annotation. They contain **no external URLs** (verified) and are
  unreachable. A lint-only cleanup pass can remove them later; not a security
  concern.

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
