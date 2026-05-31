export type Period = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export const PERIODS: readonly Period[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
] as const;

interface DateParts {
  year: number; // calendar year
  month: number; // 1-12
  day: number; // 1-31
  quarter: number; // 1-4
  isoWeek: number; // 1-53
  isoWeekYear: number; // ISO-8601 week-numbering year
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * Parse a `YYYY-MM-DD` anchor into the date components used by the path tokens.
 * All arithmetic is done in UTC so the result never depends on the runtime's
 * local timezone (the Worker runs in UTC, but tests and callers should not have
 * to care). The anchor is assumed validated upstream (the tool schema enforces
 * the `^\d{4}-\d{2}-\d{2}$` shape).
 */
function dateParts(anchor: string): DateParts {
  const [y, m, d] = anchor.split("-").map((s) => Number(s));
  const utc = new Date(Date.UTC(y, m - 1, d));
  const { isoWeek, isoWeekYear } = isoWeekParts(utc);
  return {
    year: y,
    month: m,
    day: d,
    quarter: Math.floor((m - 1) / 3) + 1,
    isoWeek,
    isoWeekYear,
  };
}

/**
 * ISO-8601 week number and week-numbering year for a UTC date. Weeks start
 * Monday; week 1 is the week containing the year's first Thursday. The
 * week-year can differ from the calendar year for dates in early January or
 * late December (e.g. 2027-01-01 belongs to ISO 2026-W53).
 */
function isoWeekParts(date: Date): { isoWeek: number; isoWeekYear: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of the current ISO week (Sun=7 in ISO numbering).
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoWeekYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoWeekYear, 0, 1);
  const isoWeek = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return { isoWeek, isoWeekYear };
}

/**
 * Substitute the supported date tokens in a periodic-note path template using
 * the given `YYYY-MM-DD` anchor. The longer composite token `{{YYYY-MM-DD}}` is
 * replaced before the single-part tokens so its inner `{{...}}`-free literal is
 * not re-touched. Unknown `{{...}}` sequences are left intact.
 */
export function formatPeriodicPath(template: string, anchor: string): string {
  const p = dateParts(anchor);
  const yyyy = String(p.year);
  const mm = pad2(p.month);
  const dd = pad2(p.day);
  const replacements: [string, string][] = [
    ["{{YYYY-MM-DD}}", `${yyyy}-${mm}-${dd}`],
    ["{{GGGG}}", String(p.isoWeekYear)],
    ["{{YYYY}}", yyyy],
    ["{{MM}}", mm],
    ["{{DD}}", dd],
    ["{{WW}}", pad2(p.isoWeek)],
    ["{{Q}}", String(p.quarter)],
  ];
  let out = template;
  for (const [token, value] of replacements) {
    out = out.split(token).join(value);
  }
  return out;
}

/**
 * The default H1 heading for a freshly created periodic note, scaled to the
 * cadence: daily `2026-05-31`, weekly `2026-W22`, monthly `2026-05`, quarterly
 * `2026-Q2`, yearly `2026`.
 */
export function periodicLabel(period: Period, anchor: string): string {
  const p = dateParts(anchor);
  switch (period) {
    case "daily":
      return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    case "weekly":
      return `${p.isoWeekYear}-W${pad2(p.isoWeek)}`;
    case "monthly":
      return `${p.year}-${pad2(p.month)}`;
    case "quarterly":
      return `${p.year}-Q${p.quarter}`;
    case "yearly":
      return String(p.year);
  }
}
