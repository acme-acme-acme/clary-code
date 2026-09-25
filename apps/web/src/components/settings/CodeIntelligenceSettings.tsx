import type { CodeIntelligenceServerId, LanguageServerStatus } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useState } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function statusText(server: LanguageServerStatus) {
  if (server.bundled)
    return `Built in${server.version ? ` · v${server.version}` : ""} · ${server.languages.join(" ")}`;
  if (!server.path) return `${server.command} was not found. ${server.installHint}`;
  return `${server.version ?? "Installed"} · ${server.path}`;
}

/** Commits on blur or Enter so each keystroke does not rewrite settings on every machine. */
function CommandInput(props: {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  const [saved, setSaved] = useState(props.value);
  if (saved !== props.value) {
    setSaved(props.value);
    setDraft(props.value);
  }
  const commit = () => {
    const next = draft.trim();
    if (next !== props.value) props.onCommit(next);
  };
  return (
    <Input
      size="sm"
      className="w-72 max-w-full"
      aria-label={props.label}
      placeholder={props.placeholder}
      value={draft}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
    />
  );
}

export function CodeIntelligenceSettingsPanel() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings((value) => value.codeIntelligence);
  const updateSettings = useUpdateScopedSettings();
  const loadStatus = useAtomCommand(projectEnvironment.languageServers, { reportFailure: false });
  const environmentId =
    environment?.connection.phase === "connected" ? environment.environmentId : null;
  // Availability is probed on one machine; the rows below still fan out to the selection.
  const aggregate = scope.environmentIds.length !== 1 && connectedEnvironments.length > 1;
  const environmentSuffix = aggregate && environment ? ` · ${environment.label}` : "";
  const [servers, setServers] = useState<ReadonlyArray<LanguageServerStatus> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const scan = useCallback(async () => {
    if (environmentId === null) return;
    setChecking(true);
    const result = await loadStatus({ environmentId, input: {} });
    setChecking(false);
    if (result._tag === "Success") {
      setServers(result.value.servers);
      setError(null);
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Unable to check language servers.");
    }
  }, [environmentId, loadStatus]);
  // Settings change which command runs, so re-probe whenever they do.
  useEffect(() => {
    void scan();
  }, [scan, settings]);

  const update = (id: CodeIntelligenceServerId, patch: { enabled?: boolean; command?: string }) =>
    updateSettings({ codeIntelligence: { [id]: { ...settings[id], ...patch } } });

  const scanButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={() => void scan()}
            disabled={checking || environmentId === null}
            aria-label="Check language servers again"
          />
        }
      >
        <RefreshIcon refreshing={checking} />
      </TooltipTrigger>
      <TooltipPopup side="top">Check language servers again</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("code-intelligence").id}
        title={`Language servers${environmentSuffix}`}
        headerAction={scanButton}
      >
        {environmentId === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage its language servers.
          </p>
        ) : servers === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {error ?? "Checking language servers…"}
          </p>
        ) : (
          servers.map((server) => (
            <SettingsRow
              key={server.id}
              id={`code-intelligence-${server.id}`}
              title={server.label}
              description={statusText(server)}
              status={
                server.enabled && !server.bundled && !server.path ? "Not installed" : undefined
              }
              serverScoped
              settingKeys={["codeIntelligence"]}
              control={
                <Switch
                  aria-label={`Enable ${server.label}`}
                  checked={settings[server.id]?.enabled !== false}
                  onCheckedChange={(enabled) => update(server.id, { enabled })}
                />
              }
            >
              {server.id === "typescript" || server.id === "json" ? null : (
                <div className="flex flex-wrap items-center gap-2 pt-2 text-xs text-muted-foreground">
                  <span>Command</span>
                  <CommandInput
                    label={`${server.label} command`}
                    value={settings[server.id]?.command ?? ""}
                    placeholder={server.command ?? "Built in"}
                    onCommit={(command) => update(server.id, { command })}
                  />
                </div>
              )}
            </SettingsRow>
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
