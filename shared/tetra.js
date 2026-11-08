// The tetrahedron sculpture: geometry, the control inputs, and the model that turns inputs into rope lengths.
// Model units: the box runs from -2 to +2 (z is up), so 4 units = the real box size.

import { ElasticNetwork } from './ElasticNetwork.js';
import { subtract, dot } from './vector.js';

export const BOX_SIZE_MM = 682; // inside the frame: where the nodes and ropes can move (measured 2026-11-08)
export const MM_PER_MODEL_UNIT = BOX_SIZE_MM / 4;

/**
 * Longest a position rope (e.g. A:AB, corner -> node A -> node B) can ever get. The nodes never leave the
 * tetrahedron of the 4 suspension corners (in equilibrium every node is a weighted average of its corner and
 * the other nodes), whose edges are face diagonals of the box: √2 × box. Corner -> node -> node is at most two
 * such edges, e.g. node A at C's corner and node B at B's corner. 1929 mm for the 682 mm box.
 */
export const MAX_POSITION_ROPE_LENGTH_MM = 2 * Math.SQRT2 * BOX_SIZE_MM;

/** Model time step: step() is meant to run every STEP_MS milliseconds. */
export const STEP_MS = 10;

// ---- geometry -----------------------------------------------------------------------------------

/** The 4 nodes, named A-D. A and B hang from floor corners, C and D from ceiling corners. */
export const NODE_NAMES = ['A', 'B', 'C', 'D'];

/** Node starting positions. */
export const NODE_START_POSITIONS = [
  [-1, 1, -1],
  [1, -1, -1],
  [-1, -1, 1],
  [1, 1, 1],
];

/** The 8 corners of the box. */
export const BOX_CORNERS = [
  [-2, 2, -2], [2, 2, -2], [2, -2, -2], [-2, -2, -2],
  [-2, 2, 2], [2, 2, 2], [2, -2, 2], [-2, -2, 2],
];

/** Box outline for drawing (pairs of corner indices), and the floor (corners at z = -2). */
export const BOX_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
export const FLOOR_CORNERS = [0, 1, 2, 3];

/** Each node hangs from one corner (its suspension point), where its 4 motors are. */
export const CORNER_OF_NODE = [0, 2, 7, 5];

/** The other node on the same level: A-B on the floor side, C-D on the ceiling side. */
export const OPPOSITE_NODE = [1, 0, 3, 2];

const pairName = (nodeA, nodeB) => [NODE_NAMES[nodeA], NODE_NAMES[nodeB]].sort().join('');

/**
 * The 10 segments of the model:
 *   4 suspension segments  A, B, C, D            node -> its suspension point (pull outward)
 *   6 connection segments  AB, AC, AD, BC, BD, CD   between two nodes (pull inward)
 */
const NODE_PAIRS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
export const SEGMENTS = [
  ...NODE_NAMES.map((name, node) => ({ id: name, kind: 'suspension', from: { node }, to: { anchor: CORNER_OF_NODE[node] } })),
  ...NODE_PAIRS.map(([nodeA, nodeB]) => ({ id: pairName(nodeA, nodeB), kind: 'connection', from: { node: nodeA }, to: { node: nodeB } })),
];

/**
 * The two side nodes of a node (not itself, not its opposite) as [left, right]. One handedness rule for
 * every node: "left" is the side node for which (opposite − node) × (side − node) points away from the
 * box centre. Result: A: C left, D right; B: D, C; C: A, B; D: B, A.
 */
function sideNodes(node) {
  const position = NODE_START_POSITIONS[node];
  const toOpposite = subtract(NODE_START_POSITIONS[OPPOSITE_NODE[node]], position);
  const [first, second] = [0, 1, 2, 3].filter((other) => other !== node && other !== OPPOSITE_NODE[node]);
  const toFirst = subtract(NODE_START_POSITIONS[first], position);
  const cross = [
    toOpposite[1] * toFirst[2] - toOpposite[2] * toFirst[1],
    toOpposite[2] * toFirst[0] - toOpposite[0] * toFirst[2],
    toOpposite[0] * toFirst[1] - toOpposite[1] * toFirst[0],
  ];
  return dot(cross, position) > 0 ? [first, second] : [second, first];
}

/**
 * The 16 physical ropes (one motor each), 4 per node, in this order per node:
 *   1. the suspension rope           "A"     suspension point -> A                (constant tension)
 *   2. to the opposite node          "A:AB"  suspension point -> A -> B (over a pulley at A)
 *   3. to the left side node         "A:AC"
 *   4. to the right side node        "A:AD"
 * Rope index = node × 4 + (position − 1); with the default config, motor ID = rope index + 1,
 * so node A has motors 1-4, B 5-8, C 9-12, D 13-16 and the suspension ropes are 1, 5, 9, 13.
 * Only used for the motor output: a rope's length is the sum of its segments.
 */
export const ROPES = NODE_NAMES.flatMap((name, node) => {
  const [left, right] = sideNodes(node);
  return [
    { endNode: null, place: 'suspension' },
    { endNode: OPPOSITE_NODE[node], place: 'opposite' },
    { endNode: left, place: 'left' },
    { endNode: right, place: 'right' },
  ].map(({ endNode, place }, positionInNode) => {
    const isDirect = endNode === null;
    const connection = isDirect ? null : pairName(node, endNode);
    return {
      index: node * 4 + positionInNode,
      name: isDirect ? name : `${name}:${connection}`,
      node,
      endNode,
      place,
      segments: isDirect ? [name] : [name, connection],
      isDirect,
      role: isDirect ? 'tension' : 'position',
    };
  });
});

