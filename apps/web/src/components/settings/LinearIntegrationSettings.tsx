import {
  DEFAULT_LINEAR_PROMPT_TEMPLATE,
  type EnvironmentId,
  LINEAR_PROMPT_TEMPLATE_PLACEHOLDERS,
  type LinearTeamProject,
  type ProjectId,
} from "@t3tools/contracts";
import { PlusIcon, XIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { useProjects } from "~/state/entities";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const NO_PROJECT = "none";

/**
 * Environment-level Linear settings: the API key that reads linked-issue
 * status, and which project an issue delegated to the Otter agent runs in.
 * Project ids belong to one environment, so this always edits exactly the
 * selected environment rather than every environment in the scope.
 */
export function LinearIntegrationSettings() {
  const { scope, environment, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsSection {...searchableSetting("linear")}>
      {environment ? (
        <LinearEnvironmentControls
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={connectedEnvironments.length > 1 ? environment.label : null}
          disabled={projectScope}
        />
      ) : (
        <SettingsRow title="Linear" description="Connect to an environment to set up Linear." />
      )}
    </SettingsSection>
  );
}

function LinearEnvironmentControls({
  environmentId,
  environmentLabel,
  disabled,
}: {
  readonly environmentId: EnvironmentId;
  /** Named only when the scope spans several environments, so it's clear which one is edited. */
  readonly environmentLabel: string | null;
  readonly disabled: boolean;
}) {
  const apiKeyStored = useEnvironmentSettings(
    environmentId,
    // The server never sends the key back; a stored key arrives as a
    // non-empty redaction marker, so only its presence is meaningful here.
    useCallback((settings) => settings.linear.apiKey.length > 0, []),
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);

  return (
    <>
      <SettingsRow
        {...searchableSetting("linear-api-key")}
        serverScoped
        description={
          <>
            Personal API key from Linear → Settings → Security &amp; access; used to show issue
            status. Not needed once you link your Linear account under Connections → Linear agent:
            your machines then read Linear as you, which also shows pull request reviews.
            {environmentLabel ? ` Saved on ${environmentLabel}.` : null}
          </>
        }
        control={
          <>
            <DraftInput
              nativeInput
              size="sm"
              type="password"
              autoComplete="off"
              className="w-full sm:w-56"
              aria-label="Linear API key"
              placeholder={apiKeyStored ? "Saved. Enter a new key to replace" : "lin_api_…"}
              disabled={disabled}
              value=""
              onCommit={(next) => {
                const apiKey = next.trim();
                if (apiKey.length > 0) updateSettings({ linear: { apiKey } });
              }}
            />
            {apiKeyStored ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => updateSettings({ linear: { apiKey: "" } })}
              >
                Remove
              </Button>
            ) : null}
          </>
        }
      />
      <LinearProjectRows
        environmentId={environmentId}
        disabled={disabled}
        defaultProjectDescription="Where issues delegated to the Otter agent run when their team has no project below. Only the machine your Linear account is linked to runs them; see Connections → Linear agent."
        inSettingsScope
      />
    </>
  );
}

/**
 * Which project a delegated issue runs in on one environment. Shown on the
 * Integrations page for the selected environment, and under each Linear
 * account link for the machine it points at, which may be another one.
 */
