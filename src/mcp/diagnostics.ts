// Read-only diagnostics for the read_note cross-request payload-bleed bug
// (see AIHandoff/bug-read-note-cross-request-payload-bleed in the vault).
//
// Root cause lives in the `agents` SDK streamable-HTTP transport, NOT in this
// repo: `StreamableHTTPServerTransport.send()` routes each JSON-RPC response to
// a connection by FIRST match on request id
// (`getConnections().find(c => c.state.requestIds.includes(id))`). That is only
// safe while request ids are unique within the MCP session. If two concurrent
// in-flight requests on one session carry the same id, a response can be written
// to the wrong connection's stream — e.g. one read_note returning another
// concurrent read_note's body. Verified unchanged through agents@0.13.3, so this
// cannot be fixed by an upgrade and there is no honest fix in read_note itself.
//
// These helpers let `ObsidianMCP.onConnect` detect and log the precise trigger
// condition (a request id arriving on a new connection that is already in flight
// on another connection of the same session) so the next real occurrence is
// captured in observability instead of inferred. Pure and side-effect-free; the
// agent wires them behind a try/catch so a diagnostic failure can never break a
// connection.

export type JsonRpcId = string | number;

/**
 * Minimal structural view of an open connection for collision scanning. Matches
 * the SDK's `Connection.state.requestIds` — the same field its router keys on.
 */
export interface ConnLike {
  id: string;
  state?: { requestIds?: readonly JsonRpcId[] } | null;
}

/**
 * Extract the JSON-RPC request ids from a decoded streamable-HTTP POST payload.
 * Mirrors the SDK's own `messages.filter(isJSONRPCRequest).map(m => m.id)`: a
 * request carries both a string `method` and an `id` (string or number).
 * Notifications (no id) and responses (no method) are ignored, as are
 * non-conforming inputs — this never throws.
 */
export function extractRequestIds(payload: unknown): JsonRpcId[] {
  const arr = Array.isArray(payload) ? payload : [payload];
  const ids: JsonRpcId[] = [];
  for (const m of arr) {
    if (m && typeof m === "object") {
      const msg = m as { id?: unknown; method?: unknown };
      const isRequest =
        typeof msg.method === "string" &&
        (typeof msg.id === "string" || typeof msg.id === "number");
      if (isRequest) ids.push(msg.id as JsonRpcId);
    }
  }
  return ids;
}

/**
 * Given the request ids arriving on a NEW connection and the set of currently
 * open connections (each stamped by the SDK with `state.requestIds`), return any
 * incoming id that is already in flight on a DIFFERENT connection of the same
 * session. A non-empty result is exactly the condition under which the SDK's
 * first-match-by-id response routing can misdeliver a response — the payload
 * bleed. The new connection itself is excluded by `selfId` (its own ids are not
 * yet registered at onConnect time, but excluding it keeps the check correct if
 * that ordering ever changes).
 */
export function findCollidingRequestIds(
  incoming: readonly JsonRpcId[],
  selfId: string,
  connections: Iterable<ConnLike>,
): JsonRpcId[] {
  const incomingSet = new Set(incoming);
  const colliding = new Set<JsonRpcId>();
  for (const conn of connections) {
    if (conn.id === selfId) continue;
    for (const id of conn.state?.requestIds ?? []) {
      if (incomingSet.has(id)) colliding.add(id);
    }
  }
  return Array.from(colliding);
}

/**
 * Decode the SDK's base64-encoded `cf-mcp-message` header (UTF-8 JSON of the
 * JSON-RPC messages array) into the request ids it carries. Worker-safe base64
 * → UTF-8 (no Node Buffer dependency). Returns [] on any decode/parse failure so
 * the caller never has to guard.
 */
export function decodeRequestIdsFromHeader(headerValue: string | null): JsonRpcId[] {
  if (!headerValue) return [];
  try {
    const bin = atob(headerValue);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return extractRequestIds(JSON.parse(json));
  } catch {
    return [];
  }
}
