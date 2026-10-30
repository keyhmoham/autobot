/**
 * Where the CLI keeps which deployment it talks to and the token it talks with: one small file in the
 * person's config directory, readable only by them. OPENDUET_URL and OPENDUET_TOKEN override it, for
 * scripts and CI that should not write anything to disk.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CliConfig = { server: string; token: string };

export function configPath(env: NodeJS.ProcessEnv = process.env) {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "openduet", "config.json");
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Partial<CliConfig>> {
  const stored = JSON.parse(
    await readFile(configPath(env), "utf8").catch(() => "{}"),
  ) as Partial<CliConfig>;
  return {
    ...stored,
    ...(env.OPENDUET_URL?.trim() ? { server: env.OPENDUET_URL.trim() } : {}),
    ...(env.OPENDUET_TOKEN?.trim() ? { token: env.OPENDUET_TOKEN.trim() } : {}),
  };
}

export async function saveConfig(
  config: CliConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

export async function forgetConfig(env: NodeJS.ProcessEnv = process.env) {
  await rm(configPath(env), { force: true });
}
