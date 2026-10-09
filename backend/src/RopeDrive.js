import { revolutionsForWoundLength } from '../../shared/winding.js';

/**
 * Converts one rope's free length (from the model) into its motor's shaft position.
 *
 * Reference: motor position 0 = drum EMPTY (all rope off the pulley, free length = ropeLengthMm).
 * Then rope on the drum = ropeLengthMm - freeLength, and the pulley formula gives the turns.
 */
export class RopeDrive {
  constructor({ rope, motorId, windDirection = 1, ropeLengthMm, minFreeLengthMm = 0, enabled = true }, { ropeThicknessMm, coreRadiusMm }) {
    if (!(ropeLengthMm > minFreeLengthMm)) throw new Error(`Rope ${rope.name}: ropeLengthMm must be > minFreeLengthMm`);
    Object.assign(this, { rope, motorId, windDirection, ropeLengthMm, minFreeLengthMm, enabled, ropeThicknessMm, coreRadiusMm });
    this.motor = null; // IclRsMotor, once connected
  }

  get name() {
    return this.rope.name;
  }

  /** Constant-tension rope (stalls against the rope at a limited current) instead of position-controlled. */
  get isTension() {
    return this.rope.role === 'tension';
  }

  /** Radius of the outer rope layer with this much rope on the drum. */
  drumRadiusMm(woundLengthMm) {
    return this.coreRadiusMm + revolutionsForWoundLength(woundLengthMm, this.ropeThicknessMm, this.coreRadiusMm) * this.ropeThicknessMm;
  }

  /** Peak current for a constant rope force: torque = force * radius, so current grows with the drum radius. */
  tensionCurrentA(woundLengthMm, { currentA, referenceRadiusMm, maxCurrentA }) {
    const amps = (currentA * this.drumRadiusMm(woundLengthMm)) / referenceRadiusMm;
    return Math.round(Math.min(maxCurrentA, amps) * 10) / 10;
  }

  /** { revolutions, woundLengthMm, limited } for a wanted free length. */
  motorTargetForFreeLength(freeLengthMm) {
    const limitedFreeLength = Math.min(this.ropeLengthMm, Math.max(this.minFreeLengthMm, freeLengthMm));
    const woundLengthMm = this.ropeLengthMm - limitedFreeLength;
    const revolutions = this.windDirection * revolutionsForWoundLength(woundLengthMm, this.ropeThicknessMm, this.coreRadiusMm);
    return { revolutions, woundLengthMm, limited: limitedFreeLength !== freeLengthMm };
  }
}
