import { describe, expect, it } from "vite-plus/test";

import { desktopHandoffUrl, parseThreadPath } from "./threadDeepLinks";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)";

describe("thread deep links", () => {
  it("reads thread paths with encoded ids", () => {
    expect(parseThreadPath("/env-1/linear-session%3Aabc")).toEqual({
      environmentId: "env-1",
      threadId: "linear-session:abc",
    });
    expect(parseThreadPath("/settings")).toBeNull();
    expect(parseThreadPath(null)).toBeNull();
  });

  it("hands hosted thread links to the desktop app, except on phones", () => {
    const link = new URL("https://code.otterware.dev/env-1/linear-session%3Aabc?open=desktop");
    expect(desktopHandoffUrl(link, MAC)).toBe("ottercode://app/env-1/linear-session%3Aabc");
    expect(desktopHandoffUrl(link, IPHONE)).toBeNull();
    expect(desktopHandoffUrl(new URL("https://code.otterware.dev/env-1/t-1"), MAC)).toBeNull();
    expect(
      desktopHandoffUrl(new URL("https://code.otterware.dev/settings?open=desktop"), MAC),
    ).toBeNull();
  });
});
