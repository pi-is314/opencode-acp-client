# Recorded ACP frame corpus

Real agent→client frames, replayed through the translator by
`tests/frame-replay.test.ts` against a committed snapshot of the turn they become.

## What a fixture is

One `.jsonl` is one frame sequence: the raw lines an agent wrote to stdout during
a slice of a session, in order, one JSON object per line. Nothing is reordered and
nothing is summarized.

The first line is not a frame. It is a provenance header the test requires:

```json
{"_meta":{"backend":"OpenCode","recorded":"live","date":"2026-10-18","agent_version":"2.0.32"}}
```

- `backend` is the agent's own `agentInfo.name` from `initialize`.
- `recorded` is `live` (captured off a real agent) or `synthesized` (hand-written
  from shapes this repo parses). There is no third value: a corpus whose
  provenance is unstated is a corpus nobody can weigh.
- `agent_version` is the agent's own version, or `unmeasured`.

Each `<name>.jsonl` has a `<name>.expected.json` beside it holding the assistant
turn it replays into. That file is the gate: it fails when a translator change
alters what a turn becomes.

## Recording a fixture

```bash
AGENT="dsh --profile acp" SCENARIO=turn node scripts/record-acp-frames.mjs
```

The script runs the bridge against that agent in a throwaway workspace, sends one
short prompt, waits for the turn plus a settle window (agents can finish before
their last frames land), and moves the recording here. It never touches
`~/.opencode-acp-client/sessions.json`.

## Updating a snapshot

```bash
UPDATE_FRAME_SNAPSHOTS=1 npx vitest run tests/frame-replay.test.ts
```

By default the test only reads. The redaction check runs on every fixture: a home
path or an obvious credential fails the test before the snapshot comparison.
