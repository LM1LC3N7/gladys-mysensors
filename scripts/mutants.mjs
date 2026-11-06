// -----------------------------------------------------------------------------
// The mutants the tests must kill: each one breaks a guard of the code; the
// suite (`node --test test/*.test.js`) must then fail. One at a time, in a
// copy of the repository made in a fresh temporary directory (removed after),
// the repository itself never touched; each run bounded in time (its whole
// process group killed past the deadline: a mutant that makes a test hang
// counts as killed only if the suite fails, and is reported).
//
// Usage: node scripts/mutants.mjs [name filter]   (wrap it in memcap on a dev VM)
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DEADLINE = 300_000;

export const MUTANTS = [
  // Stops.
  [
    'stop sent at once',
    'src/app.js',
    'if (this.link && !this.link.closed) this.sendStop(stop);\n    else this.ensureLink({ urgent: true });\n    this.saveLater();',
    'this.saveLater();',
  ],
  [
    'stop confirmed only after a send',
    'src/app.js',
    "if (!stop || !this.stopLeft(stop)) return;\n    this.endStop(key, 'confirmed');",
    "if (!stop) return;\n    this.endStop(key, 'confirmed');",
  ],
  ['newer command cancels the stop', 'src/app.js', '    this.cancelStop(target);\n', ''],
  ['five sends', 'src/app.js', 'export const STOP_SENDS = 5;', 'export const STOP_SENDS = 4;'],
  [
    'kept stops sent when the link opens',
    'src/app.js',
    'if (this.sendDueStops() === 0) this.askVersion();',
    'this.askVersion();',
  ],
  [
    'stop via /data route before config',
    'src/app.js',
    'if (!route || this.dueStops().length === 0) return undefined;',
    'return undefined;',
  ],
  [
    'click never overwritten by /data',
    'src/app.js',
    'if (!this.stops.has(key)) {\n          this.stops.set(key, newStop(',
    'if (true) {\n          this.stops.set(key, newStop(',
  ],
  // Commands.
  [
    'declared safe',
    'src/app.js',
    'if (!this.isSafe(parsed.node, parsed.child)) throw',
    'if (false) throw',
  ],
  ['presented type', 'src/app.js', 'if (presented && presented.sType !== expected)', 'if (false)'],
  [
    'gateway live',
    'src/app.js',
    'if (!this.link || this.link.closed || !this.live) throw',
    'if (!this.link || this.link.closed) throw',
  ],
  [
    'echo exact payload',
    'src/protocol.js',
    '  a.sub === b.sub &&\n  a.payload === b.payload;',
    '  a.sub === b.sub;',
  ],
  [
    'echo not a state',
    'src/app.js',
    '      this.resolveEcho(msg);\n      return;',
    '      this.resolveEcho(msg);',
  ],
  [
    'brightness bounded',
    'src/model.js',
    'if (!Number.isInteger(n) || n < 0 || n > 100) return undefined;',
    'if (!Number.isInteger(n) || n < 0) return undefined;',
  ],
  [
    'heater never commanded',
    'src/model.js',
    '    case S.HEATER:\n    case S.SPRINKLER:\n      return [KIND.STATE];\n',
    '',
  ],
  [
    'discovery switch only when safe',
    'src/app.js',
    'kindsOfPresentation(sType, this.isSafe(info.id, child))',
    'kindsOfPresentation(sType, true)',
  ],
  // Values.
  ['retained ignored', 'src/app.js', '    if (retained) return;\n', ''],
  [
    'door inverted',
    'src/model.js',
    'return tripped === undefined ? undefined : 1 - tripped;',
    'return tripped;',
  ],
  [
    'range of a measurement',
    'src/model.js',
    'return value !== undefined && value >= min && value <= max ? value : undefined;',
    'return value;',
  ],
  [
    'strict number',
    'src/protocol.js',
    '!/^-?\\d{1,9}(?:\\.\\d{1,6})?$/.test(payload)',
    '!/-?\\d{1,9}(?:\\.\\d{1,6})?/.test(payload)',
  ],
  [
    'fresh values only at creation',
    'src/app.js',
    'if (now - value.at <= TIMINGS.stateFresh) {',
    'if (true) {',
  ],
  [
    'nothing old after reconnection',
    'src/app.js',
    '    this.publisher.clear();\n    this.gladys.forgetPublishedStates?.();\n',
    '',
  ],
  [
    'measurements spaced',
    'src/publisher.js',
    'if (entry.spaced && last !== undefined && now - last < TIMINGS.measurementSpacing) continue;',
    '',
  ],
  // Bounds.
  ['line bound', 'src/tcp.js', 'if (this.size + piece.length > this.max) {', 'if (false) {'],
  ['packet guard', 'src/mqtt.js', 'if (length + this.header.length > this.max) {', 'if (false) {'],
  ['rate limit', 'src/app.js', '    if (b.tokens < 1) return false;\n', ''],
  [
    // The MQTT check before decoding is doubled by this one (same bound): mutated here.
    'payload bound',
    'src/protocol.js',
    'export const MAX_PAYLOAD = 200;',
    'export const MAX_PAYLOAD = 100_000;',
  ],
  [
    'answers spaced per node',
    'src/app.js',
    'if (last !== undefined && now - last < 2000) return false;',
    '',
  ],
  // Link.
  [
    'backoff',
    'src/app.js',
    'const wait = waits[Math.min(Math.max(this.failures, 1), waits.length) - 1];',
    'const wait = waits[0];',
  ],
  ['silent TCP gateway closed', 'src/app.js', 'if (silent > TIMINGS.silence) {', 'if (false) {'],
  [
    'old link closed first',
    'src/app.js',
    '      await bounded(old.closedSocket(), 2000, this.timers, undefined);\n',
    '',
  ],
  [
    'config retried in connected',
    'src/app.js',
    'this.configTimer = this.timers.setTimeout(() => {\n        this.configTimer = undefined;\n        this.readConfig().catch(() => {});\n      }, wait);',
    '',
  ],
  // Credentials.
  [
    'no try while refused',
    'src/app.js',
    'if (cfg.transport === TRANSPORTS.MQTT && this.authStopped) return;',
    '',
  ],
  [
    'new credentials tried',
    'src/app.js',
    '    if (fromUser) {\n      this.liftAuth();',
    '    if (fromUser) {\n      void 0;',
  ],
  [
    'refused pair kept at restart',
    'src/app.js',
    '    if (!same) this.liftAuth();',
    '    this.liftAuth();',
  ],
  [
    'another pair starts over at restart',
    'src/app.js',
    '    if (!same) this.liftAuth();',
    '    if (false) this.liftAuth();',
  ],
  ['unanswered twice', 'src/app.js', 'if (this.unanswered >= 2) {', 'if (this.unanswered >= 3) {'],
  // /data and ids.
  [
    'never written over unreadable',
    'src/app.js',
    "    if (this.memoryState !== 'ok') return false;\n    this.memory.stops",
    '    this.memory.stops',
  ],
  [
    'one read at a time',
    'src/app.js',
    'this.rawLoad ??= Promise.resolve',
    'this.rawLoad = Promise.resolve',
  ],
  [
    'id saved before given',
    'src/app.js',
    'if (!(await this.saveMemory())) {',
    'if (!(await this.saveMemory()) && false) {',
  ],
  [
    'unused ids bounded',
    'src/app.js',
    '      if (unseen.length >= LIMITS.unseenIds) return T.idsFull;\n',
    '',
  ],
  [
    'unused id given again',
    'src/app.js',
    '.filter((e) => wall - e.at >= TIMINGS.idReuse || e.at > wall)',
    '.filter(() => false)',
  ],
  // Review r1.
  ['B1 proof after the ask', 'src/app.js', 'stop.proofAt <= seq', 'true'],
  [
    'B1 a write is not a send',
    'src/app.js',
    '    stop.writes += 1;\n    stop.writtenOn = this.link;',
    '    stop.writes += 1;\n    stop.sends += 1;\n    stop.sentHere = true;\n    stop.writtenOn = this.link;',
  ],
  [
    'B1 resend while down follows the waits',
    'src/app.js',
    '    else this.ensureLink();\n  }',
    '    else this.ensureLink({ urgent: true });\n  }',
  ],
  [
    'B2 stale failed attempt relinks',
    'src/app.js',
    '        if (!this.closed) this.relinkNow = true;\n        return;',
    '        return;',
  ],
  [
    'B2 stale opened attempt relinks',
    'src/app.js',
    "      link.close('stale');\n      if (!this.closed) this.relinkNow = true;",
    "      link.close('stale');",
  ],
  [
    'I1 two reports',
    'src/app.js',
    'if (stop.onReports < 2) return;',
    'if (stop.onReports < 1) return;',
  ],
  [
    'I1 reports after the off only',
    'src/app.js',
    "if (!stop || !this.stopLeft(stop) || stop.departure !== '0') return;",
    "if (!stop || stop.departure !== '0') return;",
  ],
  ['I2 click during an attempt', 'src/app.js', 'if (urgent) this.urgentAfterAttempt = true;', ''],
  [
    'M2 discover spaced',
    'src/app.js',
    'this.monotonic() - this.lastDiscoverAt >= TIMINGS.scan',
    'true',
  ],
  ['M4 stale link closed', 'src/app.js', "      link.close('stale');\n", ''],
  [
    'M4 old link muted',
    'src/app.js',
    'if (!holder.link || this.link !== holder.link) return;',
    'if (!holder.link) return;',
  ],
  [
    'M4 TCP connect timeout',
    'src/tcp.js',
    '    }, TIMINGS.connectTimeout);',
    '    }, 10 * TIMINGS.connectTimeout);',
  ],
  [
    'M4 node 255 ignored',
    'src/app.js',
    'if (msg.node > NODE_MAX && !(msg.type === TYPE.INTERNAL && msg.sub === I.ID_REQUEST)) return;',
    '',
  ],
  [
    'M4 on needs config',
    'src/app.js',
    'if (!this.config || this.config.problem) throw new CommandError(ERRORS.noConfig);',
    '',
  ],
  [
    'M4 keepalive after answer',
    'src/app.js',
    '          // An answer (asked by the test button too) counts: the next ask a full minute later.\n          this.scheduleKeepalive();',
    '',
  ],
  // Review r2.
  ['r2 B1 departure known off', 'src/app.js', " || stop.departure !== '0') return;", ') return;'],
  [
    'r2 B1 dimmer pair one reading',
    'src/app.js',
    "else if (msg.ack === 0 && msg.sub === V.STATUS && msg.payload === '1') {",
    "else if (msg.ack === 0 && ((msg.sub === V.STATUS && msg.payload === '1') || msg.sub === V.PERCENTAGE)) {",
  ],
  [
    'r2 I1 unasked answers',
    'src/app.js',
    'const ask = this.asks.shift();',
    'const ask = this.asks.shift() ?? { seq: this.askSeq };',
  ],
  [
    'r2 I1 unasked answers suspend proofs',
    'src/app.js',
    '    if (this.unaskedAt !== undefined && now - this.unaskedAt < TIMINGS.unaskedQuiet) return;\n',
    '',
  ],
  ['r2 I1 recent proofs withdrawn', 'src/app.js', '      this.revokeRecentProofs(now);\n', ''],
  ['r2 I1 lost asks forgotten', 'src/app.js', 'now - this.asks[0].at > TIMINGS.askLife', 'false'],
  ['r2 I1 oldest ask', 'src/app.js', 'this.proveStops(ask.seq);', 'this.proveStops(this.askSeq);'],
  [
    'r2 I2 one try after restart (no wait armed from /data)',
    'src/app.js',
    '    if (!same) this.liftAuth();',
    '    if (!same) this.liftAuth();\n    else this.armAuth(this.memory.auth.until - this.now());',
  ],
  [
    'r3 M3 refused pair compared at each configuration read',
    'src/app.js',
    '      this.refusedPairCheck(next);\n',
    '',
  ],
  [
    'r3 M1 note goes with a report of off',
    'src/app.js',
    "      if (msg.payload === '0') this.overridden.delete(target);\n",
    '',
  ],
  [
    'r3 M1 note stays on a report of on',
    'src/app.js',
    "if (msg.payload === '0') this.overridden.delete(target);",
    'this.overridden.delete(target);',
  ],
  ['r2 M1 note expires', 'src/app.js', 'this.monotonic() - at > TIMINGS.overriddenNote', 'false'],
  [
    'r2 M2 same gateway attempt kept',
    'src/app.js',
    '    if (key !== undefined && this.linking && this.linkingKey === key && !this.link) return;\n',
    '',
  ],
  // Review r3.
  [
    'r3 I1 an on of Gladys makes the state before unknown',
    'src/app.js',
    '    this.commandLeft(parsed.node, parsed.child);\n',
    '',
  ],
  [
    'r3 I1 unknown while an on is not followed by a report',
    'src/app.js',
    'stop.departure = last && !this.onAt.has(key) ? last.payload : undefined;',
    'stop.departure = last?.payload;',
  ],
  [
    'r3 I1 departure read, never assumed off',
    'src/app.js',
    'stop.departure = last && !this.onAt.has(key) ? last.payload : undefined;',
    "stop.departure = '0';",
  ],
  [
    'r3 I1 a report that may have crossed the on settles nothing',
    'src/app.js',
    'this.monotonic() - at > TIMINGS.echo',
    'this.monotonic() - at >= 0',
  ],
  ['r3 I1 a later report settles the on', 'src/app.js', 'this.onAt.delete(key);', ''],
  [
    'r3 I1 an echo never settles the on',
    'src/app.js',
    '    if (msg.ack === 0 && msg.sub === V.STATUS) {\n      const target',
    '    if (msg.sub === V.STATUS) {\n      const target',
  ],
  [
    'r3 M3 an accepted connection settles the refusal',
    'src/app.js',
    '      // Accepted: no refusal applies any more, even one /data gives later.\n      this.authSettled = true;\n',
    '',
  ],
  [
    'r3 M3 /data never overwrites what was settled',
    'src/app.js',
    '      if (this.authSettled) loaded.auth = this.memory.auth;\n',
    '',
  ],
  [
    'r3 M3 settled refusal written over the file',
    'src/app.js',
    'if (stale) this.saveLater();',
    'if (stale) void 0;',
  ],
  [
    'r3 M3 rule of the restart when /data comes late',
    'src/app.js',
    '&& this.config) this.refusedPairCheck(this.config);',
    '&& this.config) void 0;',
  ],
  [
    'r3 M3 new credentials settle the refusal',
    'src/app.js',
    '  liftAuth() {\n    this.authSettled = true;\n',
    '  liftAuth() {\n',
  ],
  [
    'r3 M3 a refusal settles it',
    'src/app.js',
    '    this.logger.warn(`MQTT broker refused the connection: ${reason}`);\n    this.authSettled = true;\n',
    '    this.logger.warn(`MQTT broker refused the connection: ${reason}`);\n',
  ],
  [
    'r3 M4 written stops say so',
    'src/app.js',
    '      else if (stop.wroteOn !== undefined && stop.wroteOn === this.link) written.push(name);\n',
    '',
  ],
  ['r3 M4 last write kept after the proof', 'src/app.js', '    stop.wroteOn = this.link;\n', ''],
  [
    'r3 M4 echo only while unasked answers come',
    'src/app.js',
    'T.stopsWritten(targetList(written), echoOnly)',
    'T.stopsWritten(targetList(written), false)',
  ],
  [
    'r3 M5 an echo is never stored as a state',
    'src/app.js',
    'if (msg.ack === 0 && (info.values.has(key) || info.values.size < LIMITS.childrenPerNode * 4)) {',
    'if (info.values.has(key) || info.values.size < LIMITS.childrenPerNode * 4) {',
  ],
  // Configuration.
  [
    'password without user',
    'src/config.js',
    "else if (password !== '' && username === '') config.problem = 'password-alone';",
    '',
  ],
  [
    'route without credentials',
    'src/config.js',
    'if (config.transport === TRANSPORTS.MQTT && (config.username || config.password)) {',
    'if (false) {',
  ],
  ['no multicast', 'src/config.js', 'if (parts[0] === 0 || parts[0] >= 224) return false;', ''],
];

