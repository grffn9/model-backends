import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutSecrets } from "../src/secret-env.ts";

test("withoutSecrets drops API keys, sign-in tokens and account switches", () => {
  const env = withoutSecrets({
    PATH: "/bin",
    HOME: "/home/me",
    ANTHROPIC_API_KEY: "secret",
    ANTHROPIC_BASE_URL: "https://proxy",
    OPENAI_API_KEY: "secret",
    DEEPSEEK_API_KEY: "secret",
    CLAUDECODE: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    CLAUDE_CONFIG_DIR: "/other",
    CODEX_ACCESS_TOKEN: "secret",
    GH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    COPILOT_GITHUB_TOKEN: "secret",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/me" });
});

test("withoutSecrets matches names in any case", () => {
  const env = withoutSecrets({
    Path: "C:\\Windows",
    gemini_api_key: "secret",
    anthropic_auth_token: "secret",
    codex_access_token: "secret",
    gh_token: "secret",
  });
  assert.deepEqual(env, { Path: "C:\\Windows" });
});

test("withoutSecrets can keep GitHub tokens and still drops every other secret", () => {
  const env = withoutSecrets(
    {
      PATH: "/bin",
      GH_TOKEN: "gh",
      github_token: "github",
      COPILOT_GITHUB_TOKEN: "copilot",
      OPENAI_API_KEY: "secret",
      CODEX_ACCESS_TOKEN: "secret",
    },
    { keepGithubTokens: true },
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    GH_TOKEN: "gh",
    github_token: "github",
    COPILOT_GITHUB_TOKEN: "copilot",
  });
});

test("withoutSecrets leaves out unset variables and keeps look-alike names", () => {
  const env = withoutSecrets({
    UNSET: undefined,
    API_KEY_FILE: "/keys",
    GH_TOKEN_FILE: "/token",
    MY_GITHUB_TOKEN_HELPER: "helper",
  });
  assert.deepEqual(env, {
    API_KEY_FILE: "/keys",
    GH_TOKEN_FILE: "/token",
    MY_GITHUB_TOKEN_HELPER: "helper",
  });
});
