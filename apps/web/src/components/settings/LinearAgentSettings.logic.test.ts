import type { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linearMachineOptions } from "./LinearAgentSettings.logic";

const discovered = (
  environmentId: string,
  label: string,
  linkedAt: string,
  availability: Discovery.RelayEnvironmentAvailability,
) => ({
  environment: {
    environmentId: EnvironmentId.make(environmentId),
    label,
    linkedAt,
    endpoint: {} as never,
  },
  availability,
});

describe("linearMachineOptions", () => {
  it("lists online machines first and tells apart ones that share a name", () => {
    const options = linearMachineOptions([
      discovered("aaaaaaaa-old", "MacBook Pro", "2026-08-01T10:00:00.000Z", "offline"),
      discovered("ffffffff-fleet", "codex-fleet-01", "2026-07-01T10:00:00.000Z", "offline"),
      discovered("bbbbbbbb-new", "MacBook Pro", "2026-09-20T10:00:00.000Z", "online"),
    ]);
    expect(options.map((option) => option.environmentId)).toEqual([
      "bbbbbbbb-new",
      "aaaaaaaa-old",
      "ffffffff-fleet",
    ]);
    expect(options[0]?.detail).toMatch(/^Online · linked .+ · bbbbbbbb$/);
    expect(options[1]?.detail).toMatch(/^Offline · linked .+ · aaaaaaaa$/);
    expect(options[2]?.detail).toBe("Offline");
  });
});