async function run(dir) {
  // `node --test test/*.test.js`, the glob expanded here.
  const files = (await readdir(join(dir, 'test'))).filter((f) => f.endsWith('.test.js')).sort();
  return new Promise((resolve) => {
    const args = ['--test', '--test-timeout=60000', ...files.map((f) => `test/${f}`)];
    const child = spawn(process.execPath, args, {
      cwd: dir,
      stdio: 'ignore',
      detached: true,
      shell: false,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve('timeout');
    }, DEADLINE);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'survived' : 'killed');
    });
  });
}

async function main() {
  const filter = process.argv[2];
  const survivors = [];
  for (const [name, file, from, to] of MUTANTS) {
    if (filter && !name.includes(filter)) continue;
    const dir = await mkdtemp(join(tmpdir(), 'mysensors-mutant-'));
    try {
      await cp(REPO, dir, {
        recursive: true,
        filter: (src) => !/[/\\](\.git|node_modules)$/.test(src),
      });
      await symlink(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
      const path = join(dir, file);
      const text = await readFile(path, 'utf8');
      const count = text.split(from).length - 1;
      if (count !== 1) {
        console.log(`STALE   ${name}: found ${count} times in ${file}`);
        survivors.push(name);
        continue;
      }
      await writeFile(path, text.replace(from, to));
      const outcome = await run(dir);
      console.log(`${outcome.toUpperCase().padEnd(8)}${name}`);
      if (outcome !== 'killed') survivors.push(name);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  console.log(survivors.length ? `Not killed: ${survivors.join(', ')}` : 'Every mutant killed');
  process.exitCode = survivors.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
