CREATE TABLE "space_apps" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '🧩' NOT NULL,
	"path" text NOT NULL,
	"build_command" text,
	"start_command" text NOT NULL,
	"port" integer NOT NULL,
	"status" text DEFAULT 'installing' NOT NULL,
	"error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_apps_status_check" CHECK ("space_apps"."status" IN ('installing', 'running', 'stopped', 'failed')),
	CONSTRAINT "space_apps_port_check" CHECK ("space_apps"."port" between 20000 and 39999)
);
--> statement-breakpoint
ALTER TABLE "space_apps" ADD CONSTRAINT "space_apps_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_apps" ADD CONSTRAINT "space_apps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "space_apps_slug_idx" ON "space_apps" USING btree ("space_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "space_apps_port_idx" ON "space_apps" USING btree ("port");