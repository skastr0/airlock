/**
 * The test Worker. It is bundled and run inside real workerd by
 * `test/cloud-durable.test.ts`; nothing here runs in the test process.
 *
 * One Durable Object class serves every route. Each conformance test runs in
 * its own object, so it has its own SQLite database, and reaches the adapters
 * only through `ctx.storage`.
 */
import { Effect, Layer, type Scope } from "effect"
import { durableLedger, durableOutboxStore, type DurableStorage } from "../../src/cloud/index.ts"
import {
  defineOutbox,
  DispatchProvenance,
  type EmissionId,
  IdempotencyKey,
  WebCrypto
} from "../../src/core/index.ts"
import {
  exampleContracts,
  ledgerConformance,
  outboxConformance,
  outboxStoreConformance,
  type Runner,
  runWorkedExample
} from "../../src/core/testing/index.ts"

interface ObjectState {
  readonly storage: DurableStorage
}
interface Stub {
  fetch(request: Request): Promise<Response>
}
interface Namespace {
  idFromName(name: string): unknown
  get(id: unknown): Stub
}
interface Env {
  readonly CONFORMANCE: Namespace
}

type Test = { readonly name: string; readonly body: () => Effect.Effect<void, unknown, Scope.Scope> }

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

/** A world over this object's database. Asking for a world again starts from an empty one. */
const worlds = (storage: DurableStorage) => {
  const fresh = () => {
    storage.sql.exec("DROP TABLE IF EXISTS airlock_emission")
    storage.sql.exec("DROP TABLE IF EXISTS airlock_ledger")
  }
  // What a hostile or failing writer could do to the rows.
  const faults = {
    corruptRecord: (id: EmissionId) =>
      Effect.sync(() => void storage.sql.exec("UPDATE airlock_emission SET record = '{not json' WHERE id = ?", id)),
    tamperDispatch: (id: EmissionId) =>
      Effect.sync(() =>
        void storage.sql.exec("UPDATE airlock_emission SET dispatch = dispatch || ' ' WHERE id = ?", id))
  }
  return {
    store: Effect.sync(() => {
      fresh()
      return { store: durableOutboxStore(storage), ...faults }
    }),
    ledger: Effect.sync(() => {
      fresh()
      return { ledger: durableLedger(storage) }
    }),
    outbox: Effect.sync(() => {
      fresh()
      return {
        store: durableOutboxStore(storage),
        ledger: durableLedger(storage),
        crypto: WebCrypto.layer,
        ...faults
      }
    })
  }
}

/** Collects the suites' tests instead of running them, so each can be run by name. */
const collect = (storage: DurableStorage): ReadonlyArray<Test> => {
  const tests: Array<Test> = []
  const path: Array<string> = []
  const runner: Runner = {
    describe: (name, body) => {
      path.push(name)
      body()
      path.pop()
    },
    test: (name, body) => void tests.push({ name: [...path, name].join(" > "), body })
  }
  const world = worlds(storage)
  outboxStoreConformance(runner, "Durable Object SQLite", world.store)
  ledgerConformance(runner, "Durable Object SQLite", world.ledger)
  outboxConformance(runner, "Durable Object SQLite", world.outbox)
  return tests
}

// ── a recorded read, split across two workerd processes ─────────────────────

const mail = defineOutbox(exampleContracts)
/** Module state: it is lost when the process ends, which is how a restart is observed. */
let dispatchedInThisProcess = 0
const encoder = new TextEncoder()
const handlers = Layer.succeed(mail.Dispatcher, {
  "mail.list": () =>
    Effect.sync(() => {
      dispatchedInThisProcess += 1
      return {
        outcome: { ids: [`listed-${crypto.randomUUID()}`] },
        response: encoder.encode(`bytes-${crypto.randomUUID()}`),
        truncated: false
      }
    }),
  "mail.send": () => Effect.die("unused"),
  "label.add": () => Effect.die("unused"),
  "label.remove": () => Effect.die("unused")
})

const recordedRead = (storage: DurableStorage) =>
  Effect.gen(function* () {
    const outbox = yield* mail.Outbox
    const performed = yield* outbox.perform(
      {
        key: IdempotencyKey.make("restart-proof/read-1"),
        intent: { kind: "mail.list", dispatch: { mailbox: "inbox", query: "is:unread" } },
        holdMillis: 0
      },
      new DispatchProvenance({ committedBy: "policy-auto", dispatchClass: "read" })
    )
    return {
      id: performed.emission.id,
      ids: performed.emission.outcome.ids,
      response: new TextDecoder().decode(performed.response),
      dispatchedInThisProcess
    }
  }).pipe(
    Effect.provide(
      mail.layer.pipe(
        Layer.provide(
          Layer.mergeAll(durableOutboxStore(storage), durableLedger(storage), WebCrypto.layer, handlers)
        )
      )
    )
  )

export class ConformanceObject {
  constructor(private readonly state: ObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const storage = this.state.storage
    try {
      if (url.pathname === "/tests") return json(collect(storage).map((test) => test.name))
      if (url.pathname === "/run") {
        const test = collect(storage)[Number(url.searchParams.get("index"))]
        if (test === undefined) return json({ ok: false, error: "no such test" }, 404)
        return await Effect.runPromise(Effect.scoped(test.body())).then(
          () => json({ ok: true, name: test.name }),
          (error: unknown) => json({ ok: false, name: test.name, error: String(error) })
        )
      }
      if (url.pathname === "/worked-example") {
        const adapters = {
          store: durableOutboxStore(storage),
          ledger: durableLedger(storage),
          crypto: WebCrypto.layer
        }
        return json(await Effect.runPromise(runWorkedExample(adapters)))
      }
      if (url.pathname === "/recorded-read") return json(await Effect.runPromise(recordedRead(storage)))
      return json({ error: "unknown route" }, 404)
    } catch (error) {
      return json({ ok: false, error: String(error) }, 500)
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get("object") ?? "default"
    return env.CONFORMANCE.get(env.CONFORMANCE.idFromName(name)).fetch(request)
  }
}
