import { describe, expect, it } from "vitest";
import type { DateRange, SniperJob } from "../types/index.js";
import {
  buildRecDateAttempts,
  computeJitteredPollInterval,
  computePermitAvailabilityQueryWindow,
  escapeRegExp,
  expandRange,
  findFirstFullyAvailableRange,
  findFirstRangeAcrossPermitDivisions,
  formatRange,
  humanDelayMs,
  resolveNightsToClickInBrowser,
  uniqueStringsPreserveOrder,
} from "./sniper-logic.js";

function trailJob(trailheadName: string): Pick<SniperJob, "trailheadName"> {
  return { trailheadName };
}

describe("expandRange", () => {
  it("returns each night from start (inclusive) to end (exclusive)", () => {
    expect(expandRange({ startDate: "2026-07-15", endDate: "2026-07-18" })).toEqual([
      "2026-07-15",
      "2026-07-16",
      "2026-07-17",
    ]);
  });

  it("returns a single night when end is next day", () => {
    expect(expandRange({ startDate: "2026-03-21", endDate: "2026-03-22" })).toEqual(["2026-03-21"]);
  });

  it("returns empty when start equals end", () => {
    expect(expandRange({ startDate: "2026-01-01", endDate: "2026-01-01" })).toEqual([]);
  });

  it("handles month boundaries in UTC", () => {
    expect(expandRange({ startDate: "2026-02-28", endDate: "2026-03-02" })).toEqual([
      "2026-02-28",
      "2026-03-01",
    ]);
  });
});

describe("resolveNightsToClickInBrowser", () => {
  const friSun: DateRange = { startDate: "2026-03-20", endDate: "2026-03-23" };

  it("production: expands full range", () => {
    expect(resolveNightsToClickInBrowser(friSun, false)).toEqual([
      "2026-03-20",
      "2026-03-21",
      "2026-03-22",
    ]);
  });

  it("visual: uses boundary dates only (start and end columns)", () => {
    expect(resolveNightsToClickInBrowser(friSun, true)).toEqual(["2026-03-20", "2026-03-23"]);
  });

  it("visual: single start when end missing or start >= end", () => {
    expect(resolveNightsToClickInBrowser({ startDate: "2026-03-20", endDate: "" }, true)).toEqual([
      "2026-03-20",
    ]);
    expect(resolveNightsToClickInBrowser({ startDate: "2026-03-20", endDate: "2026-03-20" }, true)).toEqual([
      "2026-03-20",
    ]);
  });

  it("visual: falls back to expand when startDate empty", () => {
    const r = { startDate: "", endDate: "2026-03-22" } as DateRange;
    expect(resolveNightsToClickInBrowser(r, true)).toEqual([]);
  });
});

describe("formatRange", () => {
  it("pluralizes nights", () => {
    expect(formatRange({ startDate: "2026-07-15", endDate: "2026-07-18" })).toBe(
      "2026-07-15 to 2026-07-18 (3 nights)",
    );
  });

  it("uses singular for one night", () => {
    expect(formatRange({ startDate: "2026-07-15", endDate: "2026-07-16" })).toBe(
      "2026-07-15 to 2026-07-16 (1 night)",
    );
  });

  it("shows zero nights when start equals end (degenerate range)", () => {
    expect(formatRange({ startDate: "2026-07-15", endDate: "2026-07-15" })).toBe(
      "2026-07-15 to 2026-07-15 (0 nights)",
    );
  });
});

