// -----------------------------------------------------------------------------
// The Ethernet gateway: a TCP server of the gateway (port 5003 by default,
// MY_PORT) that Gladys connects to, as pymysensors does (gateway_tcp.py).
// One line per message, in both directions.
//
// Bounded: a line longer than LIMITS.lineBytes is dropped as it comes (the
// bytes up to the next line feed are skipped, never buffered); a connection
// that does not open within TIMINGS.connectTimeout is given up.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { LIMITS, TIMINGS } from './constants.js';
import { encodeLine, parseLine } from './protocol.js';

/** Splits a byte stream into lines; a line over `max` bytes is skipped up to its end. */
export class LineReader {
  constructor(max = LIMITS.lineBytes) {
    this.max = max;
    this.parts = [];
    this.size = 0;
    this.skipping = false;
    this.dropped = 0;
  }

  /** The complete lines of this chunk (text, without the line feed). */
  push(chunk) {
    const lines = [];
    let start = 0;
    for (;;) {
      const at = chunk.indexOf(0x0a, start);
      const end = at < 0 ? chunk.length : at;
      if (!this.skipping) {
        const piece = chunk.subarray(start, end);
        if (this.size + piece.length > this.max) {
          this.skipping = true;
          this.parts = [];
          this.size = 0;
          this.dropped += 1;
        } else if (piece.length > 0) {
          this.parts.push(piece);
          this.size += piece.length;
        }
      }
      if (at < 0) break;
      if (!this.skipping) lines.push(Buffer.concat(this.parts).toString('latin1'));
      this.parts = [];
      this.size = 0;
      this.skipping = false;
      start = at + 1;
    }
    return lines;
  }
}

/** The socket to the gateway, once open (rejects past the timeout, the socket destroyed). */
export function tcpConnect({ host, port }, { timers = globalThis } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setNoDelay(true);
    const timer = timers.setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error('connection timed out'), { code: 'ETIMEDOUT' }));
    }, TIMINGS.connectTimeout);
    socket.once('connect', () => {
      timers.clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => {
      timers.clearTimeout(timer);
      socket.destroy();
      reject(err);
    });
  });
}

export class TcpLink {
  constructor(socket, { onMessage, onClose }) {
    this.socket = socket;
    this.onClose = onClose;
    this.closed = false;
    this.kind = 'tcp';
    this.reader = new LineReader();
    this.invalid = 0;
    socket.on('data', (chunk) => {
      if (this.closed) return;
      for (const line of this.reader.push(chunk)) {
        if (this.closed) return;
        const msg = parseLine(line);
        if (msg) onMessage(msg, { retained: false });
        else if (line.trim() !== '') this.invalid += 1;
      }
    });
    socket.on('error', (err) => this.close(err.code ?? 'error'));
    socket.on('close', () => this.close('connection closed'));
    socket.on('end', () => this.close('connection closed by the gateway'));
  }

  get dropped() {
    return this.reader.dropped + this.invalid;
  }

  /** Writes a message: true when written on the open socket. */
  send(msg) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) return false;
    this.socket.write(encodeLine(msg));
    return true;
  }

  close(reason = 'closed') {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onClose?.(reason);
  }

  async closedSocket() {
    if (this.socket.closed) return;
    await new Promise((resolve) => this.socket.once('close', resolve));
  }
}

/** Opens one TCP link to the gateway. */
export async function openTcp(route, { onMessage, onClose, timers, connect = tcpConnect }) {
  const socket = await connect(route, { timers });
  return new TcpLink(socket, { onMessage, onClose });
}
