/**
 * Who a gateway call is for, carried by the key it presents.
 *
 * A Bot never holds a vendor key. It is handed a gateway token instead: a short-lived statement this
 * deployment signed, naming whose wallet pays (the person the run is for), which Bot is calling and
 * for what, so the gateway can meter the call against the right person without trusting anything the
 * caller says about itself. A token is useless anywhere but this gateway and for anything but a model
 * call, and it expires with the run.
 *
 * A deployment key (`LLM_GATEWAY_KEY`) is the other kind: a long-lived secret for the deployment's
 * own model containers, which cannot be handed a token per run. Its calls are recorded against the
 * deployment, and nobody's wallet pays for them.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const PREFIX = "odg1";

/** What a call is for: a Bot's turn, or a decision the deployment makes on its own behalf. */
export type GatewayPurpose = "turn" | "decision" | "deployment";

export type GatewayCaller = {
  payerUserId: string | null;
  agentId: string | null;
  spaceId: string | null;
  purpose: GatewayPurpose;
};

type Payload = {
  u?: string;
  a?: string;
  s?: string;
  p: GatewayPurpose;
  e: number;
};

export type GatewayTokens = ReturnType<typeof createGatewayTokens>;

export function createGatewayTokens(options: {
  /** The deployment's KEY_ENCRYPTION_KEY, from which the signing key is derived and never reused. */
  encryptionKey: string;
  /** `LLM_GATEWAY_KEY`, for the deployment's own containers. Absent, none is accepted. */
  deploymentKey?: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const signingKey = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(options.encryptionKey, "base64"),
      Buffer.alloc(0),
      Buffer.from("openbot llm gateway token"),
      32,
    ),
  );
  const sign = (body: string) =>
    createHmac("sha256", signingKey).update(body).digest("base64url");

  return {
    /** A token for one run: an hour is longer than any turn and short enough to be worth nothing later. */
    issue(
      caller: Omit<GatewayCaller, "purpose"> & {
        purpose: Exclude<GatewayPurpose, "deployment">;
      },
      ttlMs = 3_600_000,
    ): string {
      const payload: Payload = {
        ...(caller.payerUserId ? { u: caller.payerUserId } : {}),
        ...(caller.agentId ? { a: caller.agentId } : {}),
        ...(caller.spaceId ? { s: caller.spaceId } : {}),
        p: caller.purpose,
        e: Math.floor((now() + ttlMs) / 1000),
      };
      const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
      return `${PREFIX}.${body}.${sign(body)}`;
    },

    /** Who the presented key speaks for, or null for a key this gateway did not issue. */
    verify(presented: string | null | undefined): GatewayCaller | null {
      const key = presented?.trim();
      if (!key) return null;
      if (options.deploymentKey && equal(key, options.deploymentKey))
        return {
          payerUserId: null,
          agentId: null,
          spaceId: null,
          purpose: "deployment",
        };
      const [prefix, body, signature] = key.split(".");
      if (
        prefix !== PREFIX ||
        !body ||
        !signature ||
        !equal(signature, sign(body))
      )
        return null;
      let payload: Payload;
      try {
        payload = JSON.parse(
          Buffer.from(body, "base64url").toString("utf8"),
        ) as Payload;
      } catch {
        return null;
      }
      if (typeof payload.e !== "number" || payload.e * 1000 < now())
        return null;
      if (payload.p !== "turn" && payload.p !== "decision") return null;
      return {
        payerUserId: payload.u ?? null,
        agentId: payload.a ?? null,
        spaceId: payload.s ?? null,
        purpose: payload.p,
      };
    },
  };
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
