import { describe, expect, it } from 'vitest';
import { inferToolName } from '../src/translate/events.js';

/**
 * What each agent in the matrix actually sends for a tool call, pasted from a live `session/prompt`
 * (measured 2026-11-27). opencode's TUI picks a row component by NAME and falls back to
 * `${name} ${JSON.stringify(input)}` for anything else, so every one of these has to land on a name
 * the TUI knows — otherwise the whole file content of a write lands in the collapsed card.
 *
 * The shapes are deliberately uneven; that is the point. The bridge cannot ask an agent to be tidy.
 */
const MEASURED = [
  // `opencode acp` — the reference: names are already the TUI's own.
  { agent: 'opencode acp', title: 'shell', kind: 'execute', input: { cwd: '/tmp' }, expect: 'shell' },
  { agent: 'opencode acp', title: 'read', kind: 'read', input: {}, expect: 'read' },
  { agent: 'opencode acp', title: 'write', kind: 'edit', input: {}, expect: 'write' },
  // `glob` is one of the TUI's own names (`runGlob`), so it stays as it is.
  { agent: 'opencode acp', title: 'glob', kind: 'search', input: {}, expect: 'glob' },

  // `qwen --acp` — no `name` at all, and a `File` suffix on the verb.
  { agent: 'qwen --acp', title: 'Shell', kind: 'execute', input: {}, expect: 'shell' },
  { agent: 'qwen --acp', title: 'ReadFile', kind: 'read', input: {}, expect: 'read' },
  { agent: 'qwen --acp', title: 'WriteFile', kind: 'edit', input: { path: '/a.go', content: 'package a' }, expect: 'write' },
  { agent: 'qwen --acp', title: 'Glob', kind: 'search', input: { pattern: '**/*.go' }, expect: 'grep' },

  // `dsh --profile acp` — no `name`, and `kind: "other"` for everything; only the input says what
  // the call is. This is the case that makes "always trust `kind`" impossible.
  // `bash` is also a TUI name (`runShell`); an agent that says `bash` needs no help.
  { agent: 'dsh', title: 'bash', kind: 'other', input: { command: 'ls', description: 'list' }, expect: 'bash' },
  { agent: 'dsh', title: 'read', kind: 'other', input: { file_path: '/etc/hostname' }, expect: 'read' },
  { agent: 'dsh', title: 'glob', kind: 'other', input: { pattern: '*.go' }, expect: 'glob' },

  // `pi-acp` — the "name" is the COMMAND ITSELF, so reading it as a category is hopeless.
  { agent: 'pi-acp', title: 'echo probe', kind: 'execute', input: undefined, expect: 'shell' },
  { agent: 'pi-acp', title: 'read', kind: 'read', input: { path: '/etc/hostname' }, expect: 'read' },
  { agent: 'pi-acp', title: 'write', kind: 'edit', input: { path: '/a.txt', content: 'hi' }, expect: 'write' },

  // `gemini --acp` — no name, a prose title, or an empty one.
  { agent: 'gemini --acp', title: 'echo probe', kind: 'execute', input: undefined, expect: 'shell' },
  { agent: 'gemini --acp', title: '', kind: 'read', input: { path: '/etc/hosts' }, expect: 'read' },
  { agent: 'gemini --acp', title: 'Writing to ../tmp/x', kind: 'edit', input: { path: '/tmp/x', content: 'y' }, expect: 'write' },

  // `agy acp` — a real `name`, but not the TUI's word for it.
  { agent: 'agy acp', title: 'echo probe ; ls', kind: 'execute', input: { command: 'echo probe' }, expect: 'shell' },

  // `codex-acp` — a shell tool mislabelled `kind: "read"`.
  { agent: 'codex-acp', title: 'grep subagent logs', kind: 'read', input: { command: 'grep x' }, expect: 'shell' },
] as const;

describe('every measured agent lands on a name the TUI renders', () => {
  for (const row of MEASURED) {
    it(`${row.agent}: ${JSON.stringify(row.title)} / ${row.kind} -> ${row.expect}`, () => {
      expect(inferToolName(row.title, row.kind, row.input)).toBe(row.expect);
    });
  }
});

describe('the inference does not read English into a tool name', () => {
  // Measured regression: `kind: "other"` plus a name containing `open` became `read`.
  it('keeps a name whose word only LOOKS like a category', () => {
    expect(inferToolName('echo-open', 'other', { n: 3 })).toBe('echo-open');
    expect(inferToolName('echo-ok', 'other', { n: 1 })).toBe('echo-ok');
  });

  it('leaves a tool that MANAGES other agents named as it is', () => {
    // These are not file/shell tools; the generic card is the right rendering.
    expect(inferToolName('list_agents', 'other', {})).toBe('list_agents');
    expect(inferToolName('send_message', 'other', {})).toBe('send_message');
    expect(inferToolName('job_list', 'other', {})).toBe('job_list');
    expect(inferToolName('subagent_manager', 'other', {})).toBe('subagent_manager');
  });

  it('does not mistake the argv of a tool for a shell command', () => {
    // `args` alone is an argument list passed to a tool, not the command line itself.
    expect(inferToolName('mytool', 'other', { args: ['-x'] })).toBe('mytool');
  });
});
