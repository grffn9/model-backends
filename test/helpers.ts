import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Account, Backend, GenerateInput, OutputEvent } from "../src/types.ts";

export function makeBackend(overrides: Partial<Backend> & { id: string }): Backend {
  return {
    label: overrides.id,
    account: "main",
    adapter: "openai",
    model: "test-model",
    efforts: [],
    price: { input: 0, output: 0 },
    requiresEnv: [],
    env: {},
    ...overrides,
  };
}

export function makeAccount(id: string, overrides: Partial<Account> = {}): Account {
  return { id, label: id, kind: "subscription", limits: [], limitScope: "account", ...overrides };
}

export type Script = (input: GenerateInput) => AsyncIterable<OutputEvent>;

export function replies(text: string): Script {
  return async function* () {
    yield { type: "text", text };
  };
}

export function fails(error: Error): Script {
  // eslint-disable-next-line require-yield
  return async function* () {
    throw error;
  };
}

const antFolders: string[] = [];

/**
 * Makes a config folder laid out the way `ant auth login` leaves it, for ANTHROPIC_CONFIG_DIR.
 * `loggedOut` profiles keep their config but lose their tokens.
 */
export function antFolder(
  profiles: string[] = ["default"],
  options: { active?: string; loggedOut?: string[]; token?: string } = {},
): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "model-backends-ant-"));
  antFolders.push(dir);
  mkdirSync(path.join(dir, "configs"));
  mkdirSync(path.join(dir, "credentials"));
  for (const profile of profiles) {
    const config = { version: "1.0", authentication: { type: "user_oauth", client_id: "test" } };
    writeFileSync(path.join(dir, "configs", `${profile}.json`), JSON.stringify(config));
    if (options.loggedOut?.includes(profile)) continue;
    const credentials = {
      version: "1.0",
      type: "oauth_token",
      access_token: options.token ?? "sign-in-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    writeFileSync(path.join(dir, "credentials", `${profile}.json`), JSON.stringify(credentials), {
      mode: 0o600,
    });
  }
  if (options.active) writeFileSync(path.join(dir, "active_config"), `${options.active}\n`);
  return dir;
}

export function removeAntFolders(): void {
  for (const dir of antFolders.splice(0)) rmSync(dir, { recursive: true, force: true });
}
