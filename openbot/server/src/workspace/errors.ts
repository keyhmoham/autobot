/**
 * The three ways a workspace request fails, each with its own status.
 *
 * NOT FOUND is also what a person outside a space hears about it, whether it exists or not, so being
 * in a space is not something an outsider can probe for. FORBIDDEN is for somebody inside who lacks
 * the permission: they can already see the thing, so saying it exists hides nothing. REFUSED is a
 * request that can never succeed as sent.
 */
export class WorkspaceNotFoundError extends Error {
  constructor(what = "That") {
    super(`${what} was not found.`);
    this.name = "WorkspaceNotFoundError";
  }
}

export class WorkspaceForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceForbiddenError";
  }
}

export class WorkspaceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRefusedError";
  }
}
