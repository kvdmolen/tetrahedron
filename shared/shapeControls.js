// Turns the control inputs from the screen (position, size, skew) into 4 node targets.
// Kept separate from the model on purpose: the inputs are expected to change (a newer
// frontend uses different controls), and only this file then needs replacing.

import { NODE_REST_POSITIONS } from './tetraGeometry.js';

export const SKEW_EDGES = { e01: [0, 1], e02: [0, 2], e03: [0, 3], e12: [1, 2], e13: [1, 3], e23: [2, 3] };

export function defaultShapeInputs() {
  return {
    position: { x: 0, y: 0, z: 0 },
    size: 0,
    skew: Object.fromEntries(Object.keys(SKEW_EDGES).map((key) => [key, 0])),
  };
}

const clampUnit = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(-1, value)) : 0);

/** Merge a (partial, untrusted) inputs object onto the current inputs; every value clamped to -1..1. */
export function mergeShapeInputs(current, update = {}) {
  const merged = structuredClone(current);
  for (const axis of ['x', 'y', 'z']) if (update.position?.[axis] !== undefined) merged.position[axis] = clampUnit(Number(update.position[axis]));
  if (update.size !== undefined) merged.size = clampUnit(Number(update.size));
  for (const key of Object.keys(SKEW_EDGES)) if (update.skew?.[key] !== undefined) merged.skew[key] = clampUnit(Number(update.skew[key]));
  return merged;
}

/** 4 absolute node targets in model units. */
export function computeNodeTargets(inputs) {
  const sizeFactor = 1 + inputs.size;

  // 1. scale each node's distance from the centre
  let targets = NODE_REST_POSITIONS.map((rest) => rest.map((coordinate) => coordinate * sizeFactor));

  // 2. skew: push/pull each node pair symmetrically along their edge
  const offsets = targets.map(() => [0, 0, 0]);
  for (const [key, [nodeA, nodeB]] of Object.entries(SKEW_EDGES)) {
    const skewAmount = inputs.skew[key];
    for (let axis = 0; axis < 3; axis++) {
      const edgeComponent = targets[nodeB][axis] - targets[nodeA][axis];
      offsets[nodeA][axis] -= (edgeComponent * skewAmount) / 2;
      offsets[nodeB][axis] += (edgeComponent * skewAmount) / 2;
    }
  }
  targets = targets.map((target, nodeIndex) => target.map((coordinate, axis) => coordinate + offsets[nodeIndex][axis]));

  // 3. move everything
  const { x, y, z } = inputs.position;
  return targets.map(([tx, ty, tz]) => [tx + x, ty + y, tz + z]);
}
