import { describe, expect, it } from "vitest";
import { extractFailureFields } from "../src/mcp/instrument";

describe("extractFailureFields", () => {
  it("pulls reason + context from a failure response body", () => {
    const res = {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: false, reason: "anchor_not_found", path: "n.md", count: 3 }) }],
      isError: true,
    };
    expect(extractFailureFields(res)).toEqual({ reason: "anchor_not_found", path: "n.md", count: 3 });
  });

  it("returns empty when the response is a plain text success", () => {
    const res = { content: [{ type: "text" as const, text: "updated n.md" }] };
    expect(extractFailureFields(res)).toEqual({});
  });

  it("returns empty when content is missing", () => {
    expect(extractFailureFields({ content: [] })).toEqual({});
  });

  it("returns empty when JSON is malformed", () => {
    const res = { content: [{ type: "text" as const, text: "{not json" }], isError: true };
    expect(extractFailureFields(res)).toEqual({});
  });
});
