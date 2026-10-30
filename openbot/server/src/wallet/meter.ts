/**
 * What running costs: computer minutes charged to whoever answers for each computer, and grants
 * lapsing on their dates.
 *
 * Once a minute, every running computer is charged a minute at the deployment's price: a Bot's
 * computer to the Bot's owner, a space's computer to the space's owner and against the space's
 * budget. Before charging, the meter asks whether another minute may run; when the answer is no
 * (an empty wallet, a spent budget) the computer is stopped, keeping its files, and starts again the
 * next time somebody can pay for it.
 *
 * Only one replica should run this: `start` is called by whichever process holds the deployment's
 * background work (the same one that runs the other periodic sweeps).
 */
import { isSpaceComputer } from "../computer/computer-ref";
import type { Wallets } from "./service";

export type ComputerMeterDeps = {
  wallets: Pick<Wallets, "settings" | "admit" | "charge" | "expireGrants">;
  /** Every computer and whether it is running now. */
  computers: () => Promise<{ botId: string; running: boolean }[]>;
  /** Who answers for a computer. */
  ownerOf: (computerId: string) => Promise<string | null>;
  /** Stop a computer whose owner cannot pay for another minute. */
  stop: (computerId: string, reason: string) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
};

export function createComputerMeter(deps: ComputerMeterDeps) {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));

  /** One minute's charges. Returns what it did, for tests and logs. */
  async function tick() {
    const charged: string[] = [];
    const stopped: string[] = [];
    await deps.wallets
      .expireGrants(now())
      .catch((error) =>
        log(
          JSON.stringify({ type: "grant-expiry-failed", error: String(error) }),
        ),
      );
    const price = (await deps.wallets.settings()).computerMinutePrice;
    if (price <= 0) return { charged, stopped };
    const minute = now().toISOString().slice(0, 16);
    for (const computer of await deps.computers()) {
      if (!computer.running) continue;
      try {
        const payerUserId = await deps.ownerOf(computer.botId);
        const spaceId = isSpaceComputer(computer.botId) ? computer.botId : null;
        const admitted = await deps.wallets.admit({ payerUserId, spaceId });
        if (!admitted.ok) {
          await deps.stop(computer.botId, admitted.message);
          stopped.push(computer.botId);
          continue;
        }
        await deps.wallets.charge({
          payerUserId,
          amount: price,
          category: "compute",
          description: spaceId
            ? "A minute of the space's computer"
            : "A minute of a Bot's computer",
          spaceId,
          agentId: spaceId ? null : computer.botId,
          reference: `computer:${computer.botId}:${minute}`,
        });
        charged.push(computer.botId);
      } catch (error) {
        log(
          JSON.stringify({
            type: "computer-minute-not-charged",
            computer: computer.botId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    return { charged, stopped };
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  return {
    tick,
    start(intervalMs = 60_000) {
      timer ??= setInterval(() => {
        // A slow tick is never overlapped by the next, which would charge the same minute twice.
        if (busy) return;
        busy = true;
        void tick().finally(() => {
          busy = false;
        });
      }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
