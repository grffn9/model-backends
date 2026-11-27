import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Backend } from "./types.ts";

type Env = Record<string, string | undefined>;

/** How a Claude API backend authenticates: its API key wins, then the `ant auth login` sign-in. */
export type ClaudeCredential =
  | { type: "api-key"; apiKey: string }
  | { type: "sign-in"; profile: string }
  | { type: "none"; reason: string };

/** The profile names the Anthropic SDK accepts, so a name never escapes the config folder. */
const PROFILE_NAME = /^[A-Za-z0-9_.-]+$/;

const read = (env: Env, name: string) => env[name]?.trim() || undefined;

/** Finds the folder where `ant auth login` keeps profiles, the same way the Anthropic SDK does. */
export function antConfigDir(
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = read(env, "ANTHROPIC_CONFIG_DIR");
  if (configured) return configured;
  if (platform === "win32") {
    const appData = read(env, "APPDATA");
    if (appData) return path.join(appData, "Anthropic");
    const userProfile = read(env, "USERPROFILE");
    return userProfile ? path.join(userProfile, "AppData", "Roaming", "Anthropic") : null;
  }
  const xdg = read(env, "XDG_CONFIG_HOME");
  if (xdg) return path.join(xdg, "anthropic");
  const home = read(env, "HOME");
  return home ? path.join(home, ".config", "anthropic") : null;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Returns the profile the SDK would use if it holds a sign-in, or null. */
function findSignIn(env: Env): string | null {
  const dir = antConfigDir(env);
  if (!dir) return null;
  const profile =
    read(env, "ANTHROPIC_PROFILE") ??
    (readText(path.join(dir, "active_config"))?.trim() || "default");
  if (!PROFILE_NAME.test(profile) || profile === "." || profile === "..") return null;

  let auth: { type?: unknown; credentials_path?: unknown } | undefined;
  try {
    const config = JSON.parse(readText(path.join(dir, "configs", `${profile}.json`)) ?? "null");
    auth = config?.authentication;
  } catch {
    return null;
  }
  // Federation profiles exchange an identity token on each run, so they store no login.
  if (auth?.type === "oidc_federation") return profile;
  if (auth?.type !== "user_oauth") return null;
  const credentials =
    typeof auth.credentials_path === "string" && auth.credentials_path
      ? auth.credentials_path
      : path.join(dir, "credentials", `${profile}.json`);
  return isFile(credentials) ? profile : null;
}

/** Picks the credential a Claude API backend uses, matching the Anthropic SDK's precedence. */
export function claudeCredential(backend: Backend, env: Env = process.env): ClaudeCredential {
  const apiKey = backend.apiKeyEnv ? read(env, backend.apiKeyEnv) : undefined;
  if (apiKey) return { type: "api-key", apiKey };
  const profile = findSignIn(env);
  if (profile) return { type: "sign-in", profile };

  const named = read(env, "ANTHROPIC_PROFILE");
  const login = named ? `"ant auth login --profile ${named}"` : '"ant auth login"';
  return {
    type: "none",
    reason: backend.apiKeyEnv ? `Set ${backend.apiKeyEnv} or run ${login}` : `Run ${login}`,
  };
}
