ALTER TABLE "relay_linear_user_links" ADD COLUMN "access_token_sealed" text;--> statement-breakpoint
ALTER TABLE "relay_linear_user_links" ADD COLUMN "refresh_token_sealed" text;--> statement-breakpoint
ALTER TABLE "relay_linear_user_links" ADD COLUMN "access_token_expires_at" varchar(64);