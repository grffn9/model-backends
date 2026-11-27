# Agent stream samples

What each CLI prints in agent mode, used by `test/agent-stream.test.ts`. `__FOLDER__` stands for the folder the agent ran in; tests swap in a real path.

- `claude.jsonl`, `agy.jsonl`, `codex.jsonl`: recorded from real runs (`claude --output-format stream-json --verbose`, `agy --output-format stream-json`, `codex exec --json`) asked to create `hello.txt` and run `git status --short`. Long tool lists in the init events are cut down.
- `copilot-quota.jsonl`: recorded from a real `copilot --output-format json` run on an account out of monthly quota.
- `copilot.jsonl`: assembled from real events in Copilot CLI 1.0.112 session logs (`~/.copilot/session-state/*/events.jsonl`, the same events `--output-format json` prints), with paths and text replaced. A live tool run could not be recorded because the account was out of quota.
