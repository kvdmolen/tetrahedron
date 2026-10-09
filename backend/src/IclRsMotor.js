import { REG, CTRL, PR_CMD, PR_MODE, describeAlarm } from './registers.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const toI32 = (hi, lo) => ((hi << 16) | lo) | 0;
const splitI32 = (v) => [(v >> 16) & 0xffff, v & 0xffff];

// Feedback register counts 65536 per revolution regardless of Pr0.00 (measured: 6.55x the pulse count at 10000 P/R).
export const ENCODER_COUNTS_PER_REV = 65536;

/** One iCL-RS drive on a shared ModbusRtuBus. */
export class IclRsMotor {
  constructor(bus, id, { pulsesPerRev = 10000, name = `motor${id}` } = {}) {
    if (!(id >= 1 && id <= 31)) throw new Error('Slave ID must be 1..31');
    this.bus = bus;
    this.id = id;
    this.name = name;
    this.pulsesPerRev = pulsesPerRev;
    // The drive's position registers are NOT reset by set-zero (its move targets are), so we
    // remember the raw commanded position at the moment of zeroing and subtract it ourselves.
    // Only known if setZero() ran in this process; otherwise readings are raw.
    this.zeroPulses = 0;
  }

  // --- reads ---------------------------------------------------------------
  async readReg(addr) {
    return (await this.bus.readHolding(this.id, addr, 1))[0];
  }

  /** Pull pulses/rev from the drive so conversions are always right. */
  async syncPulsesPerRev() {
    this.pulsesPerRev = await this.readReg(REG.PULSES_PER_REV);
    return this.pulsesPerRev;
  }

  async busVoltage() {
    return (await this.readReg(REG.BUS_VOLTAGE)) / 10;
  }

  async peakCurrent() {
    return (await this.readReg(REG.PEAK_CURRENT)) / 10;
  }

  async alarm() {
    const mask = await this.readReg(REG.ALARM);
    return { mask, text: describeAlarm(mask) };
  }

  async status() {
    const s = await this.readReg(REG.MOTION_STATUS);
    return {
      raw: s,
      fault: !!(s & 1),
      enabled: !!(s & 2),
      running: !!(s & 4),
      commandDone: !!(s & 0x10),
      pathDone: !!(s & 0x20),
      homed: !!(s & 0x40),
    };
  }

  /**
   * Commanded (profile) and encoder feedback positions in pulses, relative to the last setZero()
   * in this process, plus the raw register values. One 6-register read.
   */
  async positions() {
    const r = await this.bus.readHolding(this.id, REG.FOLLOW_ERR_HI, 6);
    const profileRaw = toI32(r[2], r[3]), encoderCounts = toI32(r[4], r[5]);
    return {
      profile: profileRaw - this.zeroPulses,
      feedback: Math.round((encoderCounts * this.pulsesPerRev) / ENCODER_COUNTS_PER_REV) - this.zeroPulses,
      followingError: toI32(r[0], r[1]), // raw register, units unverified
      profileRaw,
      encoderCounts,
    };
  }

  // --- configuration ---------------------------------------------------------
  async setPeakCurrent(amps) {
    await this.bus.writeSingle(this.id, REG.PEAK_CURRENT, Math.round(amps * 10));
  }

  /** Software enable (Pr0.07). With factory DI1 = enable N.C. the drive is already enabled. */
  async enable(on = true) {
    await this.bus.writeSingle(this.id, REG.FORCE_ENABLE, on ? 1 : 0);
  }

  async clearAlarm() {
    await this.bus.writeSingle(this.id, REG.CONTROL_WORD, CTRL.RESET_ALARM);
  }

  /** Persist parameters to EEPROM (only for config changes, not in the control loop!). */
  async saveToEeprom() {
    await this.bus.writeSingle(this.id, REG.CONTROL_WORD, CTRL.SAVE_ALL);
    await new Promise((r) => setTimeout(r, 100));
    const s = await this.readReg(REG.SAVE_STATUS);
    if (s === 0xaaaa) throw new Error('Drive reported EEPROM save failure');
    return s === 0x5555;
  }

  // --- motion ----------------------------------------------------------------
  /** Declare the current position as 0 (the encoder is single-turn, so do this at each power-up). */
  async setZero() {
    await this.bus.writeSingle(this.id, REG.PR_CONTROL, PR_CMD.SET_ZERO);
    const r = await this.bus.readHolding(this.id, REG.PROFILE_POS_HI, 2);
    this.zeroPulses = toI32(r[0], r[1]);
  }

  async quickStop() {
    await this.bus.writeSingle(this.id, REG.PR_CONTROL, PR_CMD.QUICK_STOP);
  }

  /**
   * "Immediate trigger" move (manual 5.5.4): ONE Modbus frame writes the whole PR0 path
   * (mode, position, speed, accel, decel, pause, trigger) and starts it.
   * Absolute by default. A new call replaces a move still in progress (that is what makes
   * streaming work). Do NOT set `interrupt` (INS bit) for that: on this drive INS=1 makes new
   * commands get ignored until the running move has finished. See PR_MODE.INTERRUPT.
   */
  async moveToPulses(pulses, { rpm = 60, accMs = 100, decMs = 100, pauseMs = 0, relative = false, interrupt = false } = {}) {
    const mode = PR_MODE.POSITION | (relative ? PR_MODE.RELATIVE : 0) | (interrupt ? PR_MODE.INTERRUPT : 0);
    const [hi, lo] = splitI32(Math.round(pulses));
    await this.bus.writeMultiple(this.id, REG.PR0_BASE, [
      mode,
      hi,
      lo,
      clamp(Math.round(rpm), 0, 0xffff),
      clamp(Math.round(accMs), 0, 0xffff),
      clamp(Math.round(decMs), 0, 0xffff),
      clamp(Math.round(pauseMs), 0, 0xffff),
      0x0010, // Pr9.07 -> Pr8.02: run PR0 now
    ]);
  }

  moveToRev(rev, opts) {
    return this.moveToPulses(rev * this.pulsesPerRev, opts);
  }
}
