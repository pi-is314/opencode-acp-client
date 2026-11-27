// Throwaway probe: start an agent exactly the way the bridge does, and print what came back.
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
const file = process.platform === 'win32' ? 'cmd.exe' : command;
const argv = process.platform === 'win32' ? ['/d', '/s', '/c', `"${[command, ...args].join(' ')}"`] : args;
const p = spawn(file, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: process.platform === 'win32' });
let out = '', err = '';
p.stdout.on('data', (d) => { out += d; });
p.stderr.on('data', (d) => { err += d; });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }) + '\n');
p.on('exit', (code) => {
  console.log('EXIT', code, '| stderr:', JSON.stringify(err.slice(0, 200)), '| stdout:', JSON.stringify(out.slice(0, 100)));
  process.exit(0);
});
setTimeout(() => { console.log('TIMEOUT | stderr:', JSON.stringify(err.slice(0, 200)), '| stdout:', JSON.stringify(out.slice(0, 100))); p.kill(); process.exit(0); }, 25000);
