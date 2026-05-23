import { describe, expect, it } from "vitest";
import { mapPool } from "../src/vault/concurrency";

describe("mapPool", () => {
  it("preserves input order in the output array", async () => {
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("never runs more than `limit` tasks in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapPool(items, 4, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  it("handles an empty input array", async () => {
    const out = await mapPool<number, number>([], 4, async (n) => n);
    expect(out).toEqual([]);
  });
});
