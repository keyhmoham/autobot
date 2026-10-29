/**
 * The apps installed in each space. The vocabulary is shared/apps.ts; the service is apps/service.ts.
 * An app's code is in the space computer's workspace, not here: this is what the space knows about
 * it, and which port and service name it runs as.
 */
import type { AppStatus } from "@openbot/shared/apps";
import { APP_STATUSES } from "@openbot/shared/apps";
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./core";
import { spaces } from "./workspace";

const oneOf = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

export const spaceApps = pgTable(
  "space_apps",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    icon: text("icon").notNull().default("🧩"),
    /** Relative to the computer's workspace. */
    path: text("path").notNull(),
    buildCommand: text("build_command"),
    startCommand: text("start_command").notNull(),
    /**
     * Unique across the deployment rather than per space, because in a deployment whose computers
     * are shared one container runs every space's apps.
     */
    port: integer("port").notNull(),
    status: text("status").$type<AppStatus>().notNull().default("installing"),
    error: text("error"),
    /** Counts installs, so a frame showing an older build knows to reload. */
    version: integer("version").notNull().default(1),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByAgentId: text("created_by_agent_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("space_apps_slug_idx").on(table.spaceId, table.slug),
    uniqueIndex("space_apps_port_idx").on(table.port),
    check(
      "space_apps_status_check",
      sql`${table.status} IN (${oneOf(APP_STATUSES)})`,
    ),
    check("space_apps_port_check", sql`${table.port} between 20000 and 39999`),
  ],
);
