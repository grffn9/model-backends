import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { parseConnections } from "../src/config.ts";
import { describeProviders, settableEnv } from "../src/providers.ts";
import type { ProviderDeps } from "../src/providers.ts";
import { antFolder, removeAntFolders } from "./helpers.ts";

afterEach(removeAntFolders);

const shipped = readFileSync(
  path.resolve(import.meta.dirname, "..", "examples", "connections.yaml"),
  "utf8",
);

const small = `
accounts:
  ghcp: { label: GitHub Copilot, kind: subscription }
  pro: { label: Claude Pro, kind: subscription }
  oa: { label: OpenAI API, kind: api }
  claude-api: { label: Claude API, kind: api }
backends:
  - { id: c1, account: ghcp, adapter: copilot, model: m1, skills: { chat: 5 } }
  - { id: c2, account: ghcp, adapter: copilot, model: m2, skills: { chat: 5 } }
  - id: p1
    account: pro
    adapter: claude-cli
    model: m
    requiresEnv: [CLAUDE_PRO_CONFIG_DIR]
    env: { CLAUDE_CONFIG_DIR: "\${CLAUDE_PRO_CONFIG_DIR}" }
    skills: { chat: 5 }
  - { id: o1, account: oa, adapter: openai, model: m, baseUrl: https://api.openai.com/v1, apiKeyEnv: OPENAI_API_KEY, skills: { chat: 5 } }
  - { id: a1, account: claude-api, adapter: anthropic, model: m, apiKeyEnv: ANTHROPIC_API_KEY, skills: { chat: 5 } }
`;

function deps(env: Record<string, string>, overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    env: { APPDATA: "", HOME: "", USERPROFILE: "", ...env },
    source: (name) => (env[name] ? "file" : null),
    hasCommand: () => false,
    platform: "linux",
    ...overrides,
  };
}

test("each account is one provider, with how to link it and whether it is linked", () => {
  const config = parseConnections(small, {});
  const providers = describeProviders(config, deps({}, { hasCommand: (c) => c === "copilot" }));
  assert.deepEqual(
    providers.map((p) => [p.account, p.linked, p.ready, p.models]),
    [
      ["ghcp", true, 2, 2],
      ["pro", false, 0, 1],
      ["oa", false, 0, 1],
      ["claude-api", false, 0, 1],
    ],
  );
  const [copilot, pro, openai, claude] = providers;
  assert.equal(copilot?.cli?.command, "copilot");
  assert.equal(copilot?.cli?.installed, true);
  assert.match(copilot?.cli?.install ?? "", /npm install -g @github\/copilot/);
  assert.deepEqual(copilot?.keys, []);

  assert.equal(pro?.reason, "Set CLAUDE_PRO_CONFIG_DIR");
  assert.deepEqual(pro?.keys, []);
  assert.equal(pro?.folders[0]?.name, "CLAUDE_PRO_CONFIG_DIR");
  assert.match(pro?.folders[0]?.signIn ?? "", /CLAUDE_CONFIG_DIR=.* claude auth login/);

  assert.deepEqual(openai?.keys, [
    {
      name: "OPENAI_API_KEY",
      set: false,
      source: null,
      url: "https://platform.openai.com/api-keys",
    },
  ]);
  assert.equal(openai?.cli, null);
  assert.equal(openai?.reason, "Set OPENAI_API_KEY");

  assert.match(claude?.signIn ?? "", /ant auth login/);
});

test("a saved key links its provider and says where it is kept, never what it is", () => {
  const config = parseConnections(small, {});
  const [, , openai] = describeProviders(config, deps({ OPENAI_API_KEY: "sk-secret" }));
  assert.equal(openai?.linked, true);
  assert.equal(openai?.reason, null);
  assert.deepEqual(openai?.keys[0], {
    name: "OPENAI_API_KEY",
    set: true,
    source: "file",
    url: "https://platform.openai.com/api-keys",
  });
  assert.doesNotMatch(JSON.stringify(openai), /sk-secret/);
});

test("a sign-in folder is shown with its path, and the sign-in command uses it", () => {
  const config = parseConnections(small, { CLAUDE_PRO_CONFIG_DIR: "C:\\Users\\me\\.claude-pro" });
  const providers = describeProviders(
    config,
    deps(
      { CLAUDE_PRO_CONFIG_DIR: "C:\\Users\\me\\.claude-pro" },
      { platform: "win32", hasCommand: () => true },
    ),
  );
  const pro = providers.find((provider) => provider.account === "pro");
  assert.equal(pro?.linked, true);
  assert.equal(pro?.folders[0]?.value, "C:\\Users\\me\\.claude-pro");
  assert.equal(
    pro?.folders[0]?.signIn,
    '$env:CLAUDE_CONFIG_DIR = "C:\\Users\\me\\.claude-pro"; claude auth login; Remove-Item Env:CLAUDE_CONFIG_DIR',
  );
});

test("the Claude API is linked by an ant sign-in as well as by a key", () => {
  const config = parseConnections(small, {});
  const env = { ANTHROPIC_CONFIG_DIR: antFolder() };
  const claude = describeProviders(config, deps(env)).find((p) => p.account === "claude-api");
  assert.equal(claude?.linked, true);
  assert.equal(claude?.keys[0]?.set, false);
});

test("only the variables the config uses for keys and sign-in folders can be set", () => {
  const names = settableEnv(parseConnections(shipped, {}));
  for (const name of ["ANTHROPIC_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"]) {
    assert.ok(names.has(name), name);
  }
  for (const name of ["PATH", "NODE_OPTIONS", "CLAUDE_CONFIG_DIR"]) {
    assert.equal(names.has(name), false, name);
  }
});

test("every key in the shipped config says where to get one", () => {
  const config = parseConnections(shipped, {});
  for (const provider of describeProviders(config, deps({}))) {
    for (const key of provider.keys) assert.ok(key.url?.startsWith("https://"), key.name);
    if (provider.cli) assert.ok(provider.cli.signIn, provider.account);
  }
});

test("each CLI is looked up once, however many models use it", () => {
  const config = parseConnections(shipped, {});
  const looked: string[] = [];
  describeProviders(config, deps({}, { hasCommand: (command) => (looked.push(command), true) }));
  assert.deepEqual([...looked].sort(), [...new Set(looked)].sort());
});
