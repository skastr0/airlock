/**
 * The test Worker. It is bundled and run inside real workerd by
 * `test/cloud-durable.test.ts`; nothing here runs in the test process.
 *
 * One Durable Object class serves every route. Each conformance test runs in
 * its own object, so it has its own SQLite database, and reaches the adapters
 * only through `ctx.storage`.
 */
import { Effect, Layer, type Scope } from "effect"
import {
  airlockClient,
  airlockDurableObject,
  AirlockError,
  durableLedger,
  durableOutboxStore,
  type DurableStorage,
  type WorkerLoader,
  workerLoaderRunner
} from "../../src/cloud/index.ts"
import {
  Admission,
  defineAirlock,
  defineOutbox,
  DispatchProvenance,
  type EmissionId,
  IdempotencyKey,
  refused,
  toolPolicy,
  WebCrypto
} from "../../src/core/index.ts"
import {
  exampleContracts,
  guestRunnerConformance,
  LabelAdd,
  LabelRemove,
  ledgerConformance,
  MailList,
  MailSend,
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
  readonly AIRLOCK: Namespace
  readonly ALARMED: Namespace
  readonly LOADER: WorkerLoader
  readonly MAIL_TOKEN: string
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
const collect = (storage: DurableStorage, loader: WorkerLoader): ReadonlyArray<Test> => {
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
  guestRunnerConformance(
    runner,
    "Worker Loader isolate",
    Effect.map(world.outbox, (adapters) => ({
      store: adapters.store,
      ledger: adapters.ledger,
      crypto: adapters.crypto,
      runner: workerLoaderRunner(loader),
      isolated: true
    }))
  )
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
  constructor(private readonly state: ObjectState, private readonly env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const storage = this.state.storage
    try {
      if (url.pathname === "/tests") return json(collect(storage, this.env.LOADER).map((test) => test.name))
      if (url.pathname === "/run") {
        const test = collect(storage, this.env.LOADER)[Number(url.searchParams.get("index"))]
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

// ── a user's Airlock, as they would write it ───────────────────────────────

/** What the remote side saw, kept in module memory so a restart is observable. */
const remote: Array<{ readonly tool: string; readonly detail: string }> = []

const userAirlock = defineAirlock({
  contracts: [MailList, MailSend, LabelAdd, LabelRemove],
  implement: {
    "mail.list": ({ mailbox }) => {
      remote.push({ tool: "mail.list", detail: mailbox })
      return { ids: [`${mailbox}-1`, `${mailbox}-2`] }
    },
    "mail.send": ({ to }, { env, idempotencyKey }: { env: Env; idempotencyKey: string }) => {
      if (env.MAIL_TOKEN === "") return refused("mail connection is not configured")
      // A provider that never answers, so a test can kill the object mid-dispatch.
      if (to === "hang@example.com") return new Promise<never>(() => {})
      remote.push({ tool: "mail.send", detail: `${to} with ${env.MAIL_TOKEN} as ${idempotencyKey}` })
      return { messageId: `sent-${remote.length}` }
    },
    "label.add": ({ label }) => {
      remote.push({ tool: "label.add", detail: label })
      return { added: true }
    },
    "label.remove": ({ label }) => {
      remote.push({ tool: "label.remove", detail: label })
      return { removed: true }
    }
  },
  policy: toolPolicy({
    budget: { maxCalls: 8, maxInputBytes: 4_096 },
    toolGrants: [
      Admission.toolGrant(MailList, { id: "read-inbox", class: "read", commit: "auto" }),
      Admission.toolGrant(MailSend, { id: "support-replies", where: { to: { endsWith: "@example.com" } } }),
      Admission.toolGrant(LabelAdd, { id: "labels", class: "mutate" })
    ]
  })
})

export const ExampleAirlock = airlockDurableObject(userAirlock, { loader: (env: Env) => env.LOADER })

/**
 * The same Airlock with a short recovery alarm, plus a way to look at the
 * stored states without opening the Airlock: opening it is itself recovery,
 * so a test of the alarm must not do that.
 */
export class AlarmedAirlock extends airlockDurableObject(userAirlock, {
  loader: (env: Env) => env.LOADER,
  recoveryAlarmMillis: 1_500
}) {
  readonly #storage: DurableStorage
  constructor(state: { readonly storage: DurableStorage }, env: Env) {
    super(state as never, env)
    this.#storage = state.storage
  }
  async fetch(): Promise<Response> {
    const rows = this.#storage.sql.exec("SELECT state FROM airlock_emission ORDER BY state").toArray()
    return json(rows.map((row) => row["state"]))
  }
}

/** The trusted side of the example, driven over HTTP by the test. */
const trusted = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url)
  const airlock = airlockClient(env.AIRLOCK, url.searchParams.get("object") ?? "default")
  const body = request.method === "POST" ? await request.json().catch(() => ({})) as Record<string, unknown> : {}
  try {
    switch (url.pathname) {
      case "/airlock/run":
        return json(await airlock.run({ runId: String(body["runId"]), source: String(body["source"]) }))
      case "/airlock/describe": return json(await airlock.describe())
      case "/airlock/pending": return json(await airlock.pending())
      case "/airlock/inspect": return json(await airlock.inspect(String(body["id"])))
      case "/airlock/commit": return json(await airlock.commit(String(body["id"])))
      case "/airlock/cancel": return json(await airlock.cancel(String(body["id"])))
      case "/airlock/compensate": return json(await airlock.compensate(String(body["id"])))
      case "/airlock/remote": return json(remote)
      default: return json({ error: "unknown route" }, 404)
    }
  } catch (error) {
    return error instanceof AirlockError
      ? json({ failed: true, code: error.code, message: error.message })
      : json({ failed: true, code: "crashed", message: String(error) }, 500)
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith("/airlock/")) return trusted(request, env)
    if (url.pathname.startsWith("/alarmed/")) {
      if (url.pathname === "/alarmed/states") return env.ALARMED.get(env.ALARMED.idFromName("alarmed")).fetch(request)
      const rewritten = new URL(request.url)
      rewritten.pathname = rewritten.pathname.replace("/alarmed/", "/airlock/")
      return trusted(new Request(rewritten.toString(), request), { ...env, AIRLOCK: env.ALARMED })
    }
    const name = url.searchParams.get("object") ?? "default"
    return env.CONFORMANCE.get(env.CONFORMANCE.idFromName(name)).fetch(request)
  }
}
