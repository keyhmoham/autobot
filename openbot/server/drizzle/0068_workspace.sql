CREATE TABLE "room_desks" (
	"room_id" text PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"viewport" jsonb DEFAULT '{"w":0,"h":0}'::jsonb NOT NULL,
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_members" (
	"room_id" text NOT NULL,
	"user_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "room_members_room_id_user_id_pk" PRIMARY KEY("room_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"topic" text DEFAULT '' NOT NULL,
	"icon" text NOT NULL,
	"colour" text NOT NULL,
	"visibility" text DEFAULT 'open' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rooms_visibility_check" CHECK ("rooms"."visibility" IN ('open', 'private')),
	CONSTRAINT "rooms_icon_check" CHECK ("rooms"."icon" IN ('check', 'calendar', 'mail', 'dollar', 'chart', 'globe', 'pin', 'home', 'cube', 'video', 'folder', 'pencil', 'search', 'heart', 'people', 'briefcase', 'book', 'plane', 'car', 'food', 'bag', 'gift', 'sprout', 'music')),
	CONSTRAINT "rooms_colour_check" CHECK ("rooms"."colour" IN ('berry', 'blush', 'peach', 'amber', 'sage', 'green', 'sky', 'blue', 'lavender'))
);
--> statement-breakpoint
CREATE TABLE "space_agents" (
	"space_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"added_by_user_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_agents_space_id_agent_id_pk" PRIMARY KEY("space_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "space_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"room_id" text,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text,
	"responded_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_invitations_status_check" CHECK ("space_invitations"."status" IN ('pending', 'accepted', 'declined', 'revoked')),
	CONSTRAINT "space_invitations_role_check" CHECK ("space_invitations"."role" IN ('admin', 'member', 'guest'))
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invited_by_user_id" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_space_id_user_id_pk" PRIMARY KEY("space_id","user_id"),
	CONSTRAINT "space_members_role_check" CHECK ("space_members"."role" IN ('owner', 'admin', 'member', 'guest'))
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by_user_id" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text NOT NULL,
	"colour" text NOT NULL,
	"kind" text NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"home_of_user_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_kind_check" CHECK ("spaces"."kind" IN ('home', 'team')),
	CONSTRAINT "spaces_visibility_check" CHECK ("spaces"."visibility" IN ('private', 'public')),
	CONSTRAINT "spaces_icon_check" CHECK ("spaces"."icon" IN ('check', 'calendar', 'mail', 'dollar', 'chart', 'globe', 'pin', 'home', 'cube', 'video', 'folder', 'pencil', 'search', 'heart', 'people', 'briefcase', 'book', 'plane', 'car', 'food', 'bag', 'gift', 'sprout', 'music')),
	CONSTRAINT "spaces_colour_check" CHECK ("spaces"."colour" IN ('berry', 'blush', 'peach', 'amber', 'sage', 'green', 'sky', 'blue', 'lavender')),
	CONSTRAINT "spaces_home_has_person_check" CHECK (("spaces"."kind" = 'home') = ("spaces"."home_of_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "group_bot_threads" RENAME TO "channel_agent_threads";--> statement-breakpoint
ALTER TABLE "group_messages" RENAME TO "channel_messages";--> statement-breakpoint
ALTER TABLE "channel_agent_threads" RENAME COLUMN "owner_user_id" TO "actor_user_id";--> statement-breakpoint
ALTER TABLE "channel_messages" RENAME COLUMN "owner_user_id" TO "actor_user_id";--> statement-breakpoint
ALTER TABLE "channel_messages" DROP CONSTRAINT "group_messages_status_check";--> statement-breakpoint
ALTER TABLE "channel_agent_threads" DROP CONSTRAINT "group_bot_threads_owner_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_agent_threads" DROP CONSTRAINT "group_bot_threads_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_messages" DROP CONSTRAINT "group_messages_channel_id_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "channel_messages" DROP CONSTRAINT "group_messages_owner_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "group_bot_threads_thread_idx";--> statement-breakpoint
DROP INDEX "group_messages_channel_idx";--> statement-breakpoint
ALTER TABLE "channel_agent_threads" DROP CONSTRAINT "group_bot_threads_owner_user_id_channel_id_agent_id_pk";--> statement-breakpoint
ALTER TABLE "channel_agent_threads" ADD CONSTRAINT "channel_agent_threads_actor_user_id_channel_id_agent_id_pk" PRIMARY KEY("actor_user_id","channel_id","agent_id");--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "kind" text DEFAULT 'assistant' NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "room_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "direct_key" text;--> statement-breakpoint
ALTER TABLE "room_desks" ADD CONSTRAINT "room_desks_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_agents" ADD CONSTRAINT "space_agents_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_agents" ADD CONSTRAINT "space_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_agents" ADD CONSTRAINT "space_agents_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invitations" ADD CONSTRAINT "space_invitations_responded_by_user_id_users_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_home_of_user_id_users_id_fk" FOREIGN KEY ("home_of_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_members_user_idx" ON "room_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "rooms_space_idx" ON "rooms" USING btree ("space_id","position");--> statement-breakpoint
CREATE INDEX "space_agents_agent_idx" ON "space_agents" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "space_invitations_token_idx" ON "space_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "space_invitations_email_idx" ON "space_invitations" USING btree (lower("email"),"status");--> statement-breakpoint
CREATE UNIQUE INDEX "space_invitations_pending_idx" ON "space_invitations" USING btree ("space_id",lower("email")) WHERE "space_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "space_members_user_idx" ON "space_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_home_of_user_idx" ON "spaces" USING btree ("home_of_user_id") WHERE "spaces"."home_of_user_id" is not null;--> statement-breakpoint
CREATE INDEX "spaces_public_idx" ON "spaces" USING btree ("created_at") WHERE "spaces"."visibility" = 'public' and "spaces"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agent_threads" ADD CONSTRAINT "channel_agent_threads_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_agent_threads" ADD CONSTRAINT "channel_agent_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channels_room_idx" ON "channels" USING btree ("room_id") WHERE "channels"."room_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_direct_key_idx" ON "channels" USING btree ("direct_key") WHERE "channels"."direct_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_agent_threads_thread_idx" ON "channel_agent_threads" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "channel_messages_channel_idx" ON "channel_messages" USING btree ("channel_id","created_at","id");--> statement-breakpoint
UPDATE "channels" SET "kind" = 'task' WHERE "id" IN (SELECT "channel_id" FROM "openduet_tasks");--> statement-breakpoint
-- Turns still queued under the group engine's name are the shared conversation engine's now.
UPDATE "work_items"
  SET "kind" = 'conversation.turn',
      "payload" = ("payload" - 'ownerUserId') || jsonb_build_object('actorUserId', "payload"->'ownerUserId')
  WHERE "kind" = 'group.turn';--> statement-breakpoint

/*
 * Conversations that were already shared or already named workstreams become room channels.
 *
 * A person's own dressed OpenDuet channel moves into their home space's General room. A group
 * conversation with one person in it does the same; one with several people becomes a team space of
 * its own, owned by the person who started it, so nobody is let into anybody's home space. Each Bot
 * keeps answering each person in the thread it already had, and the Bots join the space.
 */
DO $$
DECLARE
  conversation record;
  person_count integer;
  starter text;
  target_space text;
  target_room text;
BEGIN
  FOR conversation IN
    SELECT c."id", c."name", c."created_at"
    FROM "channels" c
    WHERE c."kind" = 'assistant' AND c."deleted_at" IS NULL
      AND (
        EXISTS (SELECT 1 FROM "openduet_channels" o WHERE o."channel_id" = c."id")
        OR (SELECT count(*) FROM "channel_agents" a WHERE a."channel_id" = c."id") >= 2
      )
  LOOP
    SELECT count(*) INTO person_count FROM "channel_memberships" m WHERE m."channel_id" = conversation."id";
    SELECT m."user_id" INTO starter FROM "channel_memberships" m
      WHERE m."channel_id" = conversation."id" ORDER BY m."created_at", m."user_id" LIMIT 1;
    CONTINUE WHEN starter IS NULL;

    IF person_count = 1 THEN
      SELECT s."id" INTO target_space FROM "spaces" s WHERE s."home_of_user_id" = starter;
      IF target_space IS NULL THEN
        target_space := 'space_' || gen_random_uuid();
        INSERT INTO "spaces" ("id", "created_by_user_id", "name", "icon", "colour", "kind", "home_of_user_id")
          VALUES (target_space, starter, 'Home', 'home', 'sky', 'home', starter);
        INSERT INTO "space_members" ("space_id", "user_id", "role") VALUES (target_space, starter, 'owner');
      END IF;
      SELECT r."id" INTO target_room FROM "rooms" r
        WHERE r."space_id" = target_space AND r."deleted_at" IS NULL ORDER BY r."position", r."created_at" LIMIT 1;
      IF target_room IS NULL THEN
        target_room := 'room_' || gen_random_uuid();
        INSERT INTO "rooms" ("id", "space_id", "name", "icon", "colour", "created_by_user_id")
          VALUES (target_room, target_space, 'General', 'people', 'sky', starter);
      END IF;
    ELSE
      target_space := 'space_' || gen_random_uuid();
      INSERT INTO "spaces" ("id", "created_by_user_id", "name", "icon", "colour", "kind")
        VALUES (target_space, starter, left(conversation."name", 60), 'people', 'lavender', 'team');
      INSERT INTO "space_members" ("space_id", "user_id", "role", "joined_at")
        SELECT target_space, m."user_id", CASE WHEN m."user_id" = starter THEN 'owner' ELSE 'member' END, m."created_at"
        FROM "channel_memberships" m WHERE m."channel_id" = conversation."id";
      target_room := 'room_' || gen_random_uuid();
      INSERT INTO "rooms" ("id", "space_id", "name", "icon", "colour", "created_by_user_id")
        VALUES (target_room, target_space, 'General', 'people', 'lavender', starter);
    END IF;

    INSERT INTO "space_agents" ("space_id", "agent_id", "added_by_user_id")
      SELECT target_space, a."agent_id", starter FROM "channel_agents" a WHERE a."channel_id" = conversation."id"
      ON CONFLICT DO NOTHING;
    -- A person's own conversation keeps its Intelligence thread as each of its Bots' thread for them.
    INSERT INTO "channel_agent_threads" ("actor_user_id", "channel_id", "agent_id", "thread_id")
      SELECT i."user_id", i."channel_id", a."agent_id", i."thread_id"
      FROM "intelligence_channel_mappings" i
      JOIN "channel_agents" a ON a."channel_id" = i."channel_id"
      WHERE i."channel_id" = conversation."id"
        AND (SELECT count(*) FROM "channel_agents" x WHERE x."channel_id" = i."channel_id") = 1
      ON CONFLICT DO NOTHING;
    DELETE FROM "intelligence_channel_mappings" WHERE "channel_id" = conversation."id";
    UPDATE "channels" SET "kind" = 'room', "room_id" = target_room, "created_by_user_id" = starter
      WHERE "id" = conversation."id";
    target_space := NULL;
    target_room := NULL;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_kind_check" CHECK ("channels"."kind" IN ('assistant', 'task', 'room', 'direct'));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_room_kind_check" CHECK (("channels"."kind" = 'room') = ("channels"."room_id" is not null));--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_direct_kind_check" CHECK (("channels"."kind" = 'direct') = ("channels"."direct_key" is not null));--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_status_check" CHECK ("channel_messages"."status" IN ('queued', 'running', 'waiting', 'completed', 'failed'));