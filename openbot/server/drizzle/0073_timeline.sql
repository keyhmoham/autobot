CREATE TABLE "timeline_cursors" (
	"feed" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ref" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timeline_entities_kind_check" CHECK ("timeline_entities"."kind" IN ('space', 'room', 'channel', 'person', 'agent', 'model', 'app'))
);
--> statement-breakpoint
CREATE TABLE "timeline_statements" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"phrase" text NOT NULL,
	"object_id" text,
	"value" text,
	"qualifiers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"state_key" text,
	"source_key" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timeline_entities" ADD CONSTRAINT "timeline_entities_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_statements" ADD CONSTRAINT "timeline_statements_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_statements" ADD CONSTRAINT "timeline_statements_subject_id_timeline_entities_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."timeline_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_statements" ADD CONSTRAINT "timeline_statements_object_id_timeline_entities_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."timeline_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_entities_ref_idx" ON "timeline_entities" USING btree ("space_id","kind","ref");--> statement-breakpoint
CREATE INDEX "timeline_entities_name_idx" ON "timeline_entities" USING btree ("space_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_statements_source_idx" ON "timeline_statements" USING btree ("space_id","source_key");--> statement-breakpoint
CREATE INDEX "timeline_statements_at_idx" ON "timeline_statements" USING btree ("space_id","at");--> statement-breakpoint
CREATE INDEX "timeline_statements_subject_idx" ON "timeline_statements" USING btree ("subject_id","at");--> statement-breakpoint
CREATE INDEX "timeline_statements_object_idx" ON "timeline_statements" USING btree ("object_id","at");--> statement-breakpoint
CREATE INDEX "timeline_statements_state_idx" ON "timeline_statements" USING btree ("space_id","state_key","at") WHERE "timeline_statements"."state_key" is not null;