export function LinearProjectRows({
  environmentId,
  disabled,
  defaultProjectDescription,
  machineLabel = null,
  inSettingsScope = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly defaultProjectDescription: string;
  /** Names the machine in the row titles where the page isn't about one environment. */
  readonly machineLabel?: string | null;
  /** Rows on the Integrations page follow the settings scope and are search targets. */
  readonly inSettingsScope?: boolean;
}) {
  const linear = useEnvironmentSettings(
    environmentId,
    useCallback((settings) => settings.linear, []),
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.environmentId === environmentId)
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, environmentId],
  );
  const projectTitle = (projectId: ProjectId) =>
    projects.find((project) => project.id === projectId)?.title ?? "Removed project";
  const updateTeamProjects = (teamProjects: ReadonlyArray<LinearTeamProject>) =>
    updateSettings({ linear: { teamProjects } });
  const rowProps = (
    id: "linear-default-project" | "linear-team-projects" | "linear-prompt-template",
  ) => {
    const setting = searchableSetting(id);
    const title = machineLabel ? `${setting.title} on ${machineLabel}` : setting.title;
    return inSettingsScope ? { ...setting, title, serverScoped: true } : { title };
  };

  return (
    <>
      <SettingsRow
        {...rowProps("linear-default-project")}
        description={defaultProjectDescription}
        control={
          <ProjectSelect
            ariaLabel="Default Linear project"
            projects={projects}
            value={linear.defaultProjectId}
            label={
              linear.defaultProjectId === null ? "None" : projectTitle(linear.defaultProjectId)
            }
            allowNone
            disabled={disabled}
            onChange={(defaultProjectId) => updateSettings({ linear: { defaultProjectId } })}
          />
        }
      />
      <SettingsRow
        {...rowProps("linear-team-projects")}
        description="Run a Linear team's issues in a specific project, by team key such as ENG."
      >
        <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60">
          {linear.teamProjects.map((mapping) => (
            <div
              key={mapping.teamKey}
              className="flex items-center gap-3 border-b border-border/60 px-3 py-2"
            >
              <span className="w-20 shrink-0 truncate font-mono text-sm">{mapping.teamKey}</span>
              <div className="min-w-0 flex-1">
                <ProjectSelect
                  ariaLabel={`Project for ${mapping.teamKey}`}
                  projects={projects}
                  value={mapping.projectId}
                  label={projectTitle(mapping.projectId)}
                  disabled={disabled}
                  onChange={(projectId) => {
                    if (projectId === null) return;
                    updateTeamProjects(
                      linear.teamProjects.map((entry) =>
                        entry.teamKey === mapping.teamKey ? { ...entry, projectId } : entry,
                      ),
                    );
                  }}
                />
              </div>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${mapping.teamKey}`}
                disabled={disabled}
                onClick={() =>
                  updateTeamProjects(
                    linear.teamProjects.filter((entry) => entry.teamKey !== mapping.teamKey),
                  )
                }
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <AddTeamProjectRow
            projects={projects}
            disabled={disabled}
            onAdd={(added) =>
              // One project per team: adding a known key replaces its mapping.
              updateTeamProjects([
                ...linear.teamProjects.filter((entry) => entry.teamKey !== added.teamKey),
                added,
              ])
            }
          />
        </div>
      </SettingsRow>
      <SettingsRow
        {...rowProps("linear-prompt-template")}
        description={
          <>
            The first message of a thread started from Linear. Use{" "}
            {LINEAR_PROMPT_TEMPLATE_PLACEHOLDERS.map((name) => `{{${name}}}`).join(", ")}.{" "}
            <code>{"{{context}}"}</code> is Linear&apos;s issue context with comments and guidance.
          </>
        }
        resetAction={
          linear.promptTemplate.trim().length > 0 ? (
            <SettingResetButton
              label="Linear prompt template"
              onClick={() => updateSettings({ linear: { promptTemplate: "" } })}
            />
          ) : null
        }
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={`${environmentId}:${linear.promptTemplate}`}
            aria-label="Linear prompt template"
            rows={6}
            disabled={disabled}
            defaultValue={linear.promptTemplate.trim() || DEFAULT_LINEAR_PROMPT_TEMPLATE}
            onBlur={(event) => {
              const value = event.target.value.trim();
              // The default is stored as empty, so it can still improve later.
              const next = value === DEFAULT_LINEAR_PROMPT_TEMPLATE ? "" : value;
              if (next !== linear.promptTemplate.trim()) {
                updateSettings({ linear: { promptTemplate: next } });
              }
            }}
          />
        </div>
      </SettingsRow>
    </>
  );
}

function AddTeamProjectRow({
  projects,
  disabled,
  onAdd,
}: {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly disabled: boolean;
  readonly onAdd: (mapping: LinearTeamProject) => void;
}) {
  const [teamKey, setTeamKey] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const normalizedKey = teamKey.trim().toUpperCase();
  const canAdd = !disabled && normalizedKey.length > 0 && projectId !== null;
  const add = () => {
    if (!canAdd) return;
    onAdd({ teamKey: normalizedKey, projectId });
    setTeamKey("");
    setProjectId(null);
  };

  return (
    <form
      className="flex items-center gap-3 px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <Input
        nativeInput
        size="sm"
        className="w-20 shrink-0"
        aria-label="Linear team key"
        placeholder="ENG"
        disabled={disabled}
        value={teamKey}
        onChange={(event) => setTeamKey(event.target.value)}
      />
      <div className="min-w-0 flex-1">
        <ProjectSelect
          ariaLabel="Project for the new team"
          projects={projects}
          value={projectId}
          label={
            projectId === null
              ? "Choose a project"
              : (projects.find((project) => project.id === projectId)?.title ?? "Choose a project")
          }
          disabled={disabled}
          onChange={setProjectId}
        />
      </div>
      <Button type="submit" size="xs" variant="outline" disabled={!canAdd}>
        <PlusIcon />
        Add team
      </Button>
    </form>
  );
}

function ProjectSelect({
  ariaLabel,
  projects,
  value,
  label,
  allowNone = false,
  disabled,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly value: ProjectId | null;
  readonly label: string;
  readonly allowNone?: boolean;
  readonly disabled: boolean;
  readonly onChange: (projectId: ProjectId | null) => void;
}) {
  return (
    <Select
      disabled={disabled}
      value={value ?? NO_PROJECT}
      onValueChange={(next) => {
        if (next === NO_PROJECT) {
          onChange(null);
          return;
        }
        const project = projects.find((candidate) => candidate.id === next);
        if (project) onChange(project.id);
      }}
    >
      <SelectTrigger size="sm" className="w-full min-w-0 sm:w-56" aria-label={ariaLabel}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {allowNone ? (
          <SelectItem hideIndicator value={NO_PROJECT}>
            None
          </SelectItem>
        ) : null}
        {projects.map((project) => (
          <SelectItem hideIndicator key={project.id} value={project.id}>
            {project.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
