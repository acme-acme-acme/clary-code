import { describe, expect, it } from "vite-plus/test";

import { diffViewedStat, isDiffFileViewed } from "./diffViewed.logic";

describe("isDiffFileViewed", () => {
  it("holds while the loaded patch is unchanged", () => {
    const mark = { version: 42, stat: "3:1" };
    expect(isDiffFileViewed(mark, { version: 42, stat: "3:1" })).toBe(true);
    expect(isDiffFileViewed(mark, { version: 43, stat: "3:1" })).toBe(false);
  });

  it("falls back to line counts while the patch is a placeholder", () => {
    const mark = { version: 42, stat: "3:1" };
    expect(isDiffFileViewed(mark, { version: null, stat: "3:1" })).toBe(true);
    expect(isDiffFileViewed(mark, { version: null, stat: "4:1" })).toBe(false);
  });

  it("is not viewed without a mark or anything to compare", () => {
    expect(isDiffFileViewed(undefined, { version: 1, stat: "1:0" })).toBe(false);
    expect(isDiffFileViewed({ version: 1, stat: null }, { version: null, stat: "1:0" })).toBe(
      false,
    );
  });

  it("formats line counts", () => {
    expect(diffViewedStat({ additions: 3, deletions: 1 })).toBe("3:1");
    expect(diffViewedStat(undefined)).toBeNull();
  });
});
