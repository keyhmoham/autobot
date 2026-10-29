/**
 * The links an app is opened through.
 *
 * An app is served from this deployment's origin, under `/apps-view/<link>/`, inside a sandbox with
 * an opaque origin (shared/apps.ts APP_SANDBOX), so the frame cannot send the person's cookies. The
 * link is what says who is looking and at which app: signed here, short-lived, and carried in the
 * path so every request the app makes for its own files carries it too, which is why an app has to
 * refer to its files relatively.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { APP_LINK_HOURS } from "@openbot/shared/apps";

type Payload = { a: string; u: string; e: number };

export type AppLinks = ReturnType<typeof createAppLinks>;

export function createAppLinks(options: {
  encryptionKey: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(options.encryptionKey, "base64"),
      Buffer.alloc(0),
      Buffer.from("openduet app link"),
      32,
    ),
  );
  const sign = (body: string) =>
    createHmac("sha256", key).update(body).digest("base64url");

  return {
    issue(appId: string, userId: string, ttlMs = APP_LINK_HOURS * 3_600_000) {
      const body = Buffer.from(
        JSON.stringify({
          a: appId,
          u: userId,
          e: Math.floor((now() + ttlMs) / 1000),
        } satisfies Payload),
      ).toString("base64url");
      return `${body}.${sign(body)}`;
    },

    /** The app and the person a link names, or null for one this deployment did not sign or that ran out. */
    verify(link: string): { appId: string; userId: string } | null {
      const [body, signature] = link.split(".");
      if (!body || !signature) return null;
      const expected = Buffer.from(sign(body));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given))
        return null;
      try {
        const payload = JSON.parse(
          Buffer.from(body, "base64url").toString("utf8"),
        ) as Payload;
        if (payload.e * 1000 <= now()) return null;
        return { appId: payload.a, userId: payload.u };
      } catch {
        return null;
      }
    },
  };
}
