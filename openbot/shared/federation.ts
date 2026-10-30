/**
 * Federation, read from both sides: OpenDuet deployments (nodes) joined into one mesh around a
 * central node, and the shapes Admin → Federation is drawn from.
 *
 * A node is one deployment with its own database and its own people. The central node admits the
 * others (with a join code an administrator there made), gives each its node id, tells every node
 * about the others, and holds a replica of every node's ledger. Nodes talk to each other only with
 * requests signed by their own Ed25519 key, which the receiver checks against the key the central
 * node registered for the sender.
 */

export const NODE_STATUSES = ["online", "offline", "removed"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/** The headers a signed node-to-node request carries. */
export const FEDERATION_HEADERS = {
  node: "x-openduet-node",
  nonce: "x-openduet-nonce",
  timestamp: "x-openduet-timestamp",
  signature: "x-openduet-signature",
} as const;

/** How old a signed request may be, in seconds, before it is refused as stale. */
export const SIGNATURE_WINDOW_SECONDS = 300;

export type NodeWire = {
  id: string;
  name: string;
  url: string;
  publicKey: string;
  isCentral: boolean;
  status: NodeStatus;
  lastSeenAt: string | null;
};

export type SelfNodeWire = {
  /** Null until this node joins a mesh, or is the central node of one. */
  id: string | null;
  name: string;
  url: string | null;
  publicKey: string;
  isCentral: boolean;
};

export type JoinCodeWire = {
  id: string;
  label: string;
  expiresAt: string;
  usedByNodeId: string | null;
  usedAt: string | null;
  createdAt: string;
};

/** A node's ledger totals as the central node holds them, for the platform-wide view. */
export type NodeLedgerWire = {
  nodeId: string;
  name: string;
  entries: number;
  minted: number;
  spent: number;
  lastEntryAt: string | null;
};
