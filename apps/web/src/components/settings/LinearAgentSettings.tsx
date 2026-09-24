import { useAuth } from "@clerk/react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayLinearAuthorizeKind, RelayLinearStatusResponse } from "@t3tools/contracts/relay";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import {
  fetchLinearStatus,
  startLinearAuthorization,
  unlinkLinearAccount,
  updateLinearLinkEnvironment,
} from "~/cloud/linearRelay";
import { hasCloudPublicConfig, resolveRelayClerkTokenOptions } from "~/cloud/publicConfig";
import { requestConfirmDialog } from "~/confirmDialog";
import { useRelayEnvironmentDiscovery } from "~/state/environments";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const LINEAR_SECTION_ID = searchableSetting("linear-agent").id;

type LinearStatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly status: RelayLinearStatusResponse };

const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message ? cause.message : fallback;

/**
 * Account-level Linear agent: which Linear workspaces the signed-in account
 * is linked to, and which of its T3 Connect environments runs the issues it
 * delegates. Lives on the relay, so it needs T3 Connect and a signed-in user.
 */
export function LinearAgentSettings({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  return hasCloudPublicConfig() ? (
    <ConfiguredLinearAgentSettings primaryEnvironmentId={primaryEnvironmentId} />
  ) : null;
}

function ConfiguredLinearAgentSettings({
  primaryEnvironmentId,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
}) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  useLinearReturnParam(isLoaded, isSignedIn === true);
  return isSignedIn ? (
    <SignedInLinearAgentSettings
      primaryEnvironmentId={primaryEnvironmentId}
      readClerkToken={async () => {
        const token = await getToken(resolveRelayClerkTokenOptions());
        if (!token) throw new Error("Sign in to Otter Connect first.");
        return token;
      }}
    />
  ) : null;
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

function SignedInLinearAgentSettings({
  primaryEnvironmentId,
  readClerkToken,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly readClerkToken: () => Promise<string>;
}) {
  const discovery = useRelayEnvironmentDiscovery();
  const [state, setState] = useState<LinearStatusState>({ kind: "loading" });
  const [pending, setPending] = useState<string | null>(null);
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);

  // Environments linked to T3 Connect; only these can receive delegated issues.
  const relayEnvironments = [...discovery.environments.values()].map(
    ({ environment }) => environment,
  );
  const environmentLabel = (environmentId: EnvironmentId) =>
    relayEnvironments.find((environment) => environment.environmentId === environmentId)?.label ??
    (discovery.refreshing ? "Loading…" : "Unavailable environment");
  const linkEnvironmentId =
    [chosenEnvironmentId, primaryEnvironmentId].find(
      (candidate) =>
        candidate !== null &&
        relayEnvironments.some((environment) => environment.environmentId === candidate),
    ) ??
    relayEnvironments[0]?.environmentId ??
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

  const authorize = (kind: RelayLinearAuthorizeKind) =>
    run(kind, "Could not open Linear", async () => {
      const url = await startLinearAuthorization(
        await readClerkToken(),
        kind,
        kind === "link" ? (linkEnvironmentId ?? undefined) : undefined,
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

  if (state.kind === "ready" && !state.status.available) return null;

  return (
    <SettingsSection {...searchableSetting("linear-agent")}>
      {state.kind === "loading" ? (
        <SettingsRow title="Linear" status={<Spinner size="sm" />} />
      ) : state.kind === "error" ? (
        <SettingsRow
          title="Linear"
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
      ) : (
        <>
          {state.status.links.map((link) => (
            <SettingsRow
              key={link.organizationId}
              title={link.organizationName}
              description={
                link.agentInstalled
                  ? `Signed in as ${link.linearUserName}. Issues you delegate to the Otter agent run on the environment you pick.`
                  : `Signed in as ${link.linearUserName}. The Otter agent isn't installed in this workspace yet; a Linear admin has to install it.`
              }
              control={
                <>
                  <EnvironmentSelect
                    ariaLabel={`Environment for ${link.organizationName}`}
                    environments={relayEnvironments}
                    value={link.environmentId}
                    label={environmentLabel(link.environmentId)}
                    disabled={pending !== null}
                    onChange={(environmentId) => {
                      if (environmentId !== link.environmentId) {
                        void moveLink(link.organizationId, environmentId);
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending !== null}
                    onClick={() => void unlink(link.organizationId, link.organizationName)}
                  >
                    Unlink
                  </Button>
                </>
              }
            />
          ))}
          <SettingsRow
            title="Link Linear account"
            description={
              linkEnvironmentId === null
                ? "Turn on Otter Connect for an environment first; delegated issues run there."
                : "Issues you delegate to the Otter agent in Linear run on this environment."
            }
            control={
              <>
                {relayEnvironments.length > 1 && linkEnvironmentId !== null ? (
                  <EnvironmentSelect
                    ariaLabel="Environment for delegated Linear issues"
                    environments={relayEnvironments}
                    value={linkEnvironmentId}
                    label={environmentLabel(linkEnvironmentId)}
                    disabled={pending !== null}
                    onChange={setChosenEnvironmentId}
                  />
                ) : null}
                <Button
                  size="sm"
                  disabled={pending !== null || linkEnvironmentId === null}
                  onClick={() => void authorize("link")}
                >
                  {pending === "link" ? "Opening…" : "Link Linear account"}
                </Button>
              </>
            }
          />
          <SettingsRow
            title="Install the Otter agent"
            description="Adds the Otter agent to a Linear workspace so issues can be delegated to it. Needs a Linear workspace admin."
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void authorize("install")}
              >
                {pending === "install" ? "Opening…" : "Install in a Linear workspace"}
              </Button>
            }
          />
        </>
      )}
    </SettingsSection>
  );
}

function EnvironmentSelect({
  ariaLabel,
  environments,
  value,
  label,
  disabled,
  onChange,
}: {
  readonly ariaLabel: string;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly value: EnvironmentId;
  readonly label: string;
  readonly disabled: boolean;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  return (
    <Select
      disabled={disabled}
      value={value}
      onValueChange={(next) => {
        const environment = environments.find((candidate) => candidate.environmentId === next);
        if (environment) onChange(environment.environmentId);
      }}
    >
      <SelectTrigger size="sm" className="w-full min-w-0 sm:w-48" aria-label={ariaLabel}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {environments.map((environment) => (
          <SelectItem
            hideIndicator
            key={environment.environmentId}
            value={environment.environmentId}
          >
            {environment.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
