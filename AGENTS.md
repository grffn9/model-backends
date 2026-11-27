# AGENTS.md

Instructions for every AI coding agent in this repo: Claude Code, GitHub Copilot and Gemini/Antigravity. The tool-specific files (`CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`) only point here, so this is the one file to keep current.

## Project

A TypeScript library that connects AI token sources (subscription CLIs, API keys and OpenAI-compatible hosts) behind one streaming adapter interface, with live provider usage, user-set caps and limit-aware fallback. Extracted from model-switchboard and used by agent apps built from agent-app-template. Node 24+; `src/` runs directly in tests and is built to `dist/` for consumers, because Node won't strip types inside `node_modules`.

## Commands

- Install: `npm ci`
- Build: `npm run build` (also runs on install from git, through `prepare`)
- Test: `npm test`
- Lint / typecheck: `npm run lint` and `npm run typecheck`

## Workflow

- Never commit directly to `main`. Work on a branch named `<engine>/<issue>-<slug>`, e.g. `claude/12-add-login` or `copilot/7-fix-export`.
- One issue per branch and PR. Put `Closes #<issue>` in the PR body.
- Stay inside the issue's scope. Mention unrelated problems in the PR description instead of fixing them.
- Commit in small, logical steps with imperative messages ("Add login form", not "added stuff").

## Definition of done

- Install, test, lint and typecheck commands above all pass.
- New behavior has a test, or the PR says exactly how it was verified.
- Every acceptance criterion in the issue is checked off or explained.
- The PR template is filled in, including anything left undone.

## Rules

- Never commit secrets. Config goes in `.env` (gitignored); add every new variable to `.env.example` with a placeholder.
- Don't change `.github/workflows/` unless the issue asks for it.
- Don't add a dependency without a one-line reason in the PR.
- Code must work on Windows, macOS and Linux: use path helpers, not hard-coded separators or shell-specific scripts.
- TypeScript must stay erasable (no enums or parameter properties), and relative imports keep their `.ts` extension; the build rewrites them.
- Keep API keys out of CLI child environments: every CLI spawn goes through `withoutSecrets`. Add a new provider's key pattern there.
- CLI backends run tool-free in the empty sandbox folder unless the caller passes `folder` (agent mode).
- Never store prompt text in the usage ledger.
- Never ship a guessed limit or usage figure: the provider's real numbers, a cap the user set, or none.
- A change to the public API (`src/index.ts`) bumps the version in `package.json` and gets a tag (`vX.Y.Z`), since apps pin a tag.

## Learned conventions

<!-- When an agent gets something wrong in this repo, add a one-line rule here so no agent repeats it. -->
