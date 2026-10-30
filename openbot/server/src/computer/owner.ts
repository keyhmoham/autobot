/**
 * Who answers for a computer: a Bot's computer its owner, and a space's computer the space's owner.
 *
 * Asked wherever a computer's consequences land on a person: whose network rules it follows
 * (admin/controls.ts), and whose wallet pays for the minutes it runs (wallet/meter.ts).
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentProfiles } from "../db/schema";
import { spaceMembers } from "../db/schema/workspace";
import { isSpaceComputer } from "./computer-ref";

export async function computerOwner(
  database: Database,
  computerId: string,
): Promise<string | null> {
  if (isSpaceComputer(computerId)) {
    const [owner] = await database
      .select({ owner: spaceMembers.userId })
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, computerId),
          eq(spaceMembers.role, "owner"),
        ),
      )
      .limit(1);
    return owner?.owner ?? null;
  }
  const [profile] = await database
    .select({ owner: agentProfiles.ownerUserId })
    .from(agentProfiles)
    .where(eq(agentProfiles.agentId, computerId))
    .limit(1);
  return profile?.owner ?? null;
}
