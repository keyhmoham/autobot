/**
 * Administering the deployment from a terminal: the model gateway's providers, models and roles,
 * billing, the federation, and reported posts. Administrators only; the server refuses anybody else.
 */
import { flag } from "../args";
import { type Command, type Context, encode } from "../command";
import { credits, show, table } from "../output";

const USAGE = [
  "admin providers [list | add <kind> [--name n] [--url u] [--key k] | import <provider> | remove <provider>]",
  "admin models [list | add <provider> <name> [--upstream u] [--in price] [--out price] | remove <model>]",
  "admin roles [list | set <chat|decision|embedding> <model-id|none>]",
  "admin usage [--days n]",
  "admin billing [show | set [--enabled true|false] [--signup-grant n] [--grant-days n] [--computer-price n] | mint <user-id> <credits> [--days n] | wallets [query]]",
  "admin federation [show | join-code [label] | join <central-url> <code> | remove <node>]",
  "admin reports [list [open|resolved|dismissed] | resolve|dismiss|remove|reopen <report>]",
].join("\n       openduet ");

const number = (context: Context, name: string) => {
  const value = flag(context.args, name);
  return value === undefined ? undefined : Number(value);
};

async function providers(context: Context) {
  const client = await context.client();
  const [, sub = "list", target] = context.args.positional;
  if (sub === "add") {
    const { provider } = await client.request<{
      provider: { id: string; name: string };
    }>("POST", "/api/admin/llm/providers", {
      kind: target,
      ...(flag(context.args, "name")
        ? { name: flag(context.args, "name") }
        : {}),
      ...(flag(context.args, "url")
        ? { baseUrl: flag(context.args, "url") }
        : {}),
      ...(flag(context.args, "key")
        ? { apiKey: flag(context.args, "key") }
        : {}),
    });
    return show(context.printer, provider, [
      `Added ${provider.name} (${provider.id}).`,
    ]);
  }
  if (sub === "import" && target) {
    const answer = await client.request<{ added: number; seen: number }>(
      "POST",
      `/api/admin/llm/providers/${encode(target)}/import`,
    );
    return show(context.printer, answer, [
      `The provider lists ${answer.seen} model(s); ${answer.added} new, disabled until you price and enable them.`,
    ]);
  }
  if (sub === "remove" && target) {
    await client.request(
      "DELETE",
      `/api/admin/llm/providers/${encode(target)}`,
    );
    return context.printer.out("Removed.");
  }
  const { providers } = await client.request<{
    providers: Record<string, unknown>[];
  }>("GET", "/api/admin/llm/providers");
  table(
    context.printer,
    providers,
    ["id", "kind", "name", "baseUrl", "hasKey", "enabled"],
    providers,
  );
}

async function models(context: Context) {
  const client = await context.client();
  const [, sub = "list", provider, name] = context.args.positional;
  if (sub === "add" && provider && name) {
    const { model } = await client.request<{
      model: { id: string; name: string };
    }>("POST", "/api/admin/llm/models", {
      providerId: provider,
      name,
      ...(flag(context.args, "upstream")
        ? { upstream: flag(context.args, "upstream") }
        : {}),
      ...(number(context, "in") !== undefined
        ? { inputPrice: number(context, "in") }
        : {}),
      ...(number(context, "out") !== undefined
        ? { outputPrice: number(context, "out") }
        : {}),
      enabled: true,
    });
    return show(context.printer, model, [`Added ${model.name} (${model.id}).`]);
  }
  if (sub === "remove" && provider) {
    await client.request("DELETE", `/api/admin/llm/models/${encode(provider)}`);
    return context.printer.out("Removed.");
  }
  const { models } = await client.request<{
    models: Record<string, unknown>[];
  }>("GET", "/api/admin/llm/models");
  table(
    context.printer,
    models,
    ["id", "name", "upstream", "inputPrice", "outputPrice", "enabled"],
    models,
  );
}

async function roles(context: Context) {
  const client = await context.client();
  const [, sub = "list", role, model] = context.args.positional;
  if (sub === "set" && role && model) {
    await client.request("PUT", `/api/admin/llm/roles/${encode(role)}`, {
      modelId: model === "none" ? null : model,
    });
    return context.printer.out(`${role} is now ${model}.`);
  }
  const answer = await client.request<{ roles: Record<string, string | null> }>(
    "GET",
    "/api/admin/llm/roles",
  );
  show(
    context.printer,
    answer,
    Object.entries(answer.roles).map(
      ([each, chosen]) => `${each}: ${chosen ?? "(none)"}`,
    ),
  );
}

async function usage(context: Context) {
  const client = await context.client();
  const answer = await client.request<{
    byModel: {
      model: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
      failed: number;
    }[];
  }>("GET", `/api/admin/llm/usage?days=${number(context, "days") ?? 30}`);
  table(
    context.printer,
    answer.byModel.map((row) => ({ ...row, cost: credits(row.cost) })),
    ["model", "calls", "inputTokens", "outputTokens", "cost", "failed"],
    answer,
  );
}

