/**
 * Naming the computer an action reaches, apart from the Bot that reaches it. Its own module, with no
 * imports, so the code that only needs to tell a space's computer from a Bot's does not load the gateway.
 */

/**
 * Which computer an action reaches, and which Bot reaches it.
 *
 * Two different questions that used to have one answer. A Bot working for one person uses a computer
 * of its own, so the two ids are the same (`ownComputer`). A Bot answering in a space's channel uses
 * the space's computer, which every room and channel of the space and every Bot in it shares
 * (`spaceComputer`): the policy and the trail still name the Bot that acted, and everything the
 * computer holds (its pages, its snapshots, who has the wheel) belongs to the computer.
 */
export type ComputerRef = { botId: string; computerId: string };

/** A Bot's own computer. */
export function ownComputer(botId: string): ComputerRef {
  return { botId, computerId: botId };
}

/** A space's computer, reached by one of the space's Bots. Its id is the space's. */
export function spaceComputer(spaceId: string, botId: string): ComputerRef {
  return { botId, computerId: spaceId };
}

/** Whether a computer id is a space's rather than a Bot's. Space ids are `space_<uuid>`. */
export function isSpaceComputer(computerId: string): boolean {
  return computerId.startsWith("space_");
}
