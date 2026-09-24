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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const NO_PROJECT = "none";

/**
 * Where issues delegated through one Linear link run on its machine, and the
 * message that starts them. These settings live on that machine, which is
 * often not this one, so they are edited on it directly.
 */
export function LinearProjectRows({ environmentId }: { readonly environmentId: EnvironmentId }) {
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

  return (
    <>
      <SettingsRow
        title="Default project"
        description="Where delegated issues run when their team has no project below."
        control={
          <ProjectSelect
            ariaLabel="Default Linear project"
            projects={projects}
            value={linear.defaultProjectId}
            label={
              linear.defaultProjectId === null ? "None" : projectTitle(linear.defaultProjectId)
            }
            allowNone
            onChange={(defaultProjectId) => updateSettings({ linear: { defaultProjectId } })}
          />
        }
      />
      <SettingsRow
        title="Team projects"
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
        title="Prompt"
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
  onAdd,
}: {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly onAdd: (mapping: LinearTeamProject) => void;
}) {
  const [teamKey, setTeamKey] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const normalizedKey = teamKey.trim().toUpperCase();
  const canAdd = normalizedKey.length > 0 && projectId !== null;
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
  onChange,
}: {
  readonly ariaLabel: string;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly value: ProjectId | null;
  readonly label: string;
  readonly allowNone?: boolean;
  readonly onChange: (projectId: ProjectId | null) => void;
}) {
  return (
    <Select
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
