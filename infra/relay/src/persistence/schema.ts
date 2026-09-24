import type {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const relayMobileDevices = pgTable(
  "relay_mobile_devices",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    label: text("label").notNull().default("iOS device"),
    platform: varchar("platform", { length: 16 }).notNull().$type<"ios" | "android">(),
    iosMajorVersion: integer("ios_major_version"),
    androidApiLevel: integer("android_api_level"),
    appVersion: varchar("app_version", { length: 64 }),
    bundleId: varchar("bundle_id", { length: 255 }),
    apsEnvironment: varchar("aps_environment", { length: 16 }).$type<"sandbox" | "production">(),
    pushToken: text("push_token"),
    pushToStartToken: text("push_to_start_token"),
    preferencesJson: jsonb("preferences_json").notNull().$type<RelayAgentAwarenessPreferences>(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_mobile_devices_push_token").on(table.pushToken),
    uniqueIndex("idx_relay_mobile_devices_push_to_start_token").on(table.pushToStartToken),
  ],
);

export const relayLiveActivities = pgTable(
  "relay_live_activities",
  {
    userId: varchar("user_id", { length: 255 }).notNull(),
    deviceId: varchar("device_id", { length: 255 }).notNull(),
    activityPushToken: text("activity_push_token"),
    remoteStartQueuedAt: varchar("remote_start_queued_at", { length: 64 }),
    remoteStartedAt: varchar("remote_started_at", { length: 64 }),
    endedAt: varchar("ended_at", { length: 64 }),
    lastAggregateJson: jsonb("last_aggregate_json").$type<RelayAgentActivityAggregateState>(),
    lastLiveActivityDeliveryAt: varchar("last_live_activity_delivery_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.deviceId] }),
    uniqueIndex("idx_relay_live_activities_activity_push_token").on(table.activityPushToken),
  ],
);

export const relayEnvironmentLinks = pgTable(
  "relay_environment_links",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentLabel: text("environment_label").notNull().default("T3 Environment"),
    environmentPublicKey: text("environment_public_key").notNull(),
    endpointHttpBaseUrl: text("endpoint_http_base_url").notNull(),
    endpointWsBaseUrl: text("endpoint_ws_base_url").notNull(),
    endpointProviderKind: varchar("endpoint_provider_kind", { length: 32 }).notNull(),
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    liveActivitiesEnabled: boolean("live_activities_enabled").notNull().default(true),
    managedTunnelsEnabled: boolean("managed_tunnels_enabled").notNull().default(false),
    createdByDeviceId: varchar("created_by_device_id", { length: 191 }),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    index("idx_relay_environment_links_environment").on(table.environmentId, table.revokedAt),
  ],
);

export const relayManagedEndpointAllocations = pgTable(
  "relay_managed_endpoint_allocations",
  {
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    hostname: text("hostname").notNull(),
    tunnelId: varchar("tunnel_id", { length: 191 }),
    tunnelName: text("tunnel_name").notNull(),
    dnsRecordId: varchar("dns_record_id", { length: 191 }),
    readyAt: varchar("ready_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.environmentId] }),
    uniqueIndex("idx_relay_managed_endpoint_allocations_hostname").on(table.hostname),
    uniqueIndex("idx_relay_managed_endpoint_allocations_tunnel_name").on(table.tunnelName),
  ],
);

export const relayManagedTunnelLimits = pgTable("relay_managed_tunnel_limits", {
  userId: varchar("user_id", { length: 191 }).primaryKey(),
  maxTunnels: integer("max_tunnels").notNull(),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

export const relayEnvironmentCredentials = pgTable(
  "relay_environment_credentials",
  {
    credentialId: varchar("credential_id", { length: 64 }).primaryKey(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    credentialHash: varchar("credential_hash", { length: 191 }).notNull(),
    revokedAt: varchar("revoked_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    uniqueIndex("idx_relay_environment_credentials_hash").on(table.credentialHash),
    index("idx_relay_environment_credentials_environment").on(table.environmentId, table.revokedAt),
    index("idx_relay_environment_credentials_environment_key").on(
      table.environmentId,
      table.environmentPublicKey,
      table.revokedAt,
    ),
  ],
);

export const relayAgentActivityRows = pgTable(
  "relay_agent_activity_rows",
  {
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    environmentPublicKey: text("environment_public_key").notNull(),
    threadId: varchar("thread_id", { length: 512 }).notNull(),
    stateJson: jsonb("state_json").notNull().$type<RelayAgentActivityState>(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.environmentId, table.environmentPublicKey, table.threadId] }),
    index("idx_relay_agent_activity_rows_updated").on(table.updatedAt),
  ],
);

export const relayDeliveryAttempts = pgTable(
  "relay_delivery_attempts",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 255 }),
    environmentId: varchar("environment_id", { length: 191 }),
    threadId: varchar("thread_id", { length: 512 }),
    deviceId: varchar("device_id", { length: 255 }),
    kind: varchar("kind", { length: 64 }).notNull(),
    sourceJobId: varchar("source_job_id", { length: 64 }),
    tokenSuffix: varchar("token_suffix", { length: 16 }),
    apnsStatus: integer("apns_status"),
    apnsReason: text("apns_reason"),
    apnsId: varchar("apns_id", { length: 128 }),
    transportError: text("transport_error"),
  },
  (table) => [
    index("idx_relay_delivery_attempts_environment").on(
      table.environmentId,
      table.threadId,
      table.createdAt,
    ),
    uniqueIndex("idx_relay_delivery_attempts_source_job").on(table.sourceJobId),
  ],
);

export const relayDpopProofs = pgTable(
  "relay_dpop_proofs",
  {
    thumbprint: varchar("thumbprint", { length: 128 }).notNull(),
    jti: varchar("jti", { length: 255 }).notNull(),
    iat: integer("iat").notNull(),
    expiresAt: varchar("expires_at", { length: 64 }).notNull(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.thumbprint, table.jti] }),
    index("idx_relay_dpop_proofs_expires_at").on(table.expiresAt),
  ],
);

