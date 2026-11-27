import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, test } from "node:test";
import { antConfigDir, claudeCredential } from "../src/claude-auth.ts";
import { antFolder, makeBackend, removeAntFolders } from "./helpers.ts";

afterEach(removeAntFolders);

const claude = makeBackend({ id: "claude", adapter: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" });

test("an API key wins over the ant sign-in", () => {
  const env = { ANTHROPIC_API_KEY: "sk-key", ANTHROPIC_CONFIG_DIR: antFolder() };
  assert.deepEqual(claudeCredential(claude, env), { type: "api-key", apiKey: "sk-key" });
});

test("without a key, the ant sign-in is used", () => {
  assert.deepEqual(claudeCredential(claude, { ANTHROPIC_CONFIG_DIR: antFolder() }), {
    type: "sign-in",
    profile: "default",
  });
});

test("an empty key, as in a copied .env.example, falls back to the sign-in", () => {
  const env = { ANTHROPIC_API_KEY: " ", ANTHROPIC_CONFIG_DIR: antFolder() };
  assert.equal(claudeCredential(claude, env).type, "sign-in");
});

test("a backend with no apiKeyEnv uses only the sign-in", () => {
  const signInOnly = makeBackend({ id: "s", adapter: "anthropic" });
  const env = { ANTHROPIC_API_KEY: "sk-key", ANTHROPIC_CONFIG_DIR: antFolder() };
  assert.equal(claudeCredential(signInOnly, env).type, "sign-in");
  assert.deepEqual(claudeCredential(signInOnly, {}), {
    type: "none",
    reason: 'Run "ant auth login"',
  });
});

test("the active profile and ANTHROPIC_PROFILE choose the sign-in", () => {
  const dir = antFolder(["default", "work"], { active: "work" });
  assert.deepEqual(claudeCredential(claude, { ANTHROPIC_CONFIG_DIR: dir }), {
    type: "sign-in",
    profile: "work",
  });
  assert.deepEqual(
    claudeCredential(claude, { ANTHROPIC_CONFIG_DIR: dir, ANTHROPIC_PROFILE: "default" }),
    { type: "sign-in", profile: "default" },
  );
});

test("with no key and no sign-in, the reason says how to fix it", () => {
  const none = (env: Record<string, string>) => claudeCredential(claude, env);
  assert.deepEqual(none({ ANTHROPIC_CONFIG_DIR: antFolder([]) }), {
    type: "none",
    reason: 'Set ANTHROPIC_API_KEY or run "ant auth login"',
  });
  assert.deepEqual(none({ ANTHROPIC_CONFIG_DIR: antFolder(), ANTHROPIC_PROFILE: "work" }), {
    type: "none",
    reason: 'Set ANTHROPIC_API_KEY or run "ant auth login --profile work"',
  });
  assert.equal(none({}).type, "none");
});

test("a profile whose tokens were removed is not signed in", () => {
  const dir = antFolder(["default"], { loggedOut: ["default"] });
  assert.equal(claudeCredential(claude, { ANTHROPIC_CONFIG_DIR: dir }).type, "none");
});

test("an unsafe profile name is never turned into a path", () => {
  const dir = antFolder();
  const env = { ANTHROPIC_CONFIG_DIR: dir, ANTHROPIC_PROFILE: `..${path.sep}default` };
  assert.equal(claudeCredential(claude, env).type, "none");
});

test("the ant config folder is found where the Anthropic SDK looks", () => {
  assert.equal(
    antConfigDir({ ANTHROPIC_CONFIG_DIR: "/custom", APPDATA: "/a" }, "win32"),
    "/custom",
  );
  assert.equal(antConfigDir({ APPDATA: "/roaming" }, "win32"), path.join("/roaming", "Anthropic"));
  assert.equal(
    antConfigDir({ USERPROFILE: "/me" }, "win32"),
    path.join("/me", "AppData", "Roaming", "Anthropic"),
  );
  assert.equal(antConfigDir({}, "win32"), null);
  assert.equal(
    antConfigDir({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/me" }, "linux"),
    path.join("/xdg", "anthropic"),
  );
  assert.equal(
    antConfigDir({ HOME: "/home/me" }, "darwin"),
    path.join("/home/me", ".config", "anthropic"),
  );
  assert.equal(antConfigDir({}, "linux"), null);
});
