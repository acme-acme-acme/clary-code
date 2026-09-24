import { describe, expect, it } from "vite-plus/test";

import { threadPathFromDeepLink } from "./DesktopThreadLinks.ts";

describe("threadPathFromDeepLink", () => {
  it("reads a thread link for this app's scheme", () => {
    expect(threadPathFromDeepLink("ottercode://app/env-1/linear-session%3Aabc", "ottercode")).toBe(
      "/env-1/linear-session%3Aabc",
    );
  });

  it("ignores Clerk's callback, other schemes, and other paths", () => {
    for (const url of [
      "ottercode://app/",
      "ottercode://app/?code=1",
      "ottercode-dev://app/env-1/thread-1",
      "ottercode://other/env-1/thread-1",
      "ottercode://app/env-1/thread-1/extra",
      "/Applications/Otter Code.app",
      "--inspect",
    ]) {
      expect(threadPathFromDeepLink(url, "ottercode"), url).toBeNull();
    }
  });
});
