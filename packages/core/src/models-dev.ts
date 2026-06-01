import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "./global"
import { Flag } from "./flag/flag"
import { AppFileSystem } from "./filesystem"
import { EventV2 } from "./event"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const CostTier = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tier: Schema.Struct({
    type: Schema.Literal("context"),
    size: Schema.Finite,
  }),
})

const Cost = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cache_read: Schema.optional(Schema.Finite),
  cache_write: Schema.optional(Schema.Finite),
  tiers: Schema.optional(Schema.Array(CostTier)),
  context_over_200k: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
    }),
  ),
})

export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  temperature: Schema.Boolean,
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(Cost),
  limit: Schema.Struct({
    context: Schema.Finite,
    input: Schema.optional(Schema.Finite),
    output: Schema.Finite,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
      output: Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(Cost),
            provider: Schema.optional(
              Schema.Struct({
                body: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
                headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
              }),
            ),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
})
export type Model = Schema.Schema.Type<typeof Model>

export const Provider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, Model),
})

export type Provider = Schema.Schema.Type<typeof Provider>

export const Event = {
  Refreshed: EventV2.define({
    type: "models-dev.refreshed",
    schema: {},
  }),
}

declare const OPENCODE_MODELS_DEV: Record<string, Provider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<Record<string, Provider>>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

// The github-copilot provider this build is locked to. Copilot's real model
// list is fetched live from the Copilot API by the copilot auth plugin and
// attaches onto this scaffold, so an empty `models` map here is correct. It is
// the last-resort source when neither a local on-disk catalog nor a compiled-in
// snapshot is present (e.g. `bun dev`), so the agent always has Copilot.
const COPILOT_ID = "github-copilot"
const COPILOT_FALLBACK: Provider = {
  id: COPILOT_ID,
  name: "GitHub Copilot",
  env: [],
  npm: "@ai-sdk/github-copilot",
  api: "https://api.githubcopilot.com",
  models: {},
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    // ‹Agent› hardening: the models.dev catalog fetch (https://models.dev/api.json)
    // is removed entirely — there is NO runtime egress to models.dev: no HTTP
    // fetch, no scheduled refresh. The catalog is sourced only from local data:
    // an on-disk catalog (OPENCODE_MODELS_PATH / cache file, never written from
    // the network in this build) or the build-time compiled-in snapshot
    // (OPENCODE_MODELS_DEV), falling back to a minimal github-copilot scaffold.
    // Copilot-only *usage* is enforced separately by the provider allowlist in
    // provider.ts; this layer only guarantees the catalog never phones home.
    const diskPath = Flag.OPENCODE_MODELS_PATH ?? path.join(Global.Path.cache, "models.json")

    const loadFromDisk = fs.readJson(diskPath).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
      Effect.map((v) => v as Record<string, Provider> | undefined),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof OPENCODE_MODELS_DEV === "undefined" ? undefined : OPENCODE_MODELS_DEV,
    )

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return fromDisk
      const snapshot = yield* loadSnapshot
      if (snapshot) return snapshot
      return { [COPILOT_ID]: COPILOT_FALLBACK }
    }).pipe(Effect.orDie)

    const cachedGet = yield* Effect.cached(populate)

    const get = (): Effect.Effect<Record<string, Provider>> => cachedGet

    // No remote catalog in this build, so refreshing is a no-op.
    const refresh = (_force = false): Effect.Effect<void> => Effect.void

    return Service.of({ get, refresh })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer))

export * as ModelsDev from "./models-dev"