async function billing(context: Context) {
  const client = await context.client();
  const [, sub = "show", target, amount] = context.args.positional;
  if (sub === "set") {
    const enabled = flag(context.args, "enabled");
    const { settings } = await client.request<{ settings: unknown }>(
      "PUT",
      "/api/admin/billing/settings",
      {
        ...(enabled ? { enabled: enabled === "true" } : {}),
        ...(number(context, "signup-grant") !== undefined
          ? { signupGrant: number(context, "signup-grant") }
          : {}),
        ...(number(context, "grant-days") !== undefined
          ? { grantDays: number(context, "grant-days") }
          : {}),
        ...(number(context, "computer-price") !== undefined
          ? { computerMinutePrice: number(context, "computer-price") }
          : {}),
      },
    );
    return show(context.printer, settings, [JSON.stringify(settings)]);
  }
  if (sub === "mint" && target && amount) {
    const { wallet } = await client.request<{ wallet: { balance: number } }>(
      "POST",
      "/api/admin/billing/mint",
      {
        userId: target,
        amount: Number(amount),
        ...(number(context, "days")
          ? { expiresInDays: number(context, "days") }
          : {}),
      },
    );
    return show(context.printer, wallet, [
      `Added ${credits(Number(amount))}. Their balance is ${credits(wallet.balance)}.`,
    ]);
  }
  if (sub === "wallets") {
    const { wallets } = await client.request<{
      wallets: { userId: string; email: string; balance: number }[];
    }>("GET", `/api/admin/billing/wallets?q=${encode(target ?? "")}`);
    return table(
      context.printer,
      wallets.map((wallet) => ({
        ...wallet,
        balance: credits(wallet.balance),
      })),
      ["userId", "email", "balance"],
      wallets,
    );
  }
  const overview = await client.request<{
    settings: { enabled: boolean };
    minted: number;
    spent: { total: number; llm: number; compute: number; app: number };
    held: number;
    wallets: number;
  }>("GET", "/api/admin/billing/overview");
  show(context.printer, overview, [
    `Billing is ${overview.settings.enabled ? "on" : "off"}. Last 30 days:`,
    `  added ${credits(overview.minted)}, spent ${credits(overview.spent.total)} (models ${credits(overview.spent.llm)}, computers ${credits(overview.spent.compute)}, apps ${credits(overview.spent.app)})`,
    `  ${overview.wallets} wallet(s) hold ${credits(overview.held)}`,
  ]);
}

async function federation(context: Context) {
  const client = await context.client();
  const [, sub = "show", first, second] = context.args.positional;
  if (sub === "join-code") {
    const answer = await client.request<{ code: string }>(
      "POST",
      "/api/admin/federation/join-codes",
      {
        ...(first ? { label: first } : {}),
      },
    );
    return show(context.printer, answer, [
      `Join code (shown once): ${answer.code}`,
    ]);
  }
  if (sub === "join" && first && second) {
    const answer = await client.request<{ self: { id: string } }>(
      "POST",
      "/api/admin/federation/join",
      {
        centralUrl: first,
        code: second,
      },
    );
    return show(context.printer, answer, [`Joined as node ${answer.self.id}.`]);
  }
  if (sub === "remove" && first) {
    await client.request(
      "DELETE",
      `/api/admin/federation/nodes/${encode(first)}`,
    );
    return context.printer.out("Removed from the federation.");
  }
  const state = await client.request<{
    self: { id: string | null; name: string; isCentral: boolean };
    nodes: {
      id: string;
      name: string;
      url: string;
      status: string;
      isCentral: boolean;
    }[];
  }>("GET", "/api/admin/federation");
  if (!context.printer.json)
    context.printer.out(
      `This node: ${state.self.name} ${state.self.id ? `(${state.self.id})` : "(not in a federation)"}${state.self.isCentral ? ", central" : ""}`,
    );
  table(
    context.printer,
    state.nodes,
    ["id", "name", "url", "status", "isCentral"],
    state,
  );
}

async function reports(context: Context) {
  const client = await context.client();
  const [, sub = "list", target] = context.args.positional;
  if (["resolve", "dismiss", "remove", "reopen"].includes(sub) && target) {
    await client.request("POST", `/api/admin/reports/${encode(target)}`, {
      action: sub,
    });
    return context.printer.out("Done.");
  }
  const { reports } = await client.request<{
    reports: {
      id: string;
      reason: string;
      status: string;
      post: { body: string; author: { handle: string } };
    }[];
  }>("GET", `/api/admin/reports${target ? `?status=${encode(target)}` : ""}`);
  table(
    context.printer,
    reports.map((report) => ({
      id: report.id,
      status: report.status,
      reason: report.reason,
      author: `@${report.post.author.handle}`,
      post: report.post.body,
    })),
    ["id", "status", "reason", "author", "post"],
    reports,
  );
}

const areas: Record<string, (context: Context) => Promise<void>> = {
  providers,
  models,
  roles,
  usage,
  billing,
  federation,
  reports,
};

export const adminCommands: Command[] = [
  {
    name: "admin",
    summary: "Models, billing, federation and reports (administrators)",
    usage: USAGE,
    async run(context) {
      const area = areas[context.args.positional[0] ?? ""];
      if (!area) throw new Error(`usage: openduet ${USAGE}`);
      await area(context);
    },
  },
];
