CREATE TABLE "relay_linear_agent_sessions" (
	"agent_session_id" varchar(64) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"user_id" varchar(191),
	"environment_id" varchar(191),
	"thread_id" varchar(512),
	"issue_identifier" varchar(64) NOT NULL,
	"status" varchar(32) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_linear_installations" (
	"organization_id" varchar(64) PRIMARY KEY,
	"organization_name" text NOT NULL,
	"app_user_id" varchar(64) NOT NULL,
	"access_token_sealed" text NOT NULL,
	"refresh_token_sealed" text,
	"access_token_expires_at" varchar(64),
	"installed_by_user_id" varchar(191) NOT NULL,
	"revoked_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_linear_user_links" (
	"organization_id" varchar(64),
	"linear_user_id" varchar(64),
	"linear_user_name" text NOT NULL,
	"organization_name" text NOT NULL,
	"user_id" varchar(191) NOT NULL,
	"environment_id" varchar(191) NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_linear_user_links_pkey" PRIMARY KEY("organization_id","linear_user_id")
);
--> statement-breakpoint
CREATE INDEX "idx_relay_linear_agent_sessions_updated" ON "relay_linear_agent_sessions" ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_relay_linear_user_links_user" ON "relay_linear_user_links" ("user_id");