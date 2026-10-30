/**
 * Personal access tokens: how the `openduet` CLI and a person's own scripts act as them. The secret
 * is kept only as a hash; the service is auth/access-tokens.ts.
 */
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./core";

export const accessTokens = pgTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** sha256 of the secret part, hex. The token itself is shown once, when it is made. */
    secretHash: text("secret_hash").notNull().unique(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("access_tokens_user_idx").on(table.userId, table.createdAt),
  ],
);
