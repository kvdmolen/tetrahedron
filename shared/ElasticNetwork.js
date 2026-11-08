import { add, subtract, scale, length } from './vector.js';

/**
 * A network of elastic segments between moving nodes and fixed anchors.
 *
 * Each segment pulls its two ends together with force = stiffness × (other end − this end): a spring
 * with rest length 0 (Hooke). That makes the system linear: for any positive stiffnesses there is exactly
 * one equilibrium, each node ends up at a weighted average of what it's tied to (so it never leaves the
 * hull of the anchors), and only the RATIOS of the stiffnesses decide the shape.
 *
 * step() moves all nodes, in one of two ways:
 *   - motion 'follow' (default): the equilibrium is solved exactly (a small linear system per axis) and every
 *     node travels there like a mass: it speeds up at most maxAcceleration, goes at most maxSpeed, and brakes
 *     in time to stop on it (per step of stepSeconds; units = model units). A moving equilibrium (inputs
 *     changing) is chased the same way. Every step is a real pose (rope lengths come from node positions), so
 *     the limits are about how violently the sculpture moves, not about consistency.
 *   - motion 'reference': the reference algorithm (reference/elastic.js): every node moves stepFactor × net
 *     force. Kept to compare against the reference.
 */
export class ElasticNetwork {
  constructor({ motion = 'follow', stepFactor = 0.5, stepSeconds = 0.01, maxSpeed = Infinity, maxAcceleration = Infinity } = {}) {
    Object.assign(this, { motion, stepFactor, stepSeconds, maxSpeed, maxAcceleration });
    this.nodes = []; //      positions [x, y, z] of moving points
    this.velocities = []; // per node [x, y, z] per second ('follow')
    this.anchors = []; //    positions [x, y, z] of fixed points
    this.segments = []; //   { from, to, stiffness }; from/to = { node: i } or { anchor: i }
  }

  addNode(position) {
    this.nodes.push([...position]);
    this.velocities.push([0, 0, 0]);
    return this.nodes.length - 1;
  }

  addAnchor(position) {
    this.anchors.push([...position]);
    return this.anchors.length - 1;
  }

  /** from / to: { node: index } or { anchor: index }. Returns the segment index. */
  addSegment(from, to, stiffness = 0) {
    this.segments.push({ from, to, stiffness });
    return this.segments.length - 1;
  }

  setStiffness(segmentIndex, stiffness) {
    this.segments[segmentIndex].stiffness = stiffness;
  }

  positionOf(end) {
    return end.node !== undefined ? this.nodes[end.node] : this.anchors[end.anchor];
  }

  segmentLength(segmentIndex) {
    const { from, to } = this.segments[segmentIndex];
    return length(subtract(this.positionOf(to), this.positionOf(from)));
  }

  /** Put the nodes here, standing still. */
  setNodePositions(positions) {
    this.nodes = positions.map((position) => [...position]);
    this.velocities = positions.map(() => [0, 0, 0]);
  }

  /**
   * The exact equilibrium: where all forces cancel. Per axis this is the linear system K·x = b with
   * K[i][i] = total stiffness on node i, K[i][j] = −stiffness between nodes i and j, and b[i] = the
   * stiffness-weighted anchor positions on node i. Every node must be tied (via other nodes) to an anchor.
   */
  equilibrium() {
    const nodeCount = this.nodes.length;
    const matrix = Array.from({ length: nodeCount }, () => new Array(nodeCount).fill(0));
    const rightHandSides = Array.from({ length: nodeCount }, () => [0, 0, 0]);
    for (const { from, to, stiffness } of this.segments) {
      const ends = [from, to];
      for (const [self, other] of [ends, [...ends].reverse()]) {
        if (self.node === undefined) continue;
        matrix[self.node][self.node] += stiffness;
        if (other.node !== undefined) matrix[self.node][other.node] -= stiffness;
        else rightHandSides[self.node] = add(rightHandSides[self.node], scale(this.anchors[other.anchor], stiffness));
      }
    }
    return solveLinearSystem(matrix, rightHandSides);
  }

  /** Moves every node once; returns the largest distance any node moved. */
  step() {
    const moves = this.motion === 'reference' ? this._referenceMoves() : this._followMoves();
    this.nodes = this.nodes.map((position, nodeIndex) => add(position, moves[nodeIndex]));
    return Math.max(0, ...moves.map(length));
  }

  /** Each node chases its equilibrium point with limited speed and acceleration, braking in time. */
  _followMoves() {
    const dt = this.stepSeconds, maxSpeedChange = this.maxAcceleration * dt;
    return this.equilibrium().map((target, nodeIndex) => {
      const offset = subtract(target, this.nodes[nodeIndex]);
      const distanceLeft = length(offset);
      // The fastest speed towards the target from which it can still stop on it, braking in steps of dt:
      // speeds v, v − a·dt, v − 2a·dt, … cover dt·(v + (v − a·dt) + …) ≈ v²/2a + v·dt/2, so v solves
      // v²/2a + v·dt/2 = distance. (The continuous √(2a·distance) brakes too late: it overshoots a little.)
      const halfStep = (this.maxAcceleration * dt) / 2;
      const brakingSpeed = Number.isFinite(this.maxAcceleration) ? Math.sqrt(halfStep ** 2 + 2 * this.maxAcceleration * distanceLeft) - halfStep : Infinity;
      const wantedSpeed = Math.min(this.maxSpeed, brakingSpeed, distanceLeft / dt);
      const wantedVelocity = distanceLeft > 0 ? scale(offset, wantedSpeed / distanceLeft) : [0, 0, 0];
      let change = subtract(wantedVelocity, this.velocities[nodeIndex]);
      const changeSize = length(change);
      if (changeSize > maxSpeedChange) change = scale(change, maxSpeedChange / changeSize);
      this.velocities[nodeIndex] = add(this.velocities[nodeIndex], change);
      return scale(this.velocities[nodeIndex], dt);
    });
  }

  /** reference/elastic.js: move = stepFactor × net force. */
  _referenceMoves() {
    const forces = this.nodes.map(() => [0, 0, 0]);
    for (const { from, to, stiffness } of this.segments) {
      const pull = scale(subtract(this.positionOf(to), this.positionOf(from)), stiffness);
      if (from.node !== undefined) forces[from.node] = add(forces[from.node], pull);
      if (to.node !== undefined) forces[to.node] = subtract(forces[to.node], pull);
    }
    return forces.map((force) => scale(force, this.stepFactor));
  }

  /** Put the nodes straight at the equilibrium. */
  settle() {
    this.setNodePositions(this.equilibrium());
  }
}

/** Solve A·X = B (A: n×n, B: n rows of 3 columns) by Gaussian elimination with partial pivoting. */
function solveLinearSystem(matrix, rightHandSides) {
  const size = matrix.length;
  const a = matrix.map((row) => [...row]);
  const b = rightHandSides.map((row) => [...row]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    if (Math.abs(a[pivot][column]) < 1e-15) throw new Error('Elastic network has a node that is not tied to any anchor');
    [a[column], a[pivot]] = [a[pivot], a[column]];
    [b[column], b[pivot]] = [b[pivot], b[column]];
    for (let row = column + 1; row < size; row++) {
      const factor = a[row][column] / a[column][column];
      for (let k = column; k < size; k++) a[row][k] -= factor * a[column][k];
      b[row] = subtract(b[row], scale(b[column], factor));
    }
  }
  const x = new Array(size);
  for (let row = size - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < size; k++) sum = subtract(sum, scale(x[k], a[row][k]));
    x[row] = scale(sum, 1 / a[row][row]);
  }
  return x;
}
