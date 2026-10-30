CREATE TABLE "llm_models" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"name" text NOT NULL,
	"upstream" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"capabilities" text[] DEFAULT '{"chat"}' NOT NULL,
	"input_price" double precision DEFAULT 0 NOT NULL,
	"output_price" double precision DEFAULT 0 NOT NULL,
	"context_window" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"protocol" text NOT NULL,
	"credential_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_protocol_check" CHECK ("llm_providers"."protocol" IN ('openai', 'anthropic'))
);
--> statement-breakpoint
CREATE TABLE "llm_roles" (
	"role" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_roles_role_check" CHECK ("llm_roles"."role" IN ('chat', 'decision', 'embedding'))
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" text,
	"model_name" text NOT NULL,
	"provider_id" text,
	"payer_user_id" text,
	"agent_id" text,
	"space_id" text,
	"purpose" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_models" ADD CONSTRAINT "llm_models_provider_id_llm_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_roles" ADD CONSTRAINT "llm_roles_model_id_llm_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."llm_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_models_name_idx" ON "llm_models" USING btree ("name");--> statement-breakpoint
CREATE INDEX "llm_usage_created_idx" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_payer_idx" ON "llm_usage" USING btree ("payer_user_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_space_idx" ON "llm_usage" USING btree ("space_id","created_at") WHERE "llm_usage"."space_id" is not null;