describe("uniqueStringsPreserveOrder", () => {
  it("dedupes while keeping first occurrence order", () => {
    expect(uniqueStringsPreserveOrder(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  it("handles empty", () => {
    expect(uniqueStringsPreserveOrder([])).toEqual([]);
  });
});

describe("escapeRegExp", () => {
  it("escapes metacharacters", () => {
    expect(escapeRegExp("a+b*c?")).toBe("a\\+b\\*c\\?");
    expect(escapeRegExp("file.txt")).toBe("file\\.txt");
    expect(escapeRegExp("(trail)")).toBe("\\(trail\\)");
  });
});

describe("buildRecDateAttempts", () => {
  it("visual + trailhead: single relaxed attempt", () => {
    const a = buildRecDateAttempts(trailJob("Hand Lake"), true);
    expect(a).toHaveLength(1);
    expect(a[0].trail).toBe("Hand Lake");
    expect(a[0].requireAvailableInName).toBe(false);
    expect(a[0].recClassOnly).toBe(true);
  });

  it("visual + no trailhead: generic rec-availability attempt", () => {
    const a = buildRecDateAttempts({ trailheadName: "" }, true);
    expect(a).toHaveLength(1);
    expect(a[0].trail).toBeNull();
    expect(a[0].requireAvailableInName).toBe(false);
  });

  it("production + trailhead: strict trail, then any Available, then fallback", () => {
    const a = buildRecDateAttempts(trailJob("Seven Lakes Basin"), false);
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({
      trail: "Seven Lakes Basin",
      requireAvailableInName: true,
      recClassOnly: true,
    });
    expect(a[1]).toMatchObject({
      trail: null,
      requireAvailableInName: true,
      recClassOnly: true,
    });
    expect(a[1].label).toContain("any row");
    expect(a[2]).toMatchObject({
      trail: null,
      requireAvailableInName: false,
      recClassOnly: false,
    });
  });

  it("production + no trailhead: two attempts (first row Available, then fallback)", () => {
    const a = buildRecDateAttempts({ trailheadName: "" }, false);
    expect(a).toHaveLength(2);
    expect(a[0].label).toContain("first row");
    expect(a[0].requireAvailableInName).toBe(true);
  });

  it("rowTrailOverride empty string clears trail for matching (Olympic first column)", () => {
    const a = buildRecDateAttempts(trailJob("Ignored"), true, "");
    expect(a).toHaveLength(1);
    expect(a[0].trail).toBeNull();
  });

  it("rowTrailOverride overrides job trailhead", () => {
    const a = buildRecDateAttempts(trailJob("A"), false, "B");
    expect(a[0].trail).toBe("B");
  });

  it("trims trailheadName whitespace for production matching", () => {
    const a = buildRecDateAttempts({ trailheadName: "  Elk Lake  " }, false);
    expect(a[0].trail).toBe("Elk Lake");
    expect(a[0].label).toContain("Elk Lake");
  });

  it("treats whitespace-only trailheadName as no trailhead", () => {
    const a = buildRecDateAttempts({ trailheadName: "   \t" }, false);
    expect(a).toHaveLength(2);
    expect(a[0].label).toContain("first row");
  });
});

describe("findFirstFullyAvailableRange", () => {
  const r1: DateRange = { startDate: "2026-08-01", endDate: "2026-08-03" };
  const r2: DateRange = { startDate: "2026-08-10", endDate: "2026-08-12" };

  it("returns first range in list order when both could work", () => {
    const map = new Map<string, number>([
      ["2026-08-01", 1],
      ["2026-08-02", 1],
      ["2026-08-10", 1],
      ["2026-08-11", 1],
    ]);
    expect(findFirstFullyAvailableRange([r1, r2], map)).toEqual(r1);
  });

  it("skips range with any zero remaining", () => {
    const map = new Map<string, number>([
      ["2026-08-01", 1],
      ["2026-08-02", 0],
      ["2026-08-10", 2],
      ["2026-08-11", 2],
    ]);
    expect(findFirstFullyAvailableRange([r1, r2], map)).toEqual(r2);
  });

  it("treats missing dates as unavailable", () => {
    const map = new Map<string, number>([["2026-08-01", 1]]);
    expect(findFirstFullyAvailableRange([r1], map)).toBeNull();
  });

  it("returns null when no range fits", () => {
    expect(findFirstFullyAvailableRange([r1], new Map())).toBeNull();
  });

  it("does not treat zero-night ranges as available (avoids [].every vacuous truth)", () => {
    const degenerate: DateRange = { startDate: "2026-08-05", endDate: "2026-08-05" };
    expect(expandRange(degenerate)).toEqual([]);
    expect(findFirstFullyAvailableRange([degenerate], new Map())).toBeNull();
    expect(
      findFirstFullyAvailableRange([degenerate, r1], new Map([["2026-08-01", 1], ["2026-08-02", 1]])),
    ).toEqual(r1);
  });

  it("returns null when every range expands to zero nights", () => {
    const d: DateRange = { startDate: "2026-01-01", endDate: "2026-01-01" };
    expect(findFirstFullyAvailableRange([d, d], new Map([["2026-01-01", 99]]))).toBeNull();
  });
});

describe("findFirstRangeAcrossPermitDivisions", () => {
  const r1: DateRange = { startDate: "2026-09-01", endDate: "2026-09-03" };
  const r2: DateRange = { startDate: "2026-09-10", endDate: "2026-09-11" };

  it("uses first division that yields a match (object insertion order)", () => {
    const availability = {
      divB: {
        date_availability: {
          "2026-09-10T00:00:00Z": { remaining: 1 },
        },
      },
      divA: {
        date_availability: {
          "2026-09-01T00:00:00Z": { remaining: 1 },
          "2026-09-02T00:00:00Z": { remaining: 1 },
        },
      },
    };
    expect(findFirstRangeAcrossPermitDivisions([r1, r2], availability)).toEqual(r2);
  });

  it("returns null when no division satisfies any range", () => {
    expect(findFirstRangeAcrossPermitDivisions([r1], { x: { date_availability: {} } })).toBeNull();
  });

  it("skips a division with no usable dates and uses a later division", () => {
    const availability = {
      emptyFirst: { date_availability: {} },
      hasData: {
        date_availability: {
          "2026-09-01T12:00:00.000Z": { remaining: 3 },
          "2026-09-02T00:00:00Z": { remaining: 1 },
        },
      },
    };
    expect(findFirstRangeAcrossPermitDivisions([r1], availability)).toEqual(r1);
  });
});

describe("computePermitAvailabilityQueryWindow", () => {
  it("covers union of ranges and extends end by one calendar day", () => {
    const ranges: DateRange[] = [
      { startDate: "2026-12-01", endDate: "2026-12-05" },
      { startDate: "2026-11-28", endDate: "2026-11-30" },
    ];
    const { queryStartIso, queryEndIso } = computePermitAvailabilityQueryWindow(ranges);
    expect(queryStartIso.startsWith("2026-11-28")).toBe(true);
    expect(queryEndIso.startsWith("2026-12-06")).toBe(true);
  });

  it("throws on empty ranges (callers must pass at least one)", () => {
    expect(() => computePermitAvailabilityQueryWindow([])).toThrow(/ranges must not be empty/);
  });

  it("handles a single range", () => {
    const { queryStartIso, queryEndIso } = computePermitAvailabilityQueryWindow([
      { startDate: "2026-01-10", endDate: "2026-01-12" },
    ]);
    expect(queryStartIso.startsWith("2026-01-10")).toBe(true);
    expect(queryEndIso.startsWith("2026-01-13")).toBe(true);
  });
});

describe("computeJitteredPollInterval", () => {
  it("stays within ±30% of base for random in [0,1)", () => {
    const base = 4000;
    const jitter = base * 0.3;
    for (let i = 0; i < 50; i++) {
      const r = i / 50;
      const v = computeJitteredPollInterval(base, () => r);
      expect(v).toBeGreaterThanOrEqual(base - jitter - 1);
      expect(v).toBeLessThanOrEqual(base + jitter + 1);
    }
  });

  it("is deterministic with fixed random", () => {
    expect(computeJitteredPollInterval(1000, () => 0)).toBe(700);
    expect(computeJitteredPollInterval(1000, () => 1)).toBe(1300);
  });
});

describe("humanDelayMs", () => {
  it("respects inclusive bounds with fixed random", () => {
    expect(humanDelayMs(100, 200, () => 0)).toBe(100);
    expect(humanDelayMs(100, 200, () => 0.999999)).toBe(199);
  });
});

describe("locator regex safety (integration of escapeRegExp + attempt labels)", () => {
  it("trail names with regex specials still produce valid RegExp when composed like sniper.ts", () => {
    const trail = "Labyrinth (East)";
    const month = "March 20, 2026";
    const dt = escapeRegExp(month);
    const t = escapeRegExp(trail);
    const pattern = new RegExp(`(?=.*${dt})(?=.*${t})(?=.*\\s-\\sAvailable)`, "i");
    expect(pattern.test(`Labyrinth (East) on March 20, 2026 - Available`)).toBe(true);
    expect(pattern.test(`Labyrinth (East) on March 20, 2026 - Unavailable`)).toBe(false);
  });
});
