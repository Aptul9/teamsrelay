import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { STATE } from '@/shared/slot-db/state';
import type { Light } from './context';
import { SPACES } from './token';
import { log } from '../log';

// Calling runs outside the light agent: a native WebRTC fault must not stop chat polling.
export class NativeCalls {
  private child: ChildProcess | null = null;
  private stopped = false;
  private notified = 0;
  private loggedCall = 0;
  private sequence = 0;
  private pending = new Map<number, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private l: Light) {}
  async start() {
    if (this.stopped || this.child) return;
    const l = this.l, dir = path.dirname(l.config.lightTokenFile);
    const auth = await l.token.accessToken(SPACES);
    const r = await fetch('https://teams.microsoft.com/api/authsvc/v1.0/authz', { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'x-ms-client-type': 'web' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`calling discovery ${r.status}`);
    const discovery = await r.json();
    if (this.stopped) return;
    fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify(discovery), { mode: 0o600 });
    const audioToken = path.join(dir, 'calling-audio-token');
    fs.writeFileSync(audioToken, randomBytes(32).toString('hex'), { mode: 0o600 });
    // A previous native worker may have died before its terminal DELETE. Remove only its saved UUID.
    const marker = path.join(dir, 'owned-registration.json');
    if (fs.existsSync(marker)) {
      const owned = JSON.parse(fs.readFileSync(marker, 'utf8')) as { endpoint: string; registrar: string };
      if (!/^[a-f0-9-]{36}$/i.test(owned.endpoint) || !/^https:\/\/teams\.microsoft\.com\/registrar\/prod\/v2\/registrations$/i.test(owned.registrar)) throw new Error('invalid calling ownership');
      const deleted = await fetch(`${owned.registrar}/${owned.endpoint}`, { method: 'DELETE', headers: { 'X-Skypetoken': discovery.tokens.skypeToken, 'X-MS-Migration': 'True' }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if (!deleted.ok && deleted.status !== 404) throw new Error(`calling cleanup ${deleted.status}`);
      fs.unlinkSync(marker);
    }
    const child = fork(process.env.CALLING_HOST ?? '/app/calling-live-host.mjs', ['--mode=serve'], {
      env: { ...process.env, HOST_STATE: dir, HOST_BUNDLES: '/app/calling', WRTC_DIR: '/app', CALLING_OID: l.me.oid, CALLING_NAME: l.me.name, CALL_AUDIO_TOKEN_FILE: audioToken, CALL_AUDIO_URL: process.env.CALL_AUDIO_URL ?? `wss://${process.env.DOMAIN}/api/call/audio/socket?a=${l.config.slot}`, CALL_AUDIO_INTERNAL: '1' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.child = child;
    child.on("error", () => { this.child = null; });
    child.on('message', (message: unknown) => {
      const m = message as { stage?: string; refreshToken?: boolean; command?: number; ok?: boolean; error?: string; call?: { caller: string; since: number; seen: number; ringing: boolean; active: boolean; ended?: boolean; answered?: boolean; muted: boolean } };
      if (m.refreshToken) {
        void (async () => {
          l.token.renewAll();
          const access = await l.token.accessToken(SPACES);
          const response = await fetch('https://teams.microsoft.com/api/authsvc/v1.0/authz', { method: 'POST', headers: { Authorization: `Bearer ${access}`, 'x-ms-client-type': 'web' }, signal: AbortSignal.timeout(15000) });
          if (!response.ok) throw new Error('calling token refused');
          fs.writeFileSync(path.join(dir, 'discovery.json'), JSON.stringify(await response.json()), { mode: 0o600 });
          child.send({ tokenUpdated: true });
        })().catch(() => child.kill('SIGTERM'));
      }
      if (m.stage === 'worker-ready') l.store.setState(STATE.callAudio, '1');
      if (m.error) log.warn('calling', m.error);
      if (typeof m.command === 'number') { const p = this.pending.get(m.command); if (p) { clearTimeout(p.timer); this.pending.delete(m.command); p.resolve(!!m.ok); } }
      if (m.call) {
        const c = m.call;
        const named = [...l.list.members].find(([, members]) => members.some(m => m === c.caller || m.endsWith(c.caller.replace(/^8:orgid:/, ''))));
        if (named) c.caller = l.list.names.get(named[0]) || c.caller;
        if (c.ended && c.since && this.loggedCall !== c.since) {
          this.loggedCall = c.since;
          l.store.addCall(c.caller, c.since, c.answered ? Math.max(0, Math.floor((Date.now() - c.since) / 1000)) : 0);
        }
        l.store.setState(STATE.call, JSON.stringify(c));
        l.store.setState(STATE.inCall, JSON.stringify(c));
        if (c.ringing && this.notified !== c.since) { this.notified = c.since; void l.notifier.call(c.caller, 'ringing', c.since); }
        if (!c.ringing && this.notified === c.since) { this.notified = 0; void l.notifier.call(c.caller, 'ended', c.since, 0, c.active); }
      }
    });
    child.once('exit', () => {
      this.child = null; l.store.setState(STATE.callAudio, '0');
      const ended = { caller: '', since: 0, seen: Date.now(), ringing: false, active: false };
      l.store.setState(STATE.call, JSON.stringify(ended)); l.store.setState(STATE.inCall, JSON.stringify(ended));
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve(false); } this.pending.clear();
      if (!this.stopped) this.retry();
    });
  }
  schedule() { this.retry(); }
  private retry() {
    if (this.stopped) return;
    setTimeout(() => { if (!this.stopped) void this.start().catch(() => this.retry()); }, 10000).unref();
  }
  command(op: string, args: Record<string, unknown>) {
    if (!this.child?.connected) return Promise.resolve(false);
    const id = ++this.sequence;
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); this.child?.kill("SIGTERM"); resolve(false); }, 30000);
      this.pending.set(id, { resolve, timer });
      this.child!.send({ id, op, ...args }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); resolve(false); } });
    });
  }
  stop() {
    this.stopped = true;
    const child = this.child;
    child?.kill('SIGTERM');
    if (child) setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 25000).unref();
  }
}
