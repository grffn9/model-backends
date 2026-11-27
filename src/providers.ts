import { checkBackend, lookupOnce } from "./availability.ts";
import type { Account, Connections } from "./types.ts";

type Env = Record<string, string | undefined>;

/** Where to create each API key the shipped config uses. */
const KEY_URLS: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
  GEMINI_API_KEY: "https://aistudio.google.com/apikey",
  GEMINI_PAID_API_KEY: "https://aistudio.google.com/apikey",
  DEEPSEEK_API_KEY: "https://platform.deepseek.com/api_keys",
  OPENROUTER_API_KEY: "https://openrouter.ai/settings/keys",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
  XAI_API_KEY: "https://console.x.ai",
  MISTRAL_API_KEY: "https://console.mistral.ai/api-keys",
  GROQ_API_KEY: "https://console.groq.com/keys",
};

/** How to install and sign in to each CLI a subscription runs through. */
const CLI_HELP: Record<string, { install: string; signIn: string; url: string }> = {
  copilot: {
    install: "npm install -g @github/copilot",
    signIn: "copilot, then type /login",
    url: "https://github.com/features/copilot/cli",
  },
  codex: {
    install: "npm install -g @openai/codex",
    signIn: "codex login, then choose Sign in with ChatGPT",
    url: "https://github.com/openai/codex",
  },
  claude: {
    install: "npm install -g @anthropic-ai/claude-code",
    signIn: "claude auth login",
    url: "https://code.claude.com/docs",
  },
  agy: {
    install: "Install Google Antigravity, which adds the agy command",
    signIn: "agy, then sign in with Google when it asks",
    url: "https://antigravity.google",
  },
};

/**
 * Sign-in folders: a variable naming the folder a CLI keeps a second login in, and the variable
 * the CLI itself reads when signing in there.
 */
const FOLDER_HELP: Record<string, { variable: string; command: string; folder: string }> = {
  CLAUDE_PRO_CONFIG_DIR: {
    variable: "CLAUDE_CONFIG_DIR",
    command: "claude auth login",
    folder: ".claude-pro",
  },
};

export interface ProviderKey {
  name: string;
  set: boolean;
  /** Where a set key comes from. The value itself is never reported. */
  source: "file" | "environment" | null;
  url: string | null;
}

export interface ProviderFolder {
  name: string;
  /** A folder path, not a secret, so it is shown and can be edited. */
  value: string;
  /** The command that signs in to that folder. */
  signIn: string;
}

export interface ProviderCli {
  command: string;
  installed: boolean;
  install: string;
  signIn: string;
  url: string | null;
}

export interface Provider {
  account: string;
  label: string;
  kind: Account["kind"];
  /** Models this account can be routed to. */
  models: number;
  /** Of those, how many are set up. */
  ready: number;
  linked: boolean;
  /** Why it is not linked yet, such as "Set OPENAI_API_KEY". */
  reason: string | null;
  keys: ProviderKey[];
  folders: ProviderFolder[];
  cli: ProviderCli | null;
  /** Another way to link it, such as the `ant` sign-in for the Claude API. */
  signIn: string | null;
}

export interface ProviderDeps {
  env: Env;
  source: (name: string) => ProviderKey["source"];
  hasCommand: (command: string) => boolean;
  platform: NodeJS.Platform;
}

const unique = <T>(values: T[]) => [...new Set(values)];

function folderSignIn(name: string, value: string, platform: NodeJS.Platform): string {
  const help = FOLDER_HELP[name];
  if (!help) return `Set ${name} to the folder, then sign in there`;
  if (platform === "win32") {
    const folder = value || `$HOME\\${help.folder}`;
    return `$env:${help.variable} = "${folder}"; ${help.command}; Remove-Item Env:${help.variable}`;
  }
  return `${help.variable}="${value || `$HOME/${help.folder}`}" ${help.command}`;
}

/**
 * Describes every account in the config as a provider to link: by API key, by a sign-in folder,
 * or by a CLI's own sign-in. Linked means at least one of its models is set up.
 */
export function describeProviders(config: Connections, deps: ProviderDeps): Provider[] {
  // Finding a CLI searches PATH, so each command is looked up once, not once per model.
  const hasCommand = lookupOnce(deps.hasCommand);
  return [...config.accounts.values()].map((account) => {
    const backends = config.backends.filter((backend) => backend.account === account.id);
    const models = backends;
    const checks = models.map((backend) => checkBackend(backend, deps.env, hasCommand));
    const ready = checks.filter((check) => check.available).length;
    const keyNames = unique(backends.flatMap((backend) => backend.apiKeyEnv ?? []));
    const folderNames = unique(backends.flatMap((backend) => backend.requiresEnv)).filter(
      (name) => !keyNames.includes(name),
    );
    const command = backends.find((backend) => backend.command)?.command;
    const help = command ? CLI_HELP[command] : undefined;

    return {
      account: account.id,
      label: account.label,
      kind: account.kind,
      models: models.length,
      ready,
      linked: ready > 0,
      reason: ready > 0 ? null : (checks.find((check) => check.reason)?.reason ?? null),
      keys: keyNames.map((name) => {
        const source = deps.source(name);
        return { name, set: source !== null, source, url: KEY_URLS[name] ?? null };
      }),
      folders: folderNames.map((name) => {
        const value = deps.env[name]?.trim() ?? "";
        return { name, value, signIn: folderSignIn(name, value, deps.platform) };
      }),
      cli: command
        ? {
            command,
            installed: hasCommand(command),
            install: help?.install ?? `Install the ${command} CLI`,
            signIn: help?.signIn ?? `Sign in with ${command}`,
            url: help?.url ?? null,
          }
        : null,
      signIn: backends.some((backend) => backend.adapter === "anthropic")
        ? 'Or leave the key empty and sign in once with the ant CLI: "ant auth login"'
        : null,
    };
  });
}

/**
 * The variables setup may write: the config's API keys and sign-in folders. Anything else, such
 * as PATH or NODE_OPTIONS, could run code on the next start, so it is refused.
 */
export function settableEnv(config: Connections): Set<string> {
  return new Set(
    config.backends.flatMap((backend) => [
      ...(backend.apiKeyEnv ? [backend.apiKeyEnv] : []),
      ...backend.requiresEnv,
    ]),
  );
}
