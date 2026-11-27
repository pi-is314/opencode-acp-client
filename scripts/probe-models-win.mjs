// Throwaway: what does an agent report for `models` on this platform?
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
const win = process.platform === 'win32';
const p = spawn(win ? 'cmd.exe' : command, win ? ['/d', '/s', '/c', `"${[command, ...args].join(' ')}"`] : args, { stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: win });
let buf = '';
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
p.stdout.on('data', (d) => {
  buf += d.toString(); const ls = buf.split('\n'); buf = ls.pop() ?? '';
  for (const l of ls) {
    if (!l.trim()) continue;
    let m; try { m = JSON.parse(l); } catch { continue; }
    if (m.id === 1) send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
    if (m.id === 2) {
      const r = m.result ?? m.error;
      console.log('models:', JSON.stringify(r?.models)?.slice(0, 300));
      p.kill(); process.exit(0);
    }
  }
});
p.stderr.on('data', () => {});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
setTimeout(() => { console.log('TIMEOUT'); p.kill(); process.exit(1); }, 40000);
