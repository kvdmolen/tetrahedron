import { revolutionsForWoundLength, woundLengthForRevolutions } from '../../shared/winding.js';

/**
 * Converts one rope's free length (from the model) into its motor's shaft position.
 *
 * The model gives the free length: from the exit point at the corner to the rope's end. Motor position 0 =
 * drum EMPTY (free length = ropeLengthMm); then rope on the drum = ropeLengthMm - freeLength, and the pulley
 * formula gives the turns. Winding turns the shaft `windRotation` ('cw' / 'ccw', seen facing the shaft); the
 * drive counts positions up in `positiveRotation`, so windDirection is +1 or -1 to match.
 */
export class RopeDrive {
  constructor({ rope, motorId, windRotation, positiveRotation, ropeLengthMm, minFreeLengthMm = 0, enabled = true }, { ropeThicknessMm, coreRadiusMm }) {
    if (!(ropeLengthMm > minFreeLengthMm)) throw new Error(`Rope ${rope.name}: ropeLengthMm must be > minFreeLengthMm`);
    for (const rotation of [windRotation, positiveRotation]) {
      if (rotation !== 'cw' && rotation !== 'ccw') throw new Error(`Rope ${rope.name}: rotation must be 'cw' or 'ccw', not ${JSON.stringify(rotation)}`);
    }
    const windDirection = windRotation === positiveRotation ? 1 : -1; // +1: winding counts positions up
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

  /** Motor position (turns from the empty drum, signed) for a free length, without limits. */
  revolutionsForFreeLength(freeLengthMm) {
    return this.windDirection * revolutionsForWoundLength(this.ropeLengthMm - freeLengthMm, this.ropeThicknessMm, this.coreRadiusMm);
  }

  /** Free length for a motor position (turns from the empty drum, signed): the inverse of the above. */
  freeLengthForRevolutions(revolutions) {
    return this.ropeLengthMm - woundLengthForRevolutions(Math.max(0, this.windDirection * revolutions), this.ropeThicknessMm, this.coreRadiusMm);
  }

  /** { revolutions, woundLengthMm, limited } for a wanted free length, kept within minFreeLengthMm..ropeLengthMm. */
  motorTargetForFreeLength(freeLengthMm) {
    const limitedFreeLength = Math.min(this.ropeLengthMm, Math.max(this.minFreeLengthMm, freeLengthMm));
    return { revolutions: this.revolutionsForFreeLength(limitedFreeLength), woundLengthMm: this.ropeLengthMm - limitedFreeLength, limited: limitedFreeLength !== freeLengthMm };
  }
}
