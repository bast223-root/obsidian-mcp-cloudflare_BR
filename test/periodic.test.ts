import { describe, expect, test } from "vitest";
import { formatPeriodicPath, periodicLabel } from "../src/vault/periodic";

describe("formatPeriodicPath - token substitution", () => {
  test("substitutes Y/M/D parts and the daily composite", () => {
    expect(formatPeriodicPath("{{YYYY}}-{{MM}}-{{DD}}", "2026-05-31")).toBe("2026-05-31");
    expect(formatPeriodicPath("Daily/{{YYYY-MM-DD}}.md", "2026-05-31")).toBe("Daily/2026-05-31.md");
  });

  test("zero-pads month and day", () => {
    expect(formatPeriodicPath("{{YYYY}}/{{MM}}/{{DD}}", "2026-01-09")).toBe("2026/01/09");
  });

  test("quarter token", () => {
    expect(formatPeriodicPath("Q{{Q}}", "2026-01-01")).toBe("Q1");
    expect(formatPeriodicPath("Q{{Q}}", "2026-03-31")).toBe("Q1");
    expect(formatPeriodicPath("Q{{Q}}", "2026-04-01")).toBe("Q2");
    expect(formatPeriodicPath("Q{{Q}}", "2026-12-31")).toBe("Q4");
  });

  test("ISO week and week-year, including year boundaries", () => {
    // 2026-01-01 is a Thursday -> ISO 2026-W01.
    expect(formatPeriodicPath("{{GGGG}}-W{{WW}}", "2026-01-01")).toBe("2026-W01");
    // 2027-01-01 is a Friday -> ISO 2026-W53 (week-year trails calendar year).
    expect(formatPeriodicPath("{{GGGG}}-W{{WW}}", "2027-01-01")).toBe("2026-W53");
    // 2021-01-01 is a Friday -> ISO 2020-W53.
    expect(formatPeriodicPath("{{GGGG}}-W{{WW}}", "2021-01-01")).toBe("2020-W53");
  });

  test("calendar year (YYYY) and ISO week-year (GGGG) can differ", () => {
    expect(formatPeriodicPath("{{YYYY}}", "2027-01-01")).toBe("2027");
    expect(formatPeriodicPath("{{GGGG}}", "2027-01-01")).toBe("2026");
  });

  test("repeats a token that appears multiple times", () => {
    expect(formatPeriodicPath("{{YYYY}}/{{YYYY}}-{{MM}}", "2026-05-31")).toBe("2026/2026-05");
  });
});

describe("periodicLabel - default H1 per cadence", () => {
  test("formats each cadence", () => {
    expect(periodicLabel("daily", "2026-05-31")).toBe("2026-05-31");
    expect(periodicLabel("weekly", "2026-01-01")).toBe("2026-W01");
    expect(periodicLabel("monthly", "2026-05-31")).toBe("2026-05");
    expect(periodicLabel("quarterly", "2026-04-01")).toBe("2026-Q2");
    expect(periodicLabel("yearly", "2026-05-31")).toBe("2026");
  });
});
