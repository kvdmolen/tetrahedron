import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { appendCrc, checkCrc } from './crc16.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// setTimeout only works in whole milliseconds (and is often late); finish the last bit by yielding until the time is reached
async function waitUntil(timeMs) {
  const remaining = timeMs - performance.now();
  if (remaining > 2) await sleep(remaining - 1.5);
  while (performance.now() < timeMs) await new Promise((r) => setImmediate(r));
}

export class ModbusException extends Error {
  constructor(code) {
    const names = { 1: 'illegal function', 2: 'illegal address', 3: 'illegal data', 8: 'CRC error (reported by drive)' };
    super(`Modbus exception 0x${code.toString(16)}: ${names[code] ?? 'unknown'}`);
    this.code = code;
  }
}
export class ModbusTimeout extends Error {}
export class ModbusCrcError extends Error {}

// How long is the response frame, given what has arrived so far? (null = don't know yet)
function expectedLength(rx) {
  if (rx.length < 2) return null;
  const fc = rx[1];
  if (fc & 0x80) return 5; //                         exception: id fc code crc crc
  if (fc === 0x03) return rx.length < 3 ? null : 5 + rx[2]; // id fc n data.. crc crc
  return 8; //                                         FC06 / FC10 echo-style replies
}

const WRITE_REPLY_BYTES = 8; // FC06 and FC10 replies are always 8 bytes

/**
 * Half-duplex Modbus RTU master. All requests are serialised through one queue,
 * so many motors can safely share one RS485 bus from concurrent code.
 *
 * Paced writes ({ paced: true } on writeSingle / writeMultiple): instead of waiting for the reply
 * (which a USB converter can hold back for ~16 ms), wait only the time the request and its reply
 * take on the wire, then let the next request go. Replies are checked as they arrive, in order;
 * problems are counted in stats and reported with the 'pacedError' event ({ unit, error }).
 * Normal (waiting) requests first let all outstanding paced replies arrive, so the two never mix.
 */
export class ModbusRtuBus extends EventEmitter {
  constructor({
    path,
    baudRate = 115200,
    parity = 'none',
    timeoutMs = 60,
    retries = 2,
    turnaroundMs = 1,
    responseDelayMs = 1, //       time a drive takes to start replying (iCL manual: ~0.64 ms at 115200)
    pacedReplyTimeoutMs = 150, // a paced reply later than this counts as missing
    port = null,
  } = {}) {
    super();
    Object.assign(this, { path, baudRate, parity, timeoutMs, retries, turnaroundMs, responseDelayMs, pacedReplyTimeoutMs, port });
    this.rx = Buffer.alloc(0);
    this.pending = null;
    this.expectedPacedReplies = []; // { unit, fc, deadline } in send order
    this.queue = Promise.resolve();
    this.stats = { requests: 0, retries: 0, timeouts: 0, crcErrors: 0, exceptions: 0, pacedWrites: 0, pacedReplies: 0, pacedMissing: 0, pacedErrors: 0 };
  }

  /** Time of one character on the wire: start + 8 data (+ parity) + stop bit. */
  get characterMs() {
    return ((this.parity === 'none' ? 10 : 11) * 1000) / this.baudRate;
  }

  /** Modbus RTU silent interval between frames: 3.5 characters, at least 1.75 ms above 19200 baud. */
  get frameGapMs() {
    return Math.max(1.75, 3.5 * this.characterMs);
  }

