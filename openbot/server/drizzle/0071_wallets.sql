CREATE TABLE "billing_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"signup_grant" bigint DEFAULT 0 NOT NULL,
	"grant_days" integer DEFAULT 30 NOT NULL,
	"computer_minute_price" bigint DEFAULT 0 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_settings_single_row" CHECK ("billing_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"type" text NOT NULL,
	"category" text,
	"from_user_id" text,
	"to_user_id" text,
	"amount" bigint NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"space_id" text,
	"agent_id" text,
	"reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_seq_unique" UNIQUE("seq"),
	CONSTRAINT "ledger_entries_amount_check" CHECK ("ledger_entries"."amount" > 0),
	CONSTRAINT "ledger_entries_type_check" CHECK ("ledger_entries"."type" IN ('mint', 'transfer', 'spend', 'expire')),
	CONSTRAINT "ledger_entries_category_check" CHECK ("ledger_entries"."category" IS NULL OR "ledger_entries"."category" IN ('llm', 'compute', 'app'))
);
--> statement-breakpoint
CREATE TABLE "space_budgets" (
	"space_id" text PRIMARY KEY NOT NULL,
	"cap" bigint DEFAULT 0 NOT NULL,
	"spent" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"remaining" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_grants_remaining_check" CHECK ("wallet_grants"."remaining" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" text PRIMARY KEY NOT NULL,
	"balance" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_budgets" ADD CONSTRAINT "space_budgets_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_grants" ADD CONSTRAINT "wallet_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_entries_from_idx" ON "ledger_entries" USING btree ("from_user_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_entries_to_idx" ON "ledger_entries" USING btree ("to_user_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_entries_space_idx" ON "ledger_entries" USING btree ("space_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_created_idx" ON "ledger_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "wallet_grants_user_idx" ON "wallet_grants" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "wallet_grants_due_idx" ON "wallet_grants" USING btree ("expires_at") WHERE "wallet_grants"."status" = 'active';