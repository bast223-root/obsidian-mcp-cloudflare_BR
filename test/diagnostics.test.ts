import { describe, expect, it } from "vitest";
import {
  type ConnLike,
  decodeRequestIdsFromHeader,
  extractRequestIds,
  findCollidingRequestIds,
} from "../src/mcp/diagnostics";

describe("extractRequestIds", () => {
  it("returns ids only for JSON-RPC requests (method + id)", () => {
    const payload = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
      { jsonrpc: "2.0", id: "abc", method: "tools/list" },
    ];
    expect(extractRequestIds(payload)).toEqual([1, "abc"]);
  });

  it("accepts a single (non-array) message object", () => {
    expect(extractRequestIds({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual([7]);
  });

  it("ignores notifications (no id) and responses (no method)", () => {
    const payload = [
      { jsonrpc: "2.0", method: "notifications/initialized" }, // notification
      { jsonrpc: "2.0", id: 2, result: {} }, // response
      { jsonrpc: "2.0", id: 3, method: "tools/call" }, // request
    ];
    expect(extractRequestIds(payload)).toEqual([3]);
  });

  it("returns [] for garbage / non-conforming input", () => {
    expect(extractRequestIds(null)).toEqual([]);
    expect(extractRequestIds("nope")).toEqual([]);
    expect(extractRequestIds([42, { id: 1 } /* no method */])).toEqual([]);
  });
});

describe("findCollidingRequestIds", () => {
  const conns = (entries: ConnLike[]): Iterable<ConnLike> => entries;

  it("returns [] when no other connection shares an incoming id", () => {
    const open = conns([{ id: "c1", state: { requestIds: [1, 2] } }]);
    expect(findCollidingRequestIds([3, 4], "c2", open)).toEqual([]);
  });

  it("flags an incoming id already in flight on another connection", () => {
    const open = conns([{ id: "c1", state: { requestIds: [1] } }]);
    // The bleed trigger: connection c2 arrives with id 1 while c1 still holds it.
    expect(findCollidingRequestIds([1], "c2", open)).toEqual([1]);
  });

  it("excludes the connection's own id from the scan", () => {
    const open = conns([{ id: "c1", state: { requestIds: [1] } }]);
    expect(findCollidingRequestIds([1], "c1", open)).toEqual([]);
  });

  it("dedupes a collision seen across multiple connections", () => {
    const open = conns([
      { id: "c1", state: { requestIds: [1] } },
      { id: "c2", state: { requestIds: [1, 9] } },
    ]);
    expect(findCollidingRequestIds([1], "c3", open)).toEqual([1]);
  });

  it("tolerates connections with missing/empty state", () => {
    const open = conns([{ id: "c1" }, { id: "c2", state: null }]);
    expect(findCollidingRequestIds([1], "c3", open)).toEqual([]);
  });
});

describe("decodeRequestIdsFromHeader", () => {
  const encode = (value: unknown): string => {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };

  it("decodes a base64 UTF-8 JSON-RPC payload to its request ids", () => {
    const header = encode([{ jsonrpc: "2.0", id: 5, method: "tools/call" }]);
    expect(decodeRequestIdsFromHeader(header)).toEqual([5]);
  });

  it("round-trips a payload containing multibyte UTF-8 (non-ASCII note path)", () => {
    const header = encode([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { path: "Notas/café—señor.md" } },
    ]);
    expect(decodeRequestIdsFromHeader(header)).toEqual([1]);
  });

  it("returns [] for a null header or undecodable garbage", () => {
    expect(decodeRequestIdsFromHeader(null)).toEqual([]);
    expect(decodeRequestIdsFromHeader("!!!not base64 json!!!")).toEqual([]);
  });
});
