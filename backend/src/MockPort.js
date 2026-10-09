import { EventEmitter } from 'node:events';
import { appendCrc, checkCrc } from './crc16.js';

const i32 = (hi, lo) => ((hi << 16) | lo) | 0;

/** Simulated RS485 line with fake iCL-RS drives, so you can develop without hardware. */
export class MockPort extends EventEmitter {
  constructor({ ids = [1], latencyMs = 3, ppr = 10000 } = {}) {
    super();
    this.latencyMs = latencyMs;
    this.slaves = new Map(ids.map((id) => [id, { id, regs: new Map([[0x01bf, id]]), pos: 0, target: 0, zero: 0, rpm: 0, ppr, t: performance.now() }]));
  }

  write(buf, cb) {
    cb?.();
    setTimeout(() => this._handle(Buffer.from(buf)), 0);
  }
  close(cb) { cb?.(); }

  _advance(s) {
    const now = performance.now();
    const step = (s.rpm * s.ppr * (now - s.t)) / 60000;
    s.pos = Math.abs(s.target - s.pos) <= step ? s.target : s.pos + Math.sign(s.target - s.pos) * step;
    s.t = now;
  }

  _read(s, a) {
    this._advance(s);
    const p = Math.round(s.pos);
    switch (a) {
      case 0x0001: return s.ppr;
      case 0x0177: return 480;
      case 0x1003: return 0x0002 | (s.pos !== s.target ? 0x04 : 0x30);
      case 0x2203: return 0;
      case 0x01bd: return 6;
      case 0x1010: return 0; case 0x1011: return 0;
      // commanded (profile) position ramps like the real drive's planner; with no load the shaft follows it exactly
      case 0x1012: return (p >> 16) & 0xffff; case 0x1013: return p & 0xffff;
      case 0x1014: case 0x1015: { // encoder counts, 65536/rev, like the real drive
        const c = Math.round((s.pos * 65536) / s.ppr);
        return a === 0x1014 ? (c >> 16) & 0xffff : c & 0xffff;
      }
      default: return s.regs.get(a) ?? 0;
    }
  }

  _write(s, a, v) {
    s.regs.set(a, v);
    if (a === 0x6002) {
      this._advance(s);
      if (v === 0x40) s.target = s.pos;
      if (v === 0x21) s.zero = s.pos; // real drive: shifts move targets, not the position registers
    }
  }

  _handle(f) {
    if (!checkCrc(f)) return;
    const unit = f[0], fc = f[1];
    const targets = unit === 0 ? [...this.slaves.values()] : this.slaves.has(unit) ? [this.slaves.get(unit)] : [];
    if (!targets.length) return;
    const addr = f.readUInt16BE(2);
    let reply = null;
    for (const s of targets) {
      if (fc === 0x03) {
        const n = f.readUInt16BE(4);
        const body = Buffer.alloc(1 + n * 2);
        body[0] = n * 2;
        for (let i = 0; i < n; i++) body.writeUInt16BE(this._read(s, addr + i), 1 + i * 2);
        reply = Buffer.concat([Buffer.from([unit, 0x03]), body]);
      } else if (fc === 0x06) {
        this._write(s, addr, f.readUInt16BE(4));
        reply = f.subarray(0, 6);
      } else if (fc === 0x10) {
        const n = f.readUInt16BE(4);
        for (let i = 0; i < n; i++) this._write(s, addr + i, f.readUInt16BE(7 + i * 2));
        if (addr <= 0x6207 && addr + n > 0x6207 && (s.regs.get(0x6207) & 0x10)) this._trigger(s);
        reply = f.subarray(0, 6);
      } else reply = Buffer.from([unit, fc | 0x80, 1]);
    }
    if (unit === 0) return; // broadcast: silence
    setTimeout(() => this.emit('data', appendCrc(Buffer.from(reply))), this.latencyMs);
  }

  _trigger(s) {
    this._advance(s);
    const mode = s.regs.get(0x6200), v = i32(s.regs.get(0x6201), s.regs.get(0x6202));
    if (mode & 0x10 && s.pos !== s.target) return; // real drive: INS bit = ignored while moving
    s.target = mode & 0x40 ? s.pos + v : v + s.zero;
    s.rpm = s.regs.get(0x6203);
  }
}
