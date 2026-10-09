// Single-track pulley: the rope winds over itself, so every turn adds one rope thickness
// to the radius (an Archimedean spiral). Wound length after n turns:
//     L = pi * n * (n * ropeThickness + 2 * coreRadius)

/** Pulley turns needed to wind `woundLengthMm` of rope onto an empty drum (= omwentelingen()). */
export function revolutionsForWoundLength(woundLengthMm, ropeThicknessMm, coreRadiusMm) {
  return (Math.sqrt(coreRadiusMm ** 2 + (ropeThicknessMm * woundLengthMm) / Math.PI) - coreRadiusMm) / ropeThicknessMm;
}

/** Inverse: rope length on the drum after `revolutions` turns from empty. */
export function woundLengthForRevolutions(revolutions, ropeThicknessMm, coreRadiusMm) {
  return Math.PI * revolutions * (revolutions * ropeThicknessMm + 2 * coreRadiusMm);
}
