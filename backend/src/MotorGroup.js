import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { REG, PR_CMD } from './registers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Streams position targets to many motors at a fixed rate.
 *
 *   targetFn(t, i) -> desired position of motor i, in revolutions, at time t (seconds)
 *
 * Each tick we command the position `lookahead` ticks in the FUTURE, at the trajectory's
 * average speed over that window. The motor therefore never reaches the target (and never
 * brakes to a stop) before the next command interrupts it (see IclRsMotor.moveToPulses),
 * so it cruises at the right speed instead of stop-go once per tick.
 *
 * Events: 'tick' {tick,t,ms}, 'overrun' {tick,ms}, 'motorError' {motor,error},
 *         'alarm' {motor,text}, 'fatal' {error}
 */
export class MotorGroup extends EventEmitter {
  constructor(bus, motors, {
    rateHz = 10,
    minRpm = 1,
    maxRpm = 600,
    lookahead = 3, //      ticks ahead to aim (>= 2 so the motor is still moving when the next command lands)
    speedGain = 1, //      scale on the computed speed
    accMs = 100, //        ms per 1000 rpm; used as-is with ramp 'fixed', as the fastest ramp with 'adaptive'
    decMs = 100,
    // 'adaptive': each command's acc/dec is set so the speed change from the previous command is
    // spread over one whole tick, giving a continuous speed profile instead of speed steps.
    ramp = 'fixed',
    maxRampMs = 5000, //   slowest ramp allowed in adaptive mode (ms per 1000 rpm)
    minRev = -Infinity, // soft limits, revolutions from zero
    maxRev = Infinity,
    statusEvery = 1, //    poll ONE motor's fault flag (round-robin) every N ticks (0 = never)
    maxConsecutiveErrors = 5,
  } = {}) {
    super();
    Object.assign(this, { bus, motors, rateHz, minRpm, maxRpm, lookahead, speedGain, accMs, decMs, ramp, maxRampMs, minRev, maxRev, statusEvery, maxConsecutiveErrors });
    this.running = false;
    this.lastPulses = motors.map(() => null);
    this.lastSignedRpm = motors.map(() => 0);
    this.errorCount = motors.map(() => 0);
  }

  async start(targetFn, { seconds = Infinity } = {}) {
    const dt = 1 / this.rateHz;
    const periodMs = 1000 * dt;

    // Start from where each motor actually is.
    for (let i = 0; i < this.motors.length; i++) {
      this.lastPulses[i] = (await this.motors[i].positions()).profile;
    }

    this.running = true;
    const t0 = performance.now();
    let next = t0;
    for (let tick = 0; this.running; tick++) {
      const tickStart = performance.now();
      const t = (tickStart - t0) / 1000;
      if (t >= seconds) break;

      await this._tick(t, dt, targetFn);
      if (this.statusEvery && tick % this.statusEvery === 0) await this._pollStatus(tick % this.motors.length);

      const ms = performance.now() - tickStart;
      this.emit('tick', { tick, t, ms });
      next += periodMs;
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
      else {
        this.emit('overrun', { tick, ms });
        next = performance.now(); // don't try to catch up with a burst
      }
    }
    this.running = false;
  }

  stop() {
    this.running = false;
  }

  /** One broadcast frame: every drive on the bus quick-stops. */
  emergencyStop() {
    this.running = false;
    return this.bus.broadcastWrite(REG.PR_CONTROL, PR_CMD.QUICK_STOP);
  }

  async _tick(t, dt, targetFn) {
    const horizon = this.lookahead * dt;
    for (let i = 0; i < this.motors.length && this.running; i++) {
      const m = this.motors[i];
      try {
        const now = clamp(targetFn(t, i), this.minRev, this.maxRev);
        const rev = clamp(targetFn(t + horizon, i), this.minRev, this.maxRev);
        const target = Math.round(rev * m.pulsesPerRev);
        if (target === this.lastPulses[i]) continue;
        // average speed over the look-ahead window (revs -> rpm)
        const rpm = clamp(Math.ceil((Math.abs(rev - now) * 60 * this.speedGain) / horizon), this.minRpm, this.maxRpm);
        const signedRpm = Math.sign(rev - now) * rpm;
        const { accMs, decMs } = this._rampFor(i, signedRpm, rpm, dt, horizon);
        await m.moveToPulses(target, { rpm, accMs, decMs });
        this.lastPulses[i] = target;
        this.lastSignedRpm[i] = signedRpm;
        this.errorCount[i] = 0;
      } catch (error) {
        this.emit('motorError', { motor: m, error });
        if (++this.errorCount[i] >= this.maxConsecutiveErrors) {
          this.emit('fatal', { error: new Error(`${m.name}: ${this.errorCount[i]} consecutive errors, last: ${error.message}`) });
          this.stop();
        }
      }
    }
  }

  _rampFor(i, signedRpm, rpm, dt, horizon) {
    if (this.ramp !== 'adaptive') return { accMs: this.accMs, decMs: this.decMs };
    const speedChange = Math.max(1, Math.abs(signedRpm - this.lastSignedRpm[i]));
    const accMs = clamp(Math.round((dt * 1000 * 1000) / speedChange), this.accMs, this.maxRampMs);
    // Decelerating must still be able to stop within the look-ahead distance, or the drive
    // would start braking early: stopping time (decMs * rpm / 1000) <= horizon.
    const decMs = clamp(Math.min(accMs, Math.floor((horizon * 1000 * 1000) / rpm)), this.decMs, this.maxRampMs);
    return { accMs, decMs };
  }

  async _pollStatus(i) {
    const m = this.motors[i];
    try {
      if ((await m.status()).fault) {
        const { text } = await m.alarm();
        this.emit('alarm', { motor: m, text });
        this.stop();
      }
    } catch (error) {
      this.emit('motorError', { motor: m, error });
    }
  }
}
