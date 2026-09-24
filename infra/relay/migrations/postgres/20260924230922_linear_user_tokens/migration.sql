CREATE TABLE "relay_linear_user_tokens" (
	"user_id" varchar(191) PRIMARY KEY,
	"organization_id" varchar(64) NOT NULL,
	"organization_name" text NOT NULL,
	"linear_user_name" text NOT NULL,
	"access_token_sealed" text NOT NULL,
	"refresh_token_sealed" text,
	"access_token_expires_at" varchar(64),
	"updated_at" varchar(64) NOT NULL
);