// ---- inputs -------------------------------------------------------------------------------------

/**
 * Control inputs, the single list used by the screen, the server and the timeline. All run -1..1, 0 = rest:
 *   one per segment (A..D, AB..CD): tension of that segment, as a factor on its stiffness (see below)
 *   size: +1 = nodes out to their suspension points, -1 = all nodes to the centre
 * To add an input: add it here and use it in segmentStiffnesses().
 */
export const INPUTS = [
  ...SEGMENTS.map((segment) => ({ id: segment.id, label: segment.id, group: segment.kind, min: -1, max: 1, base: 0 })),
  { id: 'size', label: 'size', group: 'shape', min: -1, max: 1, base: 0 },
];

export function defaultInputValues() {
  return Object.fromEntries(INPUTS.map((input) => [input.id, input.base]));
}

/** Merge (untrusted) values onto the current ones: unknown ids ignored, every value clamped to its range. */
export function mergeInputValues(current, update = {}) {
  const merged = { ...current };
  for (const input of INPUTS) {
    const value = Number(update[input.id]);
    if (update[input.id] !== undefined && Number.isFinite(value)) merged[input.id] = Math.min(input.max, Math.max(input.min, value));
  }
  return merged;
}

/**
 * Tuning. Inputs act as exponents: stiffness = base × factor^input, so 0 = base, +1 = factor× stronger,
 * -1 = factor× weaker. Only stiffness ratios decide the shape, so this spreads the effect evenly.
 * Factors calibrated 2026-10-26 on a 793 mm box; the shape scales with the box, so in the 682 mm box
 * (see backend/test/tetraModel.test.js):
 *   connection +1 (alone) -> its two nodes ~17 mm apart
 *   suspension +1 (alone) -> the node ~17 mm from its suspension point
 *   size +1 -> nodes ~26 mm from their suspension points, size -1 -> nodes ~15 mm from the centre
 */
export const DEFAULT_TUNING = {
  baseSuspension: 0.05, //     stiffness at input 0 (with baseConnection this sets the rest pose:
  baseConnection: 0.016, //    the start tetrahedron scaled by 2·ks / (ks + 4·kc) = 0.877)
  suspensionFactor: 33, //     stiffness × this at suspension input +1, ÷ this at -1
  connectionFactor: 85, //     stiffness × this at connection input +1, ÷ this at -1
  sizeFactor: 5.3, //          size +1: suspensions × this and connections ÷ this; -1 the other way round
  // How the nodes travel to the equilibrium (the exact pose for the current inputs): like a mass, with at most
  // this speed and acceleration, braking in time. 1500 / 4500: 1 m in 1 s (1/3 s speeding up, 1/3 s at
  // 1.5 m/s, 1/3 s braking). Every moment is a real pose; these only limit how violently it moves.
  maxNodeSpeedMmPerS: 1500,
  maxNodeAccelerationMmPerS2: 4500,
};

/** Stiffness of every segment, by segment id, for a set of input values. */
export function segmentStiffnesses(values, tuning = DEFAULT_TUNING) {
  const size = values.size ?? 0;
  return Object.fromEntries(
    SEGMENTS.map((segment) => {
      const tension = values[segment.id] ?? 0;
      const stiffness =
        segment.kind === 'suspension'
          ? tuning.baseSuspension * tuning.suspensionFactor ** tension * tuning.sizeFactor ** size
          : tuning.baseConnection * tuning.connectionFactor ** tension * tuning.sizeFactor ** -size;
      return [segment.id, stiffness];
    }),
  );
}

// ---- model --------------------------------------------------------------------------------------

/** The sculpture as an elastic network: inputs in, node positions and rope lengths out. */
export class TetraModel {
  constructor(tuning = {}) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
    this.network = new ElasticNetwork({
      stepSeconds: STEP_MS / 1000,
      maxSpeed: this.tuning.maxNodeSpeedMmPerS / MM_PER_MODEL_UNIT,
      maxAcceleration: this.tuning.maxNodeAccelerationMmPerS2 / MM_PER_MODEL_UNIT,
    });
    NODE_START_POSITIONS.forEach((position) => this.network.addNode(position));
    BOX_CORNERS.forEach((position) => this.network.addAnchor(position));
    this.segmentIndex = Object.fromEntries(SEGMENTS.map((segment) => [segment.id, this.network.addSegment(segment.from, segment.to)]));
    this.setInputs(defaultInputValues());
  }

  setInputs(values) {
    for (const [segmentId, stiffness] of Object.entries(segmentStiffnesses(values, this.tuning))) {
      this.network.setStiffness(this.segmentIndex[segmentId], stiffness);
    }
  }

  step() {
    return this.network.step();
  }

  /** Back to the start positions. */
  reset() {
    this.network.setNodePositions(NODE_START_POSITIONS);
  }

  /** Jump to the equilibrium of the current inputs. */
  settle() {
    this.network.settle();
  }

  nodePositions() {
    return this.network.nodes;
  }

  segmentLengths() {
    return Object.fromEntries(SEGMENTS.map((segment) => [segment.id, this.network.segmentLength(this.segmentIndex[segment.id])]));
  }

  /** Free length of each of the 16 ropes, in model units. */
  ropeLengths() {
    const segmentLengths = this.segmentLengths();
    return ROPES.map((rope) => rope.segments.reduce((total, segmentId) => total + segmentLengths[segmentId], 0));
  }
}
