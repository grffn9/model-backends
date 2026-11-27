import { statSync } from "node:fs";
import path from "node:path";
import { claudeCredential } from "./claude-auth.ts";
import type { Backend } from "./types.ts";

type Env = Record<string, string | undefined>;

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Finds a command on PATH, honoring PATHEXT on Windows. */
export function findCommand(command: string, env: Env = process.env): string | null {
  const extensions =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  const pathValue = env.PATH ?? env.Path ?? "";
  const folders = command.includes(path.sep) ? [""] : pathValue.split(path.delimiter);
  for (const folder of folders) {
    for (const extension of extensions) {
      const candidate = path.join(folder, command + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Wraps a command lookup so each command is searched for at most once. Searching PATH is slow on
 * Windows, so make one per check rather than one per backend; never keep one for the app's
 * lifetime, so a CLI installed or removed while it runs is still noticed.
 */
export function lookupOnce(hasCommand: (command: string) => boolean): (command: string) => boolean {
  const found = new Map<string, boolean>();
  return (command) => {
    let result = found.get(command);
    if (result === undefined) {
      result = hasCommand(command);
      found.set(command, result);
    }
    return result;
  };
}

export function checkBackend(
  backend: Backend,
  env: Env = process.env,
  hasCommand: (command: string) => boolean = (command) => findCommand(command, env) !== null,
): { available: boolean; reason?: string } {
  const missing = backend.requiresEnv.filter((name) => !env[name]);
  if (missing.length) return { available: false, reason: `Set ${missing.join(", ")}` };
  if (!backend.model) return { available: false, reason: "No model configured" };
  if (backend.adapter === "anthropic") {
    const credential = claudeCredential(backend, env);
    if (credential.type === "none") return { available: false, reason: credential.reason };
  }
  if (backend.command && !hasCommand(backend.command)) {
    return { available: false, reason: `${backend.command} CLI not found` };
  }
  return { available: true };
}
