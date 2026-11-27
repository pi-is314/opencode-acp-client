// Throwaway probe: start an agent exactly the way the bridge does, from a temp cwd, and say
// what came back. Written as a FILE because every attempt to inline this through `ssh` +
// `cmd.exe` + Git Bash mangled the quoting — the failures were the shell's, not the agent's.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const cwd = process.env.PROBE_CWD ?? mkdtempSync(join(tmpdir(), 'probe-'));
const win = process.platform === 'win32';
const file = win ? 'cmd.exe' : command;
const argv = win ? ['/d', '/s', '/c', `"${[command, ...args].join(' ')}"`] : args;
console.log('cwd:', cwd, '| argv:', JSON.stringify(argv));
const p = spawn(file, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: win });
let out = '', err = '';
p.stdout.on('data', (d) => { out += d; });
p.stderr.on('data', (d) => { err += d; });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
p.on('exit', (code) => {
  console.log('EXIT', code, '| stderr:', JSON.stringify(err.slice(0, 200)), '| stdout:', JSON.stringify(out.slice(0, 100)));
  process.exit(0);
});
setTimeout(() => { console.log('ALIVE | stderr:', JSON.stringify(err.slice(0, 200)), '| stdout:', JSON.stringify(out.slice(0, 100))); p.kill(); process.exit(0); }, 20000);
