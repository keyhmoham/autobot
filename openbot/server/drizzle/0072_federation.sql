CREATE TABLE "federation_join_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_by_node_id" text,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_join_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "federation_ledger" (
	"origin_node_id" text NOT NULL,
	"origin_seq" bigint NOT NULL,
	"entry_id" text NOT NULL,
	"type" text NOT NULL,
	"category" text,
	"from_user_id" text,
	"to_user_id" text,
	"amount" bigint NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_ledger_origin_node_id_origin_seq_pk" PRIMARY KEY("origin_node_id","origin_seq")
);
--> statement-breakpoint
CREATE TABLE "federation_ledger_cursors" (
	"node_id" text PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "federation_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"public_key" text NOT NULL,
	"is_central" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'online' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_nodes_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "federation_nodes_status_check" CHECK ("federation_nodes"."status" IN ('online', 'offline', 'removed'))
);
--> statement-breakpoint
CREATE TABLE "federation_nonces" (
	"node_id" text NOT NULL,
	"nonce" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_nonces_node_id_nonce_pk" PRIMARY KEY("node_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "federation_self" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"node_id" text,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"is_central" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "federation_self_single_row" CHECK ("federation_self"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "federation_transfers" (
	"id" text PRIMARY KEY NOT NULL,
	"from_user_id" text NOT NULL,
	"node_id" text NOT NULL,
	"recipient" text NOT NULL,
	"amount" bigint NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "federation_join_codes" ADD CONSTRAINT "federation_join_codes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_transfers" ADD CONSTRAINT "federation_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "federation_nonces_seen_idx" ON "federation_nonces" USING btree ("seen_at");--> statement-breakpoint
CREATE INDEX "federation_transfers_pending_idx" ON "federation_transfers" USING btree ("created_at") WHERE "federation_transfers"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_reference_unique" ON "ledger_entries" USING btree ("reference") WHERE "ledger_entries"."reference" is not null;