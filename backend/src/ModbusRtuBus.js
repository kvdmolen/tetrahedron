import { appendCrc, checkCrc } from './crc16.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Half-duplex Modbus RTU master. All requests are serialised through one queue,
 * so many motors can safely share one RS485 bus from concurrent code.
 */
export class ModbusRtuBus {
  constructor({ path, baudRate = 115200, parity = 'none', timeoutMs = 60, retries = 2, turnaroundMs = 1, port = null } = {}) {
    Object.assign(this, { path, baudRate, parity, timeoutMs, retries, turnaroundMs, port });
    this.rx = Buffer.alloc(0);
    this.pending = null;
    this.queue = Promise.resolve();
    this.stats = { requests: 0, retries: 0, timeouts: 0, crcErrors: 0, exceptions: 0 };
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
    await new Promise((res) => (this.port?.close ? this.port.close(() => res()) : res()));
  }

  // ---- public API -------------------------------------------------------

  readHolding(unit, addr, count) {
    return this._serialize(async () => {
      const r = await this._transact(unit, Buffer.from([0x03, addr >> 8, addr & 0xff, count >> 8, count & 0xff]));
      if (r[2] !== count * 2) throw new Error(`Unexpected byte count ${r[2]}`);
      return Array.from({ length: count }, (_, i) => r.readUInt16BE(3 + 2 * i));
    });
  }

  writeSingle(unit, addr, value) {
    return this._serialize(async () => {
      await this._transact(unit, Buffer.from([0x06, addr >> 8, addr & 0xff, (value >> 8) & 0xff, value & 0xff]));
    });
  }

  writeMultiple(unit, addr, values) {
    return this._serialize(async () => {
      const n = values.length;
      const pdu = Buffer.alloc(6 + n * 2);
      pdu[0] = 0x10;
      pdu.writeUInt16BE(addr, 1);
      pdu.writeUInt16BE(n, 3);
      pdu[5] = n * 2;
      values.forEach((v, i) => pdu.writeUInt16BE(v & 0xffff, 6 + i * 2));
      await this._transact(unit, pdu);
    });
  }

  /** Unit 0 = broadcast: every drive acts, nobody answers. */
  broadcastWrite(addr, value) {
    return this._serialize(async () => {
      const frame = appendCrc(Buffer.from([0x00, 0x06, addr >> 8, addr & 0xff, (value >> 8) & 0xff, value & 0xff]));
      this.rx = Buffer.alloc(0);
      await new Promise((res, rej) => this.port.write(frame, (e) => (e ? rej(e) : res())));
      await sleep((frame.length * 10 * 1000) / this.baudRate + 5);
    });
  }

  // ---- internals ----------------------------------------------------------

  _serialize(task) {
    const run = this.queue.then(async () => {
      try {
        return await task();
      } finally {
        await sleep(this.turnaroundMs);
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

  _onData(chunk) {
    const p = this.pending;
    if (!p) return; // stray/late bytes: ignore
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
