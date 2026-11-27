type Env = Record<string, string | undefined>;

/**
 * Variables no child process started from here should see: API keys, and anything that would
 * switch a CLI from its subscription sign-in to API billing or another account.
 * CODEX_ACCESS_TOKEN would replace the sign-in in CODEX_HOME, which live usage reads.
 * Add a new provider's key or token here so every child loses it at once.
 */
const SECRETS =
  /(_API_KEY$|^ANTHROPIC_|^CLAUDECODE$|^CLAUDE_CODE_|^CLAUDE_CONFIG_DIR$|^CODEX_ACCESS_TOKEN$)/i;
/** GitHub tokens, which only the Copilot CLI needs. */
const GITHUB_TOKENS = /^(GH_TOKEN|GITHUB_TOKEN|COPILOT_GITHUB_TOKEN)$/i;

export interface WithoutSecretsOptions {
  /** Keep GH_TOKEN, GITHUB_TOKEN and COPILOT_GITHUB_TOKEN, for a child that signs in to GitHub. */
  keepGithubTokens?: boolean;
}

/** A copy of the environment for a child process, without secrets or unset variables. */
export function withoutSecrets(
  env: Env,
  options: WithoutSecretsOptions = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SECRETS.test(key)) continue;
    if (!options.keepGithubTokens && GITHUB_TOKENS.test(key)) continue;
    result[key] = value;
  }
  return result;
}
