/**
 * The fixture provider: a local HTTP server that exists only so proofs and
 * examples have a counterparty behind an endpoint.
 *
 * It is deliberately not a provider adapter and not a vendor integration.
 * Airlock ships contracts, dispatch classes, and tool-definition v2; the whole
 * provider surface from Airlock's side is the endpoint selectors a supervisor
 * grants and the HTTP dispatches `Outbox.commit` performs. This file is the
 * smallest thing that can sit on the far side of that boundary, so a proof can
 * observe a real request and a real response without any vendor in-tree.
 *
 * It binds an ephemeral port and reports its own origin: nothing checked in
 * ever hardcodes a host, which is also why the example definition takes its
 * endpoint as an input rather than baking one.
 */

export interface FixtureRequestRecord {
  readonly method: string
  readonly path: string
  readonly headerNames: ReadonlyArray<string>
}

export interface FixtureEndpointProvider {
  /** `http://127.0.0.1:<port>` — the origin every selector in a proof is built from. */
  readonly origin: string
  /** Every request the provider observed, in arrival order. */
  readonly requests: ReadonlyArray<FixtureRequestRecord>
  readonly stop: () => Promise<void>
}

/** Bytes the oversized route emits — comfortably past any bounded capture. */
export const FIXTURE_LARGE_RESPONSE_BYTES = 200_000

export const startFixtureEndpointProvider = async (): Promise<
  FixtureEndpointProvider
> => {
  const requests: Array<FixtureRequestRecord> = []
  let reads = 0

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        path: url.pathname,
        headerNames: [...request.headers.keys()].sort()
      })
      // GET /v1/status — the idempotent observation a supervisor can class
      // `read`. It changes a counter only so a proof can see it was really
      // reached, never so the route becomes stateful for the caller.
      if (request.method === "GET" && url.pathname === "/v1/status") {
        reads += 1
        return Response.json({ state: "green", reads })
      }
      // GET /v1/large — same class, a response far past the capture bound.
      if (request.method === "GET" && url.pathname === "/v1/large") {
        return new Response("x".repeat(FIXTURE_LARGE_RESPONSE_BYTES), {
          headers: { "content-type": "text/plain; charset=utf-8" }
        })
      }
      // POST /v1/tasks — a mutation. Present so a proof can show that a
      // mutating footprint is never auto-committed.
      if (request.method === "POST" && url.pathname === "/v1/tasks") {
        return Response.json({ created: true }, { status: 201 })
      }
      // GET /internal/audit — reachable, but nothing a proof's policy grants.
      if (request.method === "GET" && url.pathname === "/internal/audit") {
        return Response.json({ entries: [] })
      }
      return new Response("not found", { status: 404 })
    }
  })

  return {
    origin: `http://127.0.0.1:${server.port}`,
    requests,
    stop: async () => {
      await server.stop(true)
    }
  }
}
