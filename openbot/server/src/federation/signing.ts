/**
 * How one node proves a request is its own: an Ed25519 signature over the method, the path, a fresh
 * nonce, the time, and a hash of the body. The receiver checks it against the sender's registered
 * public key, refuses it once it is older than the window, and refuses its nonce a second time.
 *
 * Keys travel as the raw 32 bytes in base64url (a JWK's `x` and `d`), which is what both
 * `node:crypto` and any other Ed25519 implementation read without a wrapper format.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  FEDERATION_HEADERS,
  SIGNATURE_WINDOW_SECONDS,
} from "@openbot/shared/federation";

export type NodeKeyPair = { publicKey: string; privateKey: string };

export function generateNodeKeys(): NodeKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return {
    publicKey: publicKey.export({ format: "jwk" }).x as string,
    privateKey: jwk.d as string,
  };
}

/**
 * A node id: when it was made, in milliseconds, then randomness, so ids sort by age and two nodes
 * admitted in the same millisecond still differ.
 */
export function newNodeId(now = Date.now()): string {
  return `nd_${now.toString(16).padStart(12, "0")}${randomBytes(4).toString("hex")}`;
}

function payload(
  method: string,
  path: string,
  nonce: string,
  timestamp: string,
  body: string,
) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return Buffer.from(
    `${method.toUpperCase()}\n${path}\n${nonce}\n${timestamp}\n${bodyHash}`,
  );
}

/** The headers that sign a request from `nodeId`. */
export function signRequest(input: {
  nodeId: string;
  keys: NodeKeyPair;
  method: string;
  path: string;
  body: string;
  now?: number;
}): Record<string, string> {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor((input.now ?? Date.now()) / 1000));
  const key = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: input.keys.publicKey,
      d: input.keys.privateKey,
    },
    format: "jwk",
  });
  const signature = sign(
    null,
    payload(input.method, input.path, nonce, timestamp, input.body),
    key,
  ).toString("base64url");
  return {
    [FEDERATION_HEADERS.node]: input.nodeId,
    [FEDERATION_HEADERS.nonce]: nonce,
    [FEDERATION_HEADERS.timestamp]: timestamp,
    [FEDERATION_HEADERS.signature]: signature,
  };
}

export type SignatureCheck =
  | { ok: true; nodeId: string; nonce: string }
  | { ok: false; reason: string };

/**
 * Whether a request carries a good signature from the node it names. The nonce is returned for the
 * caller to record; this does not decide whether it was seen before.
 */
export async function checkSignature(input: {
  headers: Headers;
  method: string;
  path: string;
  body: string;
  publicKeyOf: (nodeId: string) => Promise<string | null>;
  now?: number;
}): Promise<SignatureCheck> {
  const nodeId = input.headers.get(FEDERATION_HEADERS.node);
  const nonce = input.headers.get(FEDERATION_HEADERS.nonce);
  const timestamp = input.headers.get(FEDERATION_HEADERS.timestamp);
  const signature = input.headers.get(FEDERATION_HEADERS.signature);
  if (!nodeId || !nonce || !timestamp || !signature)
    return { ok: false, reason: "The request is not signed." };
  if (!/^\d+$/.test(timestamp) || !/^[0-9a-f]{16,64}$/.test(nonce))
    return { ok: false, reason: "The request's signature is malformed." };
  const age = Math.floor((input.now ?? Date.now()) / 1000) - Number(timestamp);
  if (Math.abs(age) > SIGNATURE_WINDOW_SECONDS)
    return { ok: false, reason: "The request is too old." };
  const publicKey = await input.publicKeyOf(nodeId);
  if (!publicKey)
    return { ok: false, reason: "The sending node is not registered here." };
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKey },
      format: "jwk",
    });
    const good = verify(
      null,
      payload(input.method, input.path, nonce, timestamp, input.body),
      key,
      Buffer.from(signature, "base64url"),
    );
    return good
      ? { ok: true, nodeId, nonce }
      : { ok: false, reason: "The request's signature does not match." };
  } catch {
    return { ok: false, reason: "The request's signature is malformed." };
  }
}