  async open() {
    if (!this.port) {
      const { SerialPort } = await import('serialport');
      this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, dataBits: 8, parity: this.parity, stopBits: 1, autoOpen: false });
      await new Promise((res, rej) => this.port.open((e) => (e ? rej(e) : res())));
    }
    this.port.on('data', (chunk) => this._onData(chunk));
    this.port.on('error', (e) => this.pending?.reject(e));
  }

  async close() {
    await this.queue;
    await this._serialize(() => this._waitForPacedReplies());
    await new Promise((res) => (this.port?.close ? this.port.close(() => res()) : res()));
  }

  // ---- public API -------------------------------------------------------

  readHolding(unit, addr, count) {
    return this._serialize(async () => {
      await this._waitForPacedReplies();
      const r = await this._transact(unit, Buffer.from([0x03, addr >> 8, addr & 0xff, count >> 8, count & 0xff]));
      if (r[2] !== count * 2) throw new Error(`Unexpected byte count ${r[2]}`);
      return Array.from({ length: count }, (_, i) => r.readUInt16BE(3 + 2 * i));
    });
  }

  writeSingle(unit, addr, value, { paced = false } = {}) {
    return this._write(unit, Buffer.from([0x06, addr >> 8, addr & 0xff, (value >> 8) & 0xff, value & 0xff]), paced);
  }

  writeMultiple(unit, addr, values, { paced = false } = {}) {
    const n = values.length;
    const pdu = Buffer.alloc(6 + n * 2);
    pdu[0] = 0x10;
    pdu.writeUInt16BE(addr, 1);
    pdu.writeUInt16BE(n, 3);
    pdu[5] = n * 2;
    values.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 6 + i * 2));
    return this._write(unit, pdu, paced);
  }

  /** Unit 0 = broadcast: every drive acts, nobody answers. */
  broadcastWrite(addr, value) {
    return this._serialize(async () => {
      await this._waitForPacedReplies();
      const frame = appendCrc(Buffer.from([0x00, 0x06, addr >> 8, addr & 0xff, (value >> 8) & 0xff, value & 0xff]));
      this.rx = Buffer.alloc(0);
      await new Promise((res, rej) => this.port.write(frame, (e) => (e ? rej(e) : res())));
      await sleep((frame.length * 10 * 1000) / this.baudRate + 5);
    });
  }

  // ---- internals ----------------------------------------------------------

  _write(unit, pdu, paced) {
    if (paced) return this._serialize(() => this._pacedSend(unit, pdu), { turnaround: false }); // gap is in its own timing
    return this._serialize(async () => {
      await this._waitForPacedReplies();
      await this._transact(unit, pdu);
    });
  }

  _serialize(task, { turnaround = true } = {}) {
    const run = this.queue.then(async () => {
      try {
        return await task();
      } finally {
        if (turnaround) await sleep(this.turnaroundMs);
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async _transact(unit, pdu) {
    const frame = appendCrc(Buffer.concat([Buffer.from([unit]), pdu]));
    this.stats.requests++;
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) this.stats.retries++;
      try {
        return await this._exchange(unit, frame);
      } catch (e) {
        if (e instanceof ModbusException) throw e; // a real answer, retrying won't help
        lastErr = e;
        await sleep(2);
      }
    }
    throw lastErr;
  }

  _exchange(unit, frame) {
    return new Promise((resolve, reject) => {
      this.rx = Buffer.alloc(0);
      const done = (fn) => (v) => {
        clearTimeout(timer);
        this.pending = null;
        this.rx = Buffer.alloc(0); // this exchange is over; don't leave its bytes for the next one
        fn(v);
      };
      const timer = setTimeout(() => {
        this.pending = null;
        this.stats.timeouts++;
        reject(new ModbusTimeout(`No response from unit ${unit} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending = { unit, fc: frame[1], resolve: done(resolve), reject: done(reject) };
      this.port.write(frame, (err) => err && this.pending?.reject(err));
    });
  }

  /** Send a write without waiting for its reply; return once request + reply have had time to pass on the wire. */
  async _pacedSend(unit, pdu) {
    const frame = appendCrc(Buffer.concat([Buffer.from([unit]), pdu]));
    const wireMs = (frame.length + WRITE_REPLY_BYTES) * this.characterMs + this.responseDelayMs + this.frameGapMs;
    this._expirePacedReplies();
    if (!this.expectedPacedReplies.length) this.rx = Buffer.alloc(0); // nothing outstanding: start clean
    this.stats.requests++;
    this.stats.pacedWrites++;
    this.expectedPacedReplies.push({ unit, fc: pdu[0], deadline: performance.now() + wireMs + this.pacedReplyTimeoutMs });
    await new Promise((res, rej) => this.port.write(frame, (e) => (e ? rej(e) : res())));
    // drain = the operating system has handed the bytes to the converter; only then start the clock
    if (this.port.drain) await new Promise((res) => this.port.drain(() => res()));
    await waitUntil(performance.now() + wireMs);
  }

  _pacedProblem(kind, unit, error) {
    this.stats[kind]++;
    this.emit('pacedError', { unit, error });
  }

  _expirePacedReplies() {
    const now = performance.now();
    while (this.expectedPacedReplies.length && this.expectedPacedReplies[0].deadline < now) {
      const { unit } = this.expectedPacedReplies.shift();
      this._pacedProblem('pacedMissing', unit, new ModbusTimeout(`No reply from unit ${unit} to a paced write`));
    }
  }

  async _waitForPacedReplies() {
    while (this.expectedPacedReplies.length) {
      this._expirePacedReplies();
      if (this.expectedPacedReplies.length) await sleep(1);
    }
    this.rx = Buffer.alloc(0);
  }

  /** Match buffered bytes against the paced writes we're waiting on, in order. */
  _parsePacedReplies() {
    while (this.expectedPacedReplies.length && this.rx.length >= 5) {
      const expected = this.expectedPacedReplies[0];
      const isException = this.rx[1] === (expected.fc | 0x80);
      const frameLength = isException ? 5 : WRITE_REPLY_BYTES;
      if (this.rx.length < frameLength) return;
      const frame = this.rx.subarray(0, frameLength);
      if (!checkCrc(frame)) {
        // can't trust where the next frame starts: drop what we have, the waiting ones will time out
        this.rx = Buffer.alloc(0);
        this.expectedPacedReplies.shift();
        return this._pacedProblem('pacedErrors', expected.unit, new ModbusCrcError(`Bad CRC in reply from unit ${expected.unit}`));
      }
      if (frame[0] !== expected.unit) {
        // the expected reply never came; this frame belongs to a later one
        this.expectedPacedReplies.shift();
        this._pacedProblem('pacedMissing', expected.unit, new ModbusTimeout(`No reply from unit ${expected.unit} to a paced write`));
        continue;
      }
      this.rx = this.rx.subarray(frameLength);
      this.expectedPacedReplies.shift();
      if (isException) this._pacedProblem('pacedErrors', expected.unit, new ModbusException(frame[2]));
      else this.stats.pacedReplies++;
    }
  }

  _onData(chunk) {
    const p = this.pending;
    if (!p) {
      if (!this.expectedPacedReplies.length) return; // stray/late bytes: ignore
      this.rx = Buffer.concat([this.rx, chunk]);
      return this._parsePacedReplies();
    }
    this.rx = Buffer.concat([this.rx, chunk]);
    const need = expectedLength(this.rx);
    if (!need || this.rx.length < need) return;
    const frame = this.rx.subarray(0, need);
    if (!checkCrc(frame)) {
      this.stats.crcErrors++;
      return p.reject(new ModbusCrcError('Bad CRC in response'));
    }
    if (frame[0] !== p.unit) return p.reject(new Error(`Response from unit ${frame[0]}, expected ${p.unit}`));
    if (frame[1] === (p.fc | 0x80)) {
      this.stats.exceptions++;
      return p.reject(new ModbusException(frame[2]));
    }
    p.resolve(Buffer.from(frame));
  }
}