/** One row per Linear workspace the Otter agent is installed in. Tokens are AES-GCM sealed. */
export const relayLinearInstallations = pgTable("relay_linear_installations", {
  organizationId: varchar("organization_id", { length: 64 }).primaryKey(),
  organizationName: text("organization_name").notNull(),
  appUserId: varchar("app_user_id", { length: 64 }).notNull(),
  accessTokenSealed: text("access_token_sealed").notNull(),
  refreshTokenSealed: text("refresh_token_sealed"),
  accessTokenExpiresAt: varchar("access_token_expires_at", { length: 64 }),
  installedByUserId: varchar("installed_by_user_id", { length: 191 }).notNull(),
  revokedAt: varchar("revoked_at", { length: 64 }),
  createdAt: varchar("created_at", { length: 64 }).notNull(),
  updatedAt: varchar("updated_at", { length: 64 }).notNull(),
});

/** A Linear user who linked their Otter account; delegated issues run on `environmentId`. */
export const relayLinearUserLinks = pgTable(
  "relay_linear_user_links",
  {
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    linearUserId: varchar("linear_user_id", { length: 64 }).notNull(),
    linearUserName: text("linear_user_name").notNull(),
    organizationName: text("organization_name").notNull(),
    userId: varchar("user_id", { length: 191 }).notNull(),
    environmentId: varchar("environment_id", { length: 191 }).notNull(),
    /**
     * The person's own Linear sign-in, sealed like installation tokens. Their
     * environments read issues with it; null for links made before sign-in was kept.
     */
    accessTokenSealed: text("access_token_sealed"),
    refreshTokenSealed: text("refresh_token_sealed"),
    accessTokenExpiresAt: varchar("access_token_expires_at", { length: 64 }),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.linearUserId] }),
    index("idx_relay_linear_user_links_user").on(table.userId),
  ],
);

/** Delegated agent sessions, so a redelivered webhook never starts a second thread. */
export const relayLinearAgentSessions = pgTable(
  "relay_linear_agent_sessions",
  {
    agentSessionId: varchar("agent_session_id", { length: 64 }).primaryKey(),
    organizationId: varchar("organization_id", { length: 64 }).notNull(),
    userId: varchar("user_id", { length: 191 }),
    environmentId: varchar("environment_id", { length: 191 }),
    threadId: varchar("thread_id", { length: 512 }),
    issueIdentifier: varchar("issue_identifier", { length: 64 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().$type<"pending" | "launched" | "failed">(),
    createdAt: varchar("created_at", { length: 64 }).notNull(),
    updatedAt: varchar("updated_at", { length: 64 }).notNull(),
  },
  (table) => [index("idx_relay_linear_agent_sessions_updated").on(table.updatedAt)],
);
