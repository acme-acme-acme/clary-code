import { describe, expect, it } from "vite-plus/test";

import { buildDiffChangesTreeRows, orderDiffChangesTreeFiles } from "./diffChangesTree.logic";

const identity = (path: string) => path;

function describeRows(rows: ReturnType<typeof buildDiffChangesTreeRows<string>>) {
  return rows.map((row) =>
    row.kind === "directory"
      ? `${"  ".repeat(row.depth)}${row.segments.join(" / ")}/`
      : `${"  ".repeat(row.depth)}${row.name}`,
  );
}

describe("buildDiffChangesTreeRows", () => {
  it("merges single-folder chains and lists folders before files", () => {
    const rows = buildDiffChangesTreeRows(
      [
        "apps/web/src/components/b.tsx",
        "apps/web/src/components/a.tsx",
        "apps/web/src/domains/agent/types.ts",
        "apps/web/src/domains/agent/hooks/use-chat.ts",
        "README.md",
      ],
      identity,
      new Set(),
    );

    expect(describeRows(rows)).toEqual([
      "apps / web / src/",
      "  components/",
      "    a.tsx",
      "    b.tsx",
      "  domains / agent/",
      "    hooks/",
      "      use-chat.ts",
      "    types.ts",
      "README.md",
    ]);
  });

  it("keys a merged folder by its deepest path and hides its contents when collapsed", () => {
    const rows = buildDiffChangesTreeRows(
      ["apps/web/src/a.ts", "docs/guide.md"],
      identity,
      new Set(["apps/web/src"]),
    );

    expect(rows.map((row) => [row.kind, row.path])).toEqual([
      ["directory", "apps/web/src"],
      ["directory", "docs"],
      ["file", "docs/guide.md"],
    ]);
    expect(rows[0]).toMatchObject({ expanded: false });
  });

  it("sorts numbered names naturally", () => {
    const rows = buildDiffChangesTreeRows(
      ["step10.ts", "step2.ts", "step1.ts"],
      identity,
      new Set(),
    );

    expect(describeRows(rows)).toEqual(["step1.ts", "step2.ts", "step10.ts"]);
  });

  it("orders files the way the tree reads, folders first", () => {
    expect(orderDiffChangesTreeFiles(["README.md", "src/b.ts", "src/lib/a.ts"], identity)).toEqual([
      "src/lib/a.ts",
      "src/b.ts",
      "README.md",
    ]);
  });
});
