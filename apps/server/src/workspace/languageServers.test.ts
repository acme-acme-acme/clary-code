// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { languageServerStatuses } from "./languageServers.ts";
import { WorkspaceLanguageService } from "./WorkspaceLanguageService.ts";

describe("language server settings", () => {
  let cwd: string;
  let service: WorkspaceLanguageService;
  beforeEach(async () => {
    cwd = await NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-lsp-")));
    service = new WorkspaceLanguageService();
  });
  afterEach(async () => {
    service.dispose();
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  });

  it("reports bundled servers and probes a configured command", async () => {
    const fake = NodePath.join(cwd, "fake-rust-analyzer");
    await NodeFSP.writeFile(fake, '#!/bin/sh\necho "rust-analyzer 9.9.9 (fake)"\n', {
      mode: 0o755,
    });
    const statuses = await languageServerStatuses({
      rust: { command: fake },
      protobuf: { command: NodePath.join(cwd, "missing-buf"), enabled: false },
    });
    expect(statuses.find((status) => status.id === "typescript")).toMatchObject({
      bundled: true,
      enabled: true,
      version: expect.stringMatching(/^\d+\.\d+/),
    });
    expect(statuses.find((status) => status.id === "rust")).toMatchObject({
      bundled: false,
      command: fake,
      path: fake,
      version: "rust-analyzer 9.9.9 (fake)",
    });
    expect(statuses.find((status) => status.id === "python")).toMatchObject({
      bundled: true,
      command: null,
      version: expect.stringMatching(/^\d+\.\d+/),
    });
    expect(statuses.find((status) => status.id === "protobuf")).toMatchObject({
      enabled: false,
      path: null,
      version: null,
      installHint: expect.stringContaining("buf"),
    });
  });

  it("refuses a turned-off language and restarts when its command changes", async () => {
    const contents = 'syntax = "proto3";';
    await NodeFSP.writeFile(NodePath.join(cwd, "demo.proto"), contents);
    const request = (settings: Parameters<WorkspaceLanguageService["request"]>[1]) =>
      service.request(
        {
          sessionId: "editor",
          cwd,
          relativePath: "demo.proto",
          operation: "diagnostics",
          version: 1,
          update: { _tag: "open", contents },
        },
        settings,
      );
    await expect(request({ protobuf: { enabled: false } })).rejects.toMatchObject({
      message: expect.stringContaining("turned off in Settings"),
      resync: false,
    });
    const first = NodePath.join(cwd, "first-buf");
    await expect(request({ protobuf: { command: first } })).rejects.toThrow(first);
    const second = NodePath.join(cwd, "second-buf");
    await expect(request({ protobuf: { command: second } })).rejects.toThrow(second);
  });
});
