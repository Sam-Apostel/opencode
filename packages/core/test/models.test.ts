import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { EventV2 } from "@opencode-ai/core/event"
import { it } from "./lib/effect"
import { rm, writeFile, mkdir } from "fs/promises"
import path from "path"

// ‹Agent› hardening: this is a GitHub Copilot-only build. The models.dev catalog
// fetch has been removed — ModelsDev performs NO network egress. It loads the
// catalog from local data only (on-disk cache / compiled snapshot), falling back
// to a github-copilot scaffold. These tests are the regression guard for the
// no-egress property: a mock HttpClient is wired in and asserted to be NEVER
// called, across get() and refresh().
const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
beforeAll(() => {
  Flag.OPENCODE_MODELS_PATH = undefined
})
afterAll(() => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
})

const cacheFile = path.join(Global.Path.cache, "models.json")

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

interface MockState {
  calls: Array<{ url: string }>
}

const makeMockClient = (state: Ref.Ref<MockState>) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(state, (s) => ({ calls: [...s.calls, { url: request.url }] }))
      return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))
    }),
  )

const buildLayer = (state: Ref.Ref<MockState>) =>
  // Layer.fresh: ModelsDev.layer is a module-level constant and Effect.provide
  // uses a process-global MemoMap, so without fresh every test reuses the first
  // run's cached catalog.
  Layer.fresh(ModelsDev.layer).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, makeMockClient(state))),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(EventV2.defaultLayer),
  )

const writeCache = (data: object) =>
  Effect.promise(async () => {
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(cacheFile, JSON.stringify(data))
  })

const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  eff.pipe(Effect.provide(buildLayer(state)))

beforeEach(async () => {
  await rm(cacheFile, { force: true })
})

afterAll(async () => {
  await rm(cacheFile, { force: true })
})

describe("ModelsDev Service (Copilot-only, no egress)", () => {
  it.live("get() returns the on-disk catalog without any network access", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make<MockState>({ calls: [] })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() falls back to a github-copilot scaffold when no local catalog exists, no network", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make<MockState>({ calls: [] })
      const result = yield* provided(
        state,
        ModelsDev.Service.use((s) => s.get()),
      )
      expect(Object.keys(result)).toEqual(["github-copilot"])
      expect(result["github-copilot"]?.id).toBe("github-copilot")
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() is single-flight/cached across concurrent calls and never hits the network", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make<MockState>({ calls: [] })
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get()], { concurrency: "unbounded" })
        }),
      )
      for (const result of results) expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("refresh(true) is a no-op and makes no network calls", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make<MockState>({ calls: [] })
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(after).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )
})
