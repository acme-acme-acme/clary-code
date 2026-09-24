import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  RelayLinearAccountLink,
  RelayLinearAuthorizeKind,
  RelayLinearStatusResponse,
} from "@t3tools/contracts/relay";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, EllipsisIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import {
  fetchLinearStatus,
  startLinearAuthorization,
  unlinkLinearAccount,
  updateLinearLinkEnvironment,
} from "~/cloud/linearRelay";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "~/cloud/publicConfig";
import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useEnvironments, useRelayEnvironmentDiscovery } from "~/state/environments";
import { serverEnvironment } from "~/state/server";

import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { linearMachineOptions, type LinearMachineOption } from "./LinearAgentSettings.logic";
import { LinearProjectRows } from "./LinearProjectRows";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection, useSettingsSearchTargetId } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LINEAR_SECTION_ID = searchableSetting("linear").id;

type LinearStatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly status: RelayLinearStatusResponse };

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/**
 * Everything Linear on one card. With Otter Connect: the Linear workspaces the
 * signed-in account is linked to, the machine each one runs delegated issues
 * on, and that machine's projects and prompt. Always: the API key a machine
 * can read Linear with instead of a linked account.
 */
export function LinearSettings({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  return hasCloudPublicConfig() ? (
    <ConfiguredLinearSettings primaryEnvironmentId={primaryEnvironmentId} />
  ) : (
    <LinearSection>
      <LinearApiKeyRow primaryEnvironmentId={primaryEnvironmentId} />
    </LinearSection>
  );
}

function LinearSection({
  headerAction,
  children,
}: {
  readonly headerAction?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <SettingsSection {...searchableSetting("linear")} headerAction={headerAction}>
      {children}
    </SettingsSection>
  );
}

function ConfiguredLinearSettings({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  useLinearReturnParam(isLoaded, isSignedIn === true);
  return isSignedIn ? (
    <SignedInLinearSettings
      primaryEnvironmentId={primaryEnvironmentId}
      readClerkToken={async () => {
        const token = await getToken(resolveRelayClerkTokenOptions());
        if (!token) throw new Error("Sign in to Otter Connect first.");
        return token;
      }}
    />
  ) : (
    <LinearSection>
      <LinearApiKeyRow primaryEnvironmentId={primaryEnvironmentId} />
    </LinearSection>
  );
}

/**
 * The relay sends the browser back with `?linear=<outcome>` after Linear's
 * consent screen, and Linear's own "Link account" prompt lands here with
 * `?linear=link`. Report the outcome once, then drop the param so a reload
 * doesn't repeat it; `link` jumps to the section through the settings hash.
 */
function useLinearReturnParam(authLoaded: boolean, signedIn: boolean) {
  const navigate = useNavigate();
  const settingsScope = useOptionalSettingsScope();
  const outcome = useLocation({
    select: (location) => (location.search as Record<string, unknown>).linear,
  });
  const handledRef = useRef(false);
  const handle = useEffectEvent((value: string) => {
    if (value === "installed") {
      toastManager.add({
        type: "success",
        title: "Otter agent installed",
        description: "Link your Linear account to choose where delegated issues run.",
      });
    } else if (value === "linked") {
      toastManager.add({ type: "success", title: "Linear account linked" });
    } else if (value === "cancelled") {
      toastManager.add({ type: "info", title: "Linear authorization cancelled" });
    } else if (value === "error") {
      toastManager.add({
        type: "error",
        title: "Could not connect Linear",
        description: "Linear authorization failed. Try again.",
      });
    } else if (value === "link" && !signedIn) {
      toastManager.add({
        type: "info",
        title: "Sign in to Otter Connect",
        description: "Then link your Linear account to run delegated issues here.",
      });
    }
    void navigate({
      to: "/settings/connections",
      search: () => ({ ...settingsScope?.search }),
      hash: value === "link" ? LINEAR_SECTION_ID : "",
      replace: true,
      resetScroll: false,
    });
  });
  useEffect(() => {
    // Wait for Clerk so a signed-in user isn't told to sign in.
    if (!authLoaded || typeof outcome !== "string" || handledRef.current) return;
    handledRef.current = true;
    handle(outcome);
  }, [authLoaded, outcome]);
}

function SignedInLinearSettings({
  primaryEnvironmentId,
  readClerkToken,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly readClerkToken: () => Promise<string>;
}) {
  const discovery = useRelayEnvironmentDiscovery();
  const [state, setState] = useState<LinearStatusState>({ kind: "loading" });
  const [pending, setPending] = useState<string | null>(null);

  // Environments linked to T3 Connect; only these can receive delegated issues.
  const machines = linearMachineOptions(discovery.environments.values());
  const machineFor = (environmentId: EnvironmentId): LinearMachineOption => {
    const machine = machines.find((candidate) => candidate.environmentId === environmentId);
    return (
      machine ?? {
        environmentId,
        label: discovery.refreshing ? "Loading…" : "Unavailable machine",
        detail: discovery.refreshing ? "" : "Not linked to Otter Connect",
        online: false,
      }
    );
  };
  const existingLinks = state.kind === "ready" ? state.status.links : [];
  // A new link runs where existing links already do; each link can move afterwards.
  const linkEnvironmentId =
    [existingLinks[0]?.environmentId ?? null, primaryEnvironmentId].find(
      (candidate) =>
        candidate !== null && machines.some((machine) => machine.environmentId === candidate),
    ) ??
    machines[0]?.environmentId ??
    null;

  const readStatus = async (): Promise<LinearStatusState> => {
    try {
      return { kind: "ready", status: await fetchLinearStatus(await readClerkToken()) };
    } catch (cause) {
      return { kind: "error", message: errorMessage(cause, "Could not load Linear status.") };
    }
  };
  const load = async () => setState(await readStatus());
  const readStatusOnMount = useEffectEvent(readStatus);
  useEffect(() => {
    let active = true;
    void readStatusOnMount().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, []);

  const run = async (key: string, failureTitle: string, action: () => Promise<void>) => {
    setPending(key);
    try {
      await action();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: errorMessage(cause, "Try again."),
      });
    } finally {
      setPending(null);
    }
  };

  const authorize = (kind: RelayLinearAuthorizeKind, environmentId = linkEnvironmentId) =>
    run(kind, "Could not open Linear", async () => {
      const url = await startLinearAuthorization(
        await readClerkToken(),
        kind,
        kind === "link" ? (environmentId ?? undefined) : undefined,
      );
      // The desktop app can't host the relay's return to the hosted app, so
      // consent happens in the browser; the web app goes there and comes back.
      if (window.desktopBridge) {
        if (!(await window.desktopBridge.openExternal(url))) {
          throw new Error("Unable to open the browser.");
        }
      } else {
        window.location.assign(url);
      }
    });

  const moveLink = (organizationId: string, environmentId: EnvironmentId) =>
    run(organizationId, "Could not change the environment", async () => {
      await updateLinearLinkEnvironment(await readClerkToken(), organizationId, environmentId);
      await load();
    });

  const unlink = async (organizationId: string, organizationName: string) => {
    const confirmed = await requestConfirmDialog(
      `Unlink your Linear account in ${organizationName}?\nIssues you delegate there stop running on your environments.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    await run(organizationId, "Could not unlink Linear", async () => {
      await unlinkLinearAccount(await readClerkToken(), organizationId);
      await load();
    });
  };

  const apiKeyRow = <LinearApiKeyRow primaryEnvironmentId={primaryEnvironmentId} />;
  // Without the relay's Linear app there is nothing to link; the API key still works.
  if (state.kind === "ready" && !state.status.available) {
    return <LinearSection>{apiKeyRow}</LinearSection>;
  }
  const links = state.kind === "ready" ? state.status.links : [];

  return (
    <LinearSection
      headerAction={
        state.kind === "ready" ? (
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={pending !== null}
              onClick={() => void authorize("install")}
            >
              {pending === "install" ? "Opening…" : "Install agent"}
            </Button>
            {links.length > 0 ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={pending !== null || linkEnvironmentId === null}
                onClick={() => void authorize("link")}
              >
                {pending === "link" ? "Opening…" : "Link workspace"}
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {state.kind === "loading" ? (
        <SettingsRow title="Linear workspaces" status={<Spinner size="sm" />} />
      ) : state.kind === "error" ? (
        <SettingsRow
          title="Linear workspaces"
          status={<span className="text-destructive">{state.message}</span>}
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setState({ kind: "loading" });
                void load();
              }}
            >
              Retry
            </Button>
          }
        />
      ) : links.length === 0 ? (
        <SettingsRow
          title="Link your Linear account"
          description={
            linkEnvironmentId === null
              ? "Turn on Otter Connect for a machine first; issues you delegate to the Otter agent run there."
              : `Issues you delegate to the Otter agent run on ${machineFor(linkEnvironmentId).label}. A workspace admin installs the agent first.`
          }
          control={
            <Button
              size="sm"
              disabled={pending !== null || linkEnvironmentId === null}
              onClick={() => void authorize("link")}
            >
              {pending === "link" ? "Opening…" : "Link Linear account"}
            </Button>
          }
        />
      ) : (
        links.map((link) => (
          <LinkedWorkspace
            key={link.organizationId}
            link={link}
            machine={machineFor(link.environmentId)}
            machines={machines}
            disabled={pending !== null}
            onMove={(environmentId) => {
              if (environmentId !== link.environmentId) {
                void moveLink(link.organizationId, environmentId);
              }
            }}
            onSignIn={() => void authorize("link", link.environmentId)}
            onUnlink={() => void unlink(link.organizationId, link.organizationName)}
          />
        ))
      )}
      {apiKeyRow}
    </LinearSection>
  );
}

/**
 * One linked Linear workspace: the machine its delegated issues run on, and,
 * folded below, that machine's projects and prompt. Opens by itself when
 * something needs attention.
 */
function LinkedWorkspace({
  link,
  machine,
  machines,
  disabled,
  onMove,
  onSignIn,
  onUnlink,
}: {
  readonly link: RelayLinearAccountLink;
  readonly machine: LinearMachineOption;
  readonly machines: ReadonlyArray<LinearMachineOption>;
  readonly disabled: boolean;
  readonly onMove: (environmentId: EnvironmentId) => void;
  readonly onSignIn: () => void;
  readonly onUnlink: () => void;
}) {
  // Null until this client has a connection to the machine and has read its settings.
  const machineSettings = useAtomValue(serverEnvironment.settingsValueAtom(machine.environmentId));
  const hasProject =
    machineSettings !== null &&
    (machineSettings.linear.defaultProjectId !== null ||
      machineSettings.linear.teamProjects.length > 0);
  const needsSignIn = link.signedIn === false;
  const problem = !link.agentInstalled
    ? "The Otter agent isn't installed in this workspace yet; a Linear admin has to install it."
    : needsSignIn
      ? "Sign in again so your machines read issues and pull request reviews as you."
      : machineSettings === null
        ? `${machine.label} isn't connected here, so its projects can't be shown.`
        : !hasProject
          ? `No project is set on ${machine.label}, so delegated issues fail until you pick one.`
          : null;
  const [open, setOpen] = useState(machineSettings !== null && !hasProject);
  // Searches for the project and prompt rows land on the section; open so they show.
  const searchedHere = useSettingsSearchTargetId() === LINEAR_SECTION_ID;
  const [openedForSearch, setOpenedForSearch] = useState(false);
  if (searchedHere && !openedForSearch) {
    setOpenedForSearch(true);
    if (machineSettings !== null) setOpen(true);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} disabled={machineSettings === null}>
      <SettingsRow
        title={
          <CollapsibleTrigger className="-ml-1 flex items-center gap-1 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default">
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                open && "rotate-90",
                machineSettings === null && "opacity-0",
              )}
            />
            {link.organizationName}
          </CollapsibleTrigger>
        }
        description={`Signed in as ${link.linearUserName}. Delegated issues run on the machine picked here.`}
        status={problem ? <span className="text-warning">{problem}</span> : null}
        control={
          <>
            <EnvironmentSelect
              ariaLabel={`Machine for ${link.organizationName}`}
              machines={machines}
              value={machine}
              disabled={disabled}
              onChange={onMove}
            />
            {needsSignIn ? (
              <Button size="sm" disabled={disabled} onClick={onSignIn}>
                Sign in again
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    disabled={disabled}
                    aria-label={`More actions for ${link.organizationName}`}
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {needsSignIn ? null : <MenuItem onClick={onSignIn}>Sign in again</MenuItem>}
                <MenuItem variant="destructive" onClick={onUnlink}>
                  Unlink
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        }
      />
      {machineSettings === null ? null : (
        <CollapsiblePanel>
          <div className="ml-4 border-l border-border/50 [&>*+*]:border-t [&>*+*]:border-border/50">
            <LinearProjectRows environmentId={machine.environmentId} />
          </div>
        </CollapsiblePanel>
      )}
    </Collapsible>
  );
}

/**
 * The key a machine reads Linear with when no linked account covers it:
 * issue status, the issue page, and live updates. Stored on that machine.
 */
function LinearApiKeyRow({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const { environments } = useEnvironments();
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId =
    [chosen, primaryEnvironmentId].find(
      (candidate) =>
        candidate !== null &&
        environments.some((environment) => environment.environmentId === candidate),
    ) ??
    environments[0]?.environmentId ??
    null;
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  return (
    <SettingsRow
      {...searchableSetting("linear-api-key")}
      description={
        <>
          Optional. A personal key from Linear → Settings → Security &amp; access lets a machine
          show Linear issues without a linked account.
          {environments.length > 1 && environment ? ` Saved on ${environment.label}.` : null}
        </>
      }
      control={
        environmentId === null ? null : (
          <>
            {environments.length > 1 && environment ? (
              <Select
                value={environmentId}
                onValueChange={(next) => {
                  const match = environments.find((entry) => entry.environmentId === next);
                  if (match) setChosen(match.environmentId);
                }}
              >
                <SelectTrigger size="sm" className="w-full min-w-0 sm:w-40" aria-label="Machine">
                  <SelectValue>{environment.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environments.map((entry) => (
                    <SelectItem hideIndicator key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <LinearApiKeyInput key={environmentId} environmentId={environmentId} />
          </>
        )
      }
    />
  );
}

function LinearApiKeyInput({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const stored = useEnvironmentSettings(
    environmentId,
    // The server never sends the key back; a stored key arrives as a
    // non-empty redaction marker, so only its presence is meaningful here.
    useCallback((settings) => settings.linear.apiKey.length > 0, []),
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return (
    <>
      <DraftInput
        nativeInput
        size="sm"
        type="password"
        autoComplete="off"
        className="w-full sm:w-48"
        aria-label="Linear API key"
        placeholder={stored ? "Saved. Enter a new key to replace" : "lin_api_…"}
        value=""
        onCommit={(next) => {
          const apiKey = next.trim();
          if (apiKey.length > 0) updateSettings({ linear: { apiKey } });
        }}
      />
      {stored ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => updateSettings({ linear: { apiKey: "" } })}
        >
          Remove
        </Button>
      ) : null}
    </>
  );
}

function MachineName({ machine }: { readonly machine: LinearMachineOption }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate">{machine.label}</span>
      {machine.detail ? (
        <span className="shrink-0 text-muted-foreground text-xs">{machine.detail}</span>
      ) : null}
    </span>
  );
}

function EnvironmentSelect({
  ariaLabel,
  machines,
  value,
  disabled,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly machines: ReadonlyArray<LinearMachineOption>;
  readonly value: LinearMachineOption;
  readonly disabled: boolean;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  return (
    <Select
      disabled={disabled}
      value={value.environmentId}
      onValueChange={(next) => {
        const machine = machines.find((candidate) => candidate.environmentId === next);
        if (machine) onChange(machine.environmentId);
      }}
    >
      <SelectTrigger size="sm" className="w-full min-w-0 sm:w-64" aria-label={ariaLabel}>
        <SelectValue>
          <MachineName machine={value} />
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {machines.map((machine) => (
          <SelectItem hideIndicator key={machine.environmentId} value={machine.environmentId}>
            <MachineName machine={machine} />
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
