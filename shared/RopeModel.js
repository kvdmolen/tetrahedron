import { add, subtract, scale, dot, length, distance } from './vector.js';
import { NODE_REST_POSITIONS, BOX_CORNERS, ROPES } from './tetraGeometry.js';

/**
 * The elastic rope model (ported from frontend/elastic.js, same behaviour).
 * Each step moves every node a little towards its target, but only along directions
 * a rope can pull in. step() is meant to run every STEP_MS milliseconds.
 */
export class RopeModel {
  static STEP_MS = 10;

  constructor({ pullStrength = 0.05 } = {}) {
    this.pullStrength = pullStrength;
    this.reset();
  }

  /** Put all nodes back at rest, with targets at rest. */
  reset() {
    this.nodes = NODE_REST_POSITIONS.map((restPosition) => ({
      position: [...restPosition],
      target: [...restPosition],
    }));
  }

  /** targets: 4 absolute positions in model units. */
  setNodeTargets(targets) {
    targets.forEach((target, nodeIndex) => (this.nodes[nodeIndex].target = [...target]));
  }

  /** Unit vectors of every rope pull acting on one node. */
  ropePullDirections(nodeIndex) {
    const directions = [];
    const nodePosition = this.nodes[nodeIndex].position;
    const addDirectionTowards = (point) => {
      const toPoint = subtract(point, nodePosition);
      const toPointLength = length(toPoint);
      if (toPointLength > 0.001) directions.push(scale(toPoint, 1 / toPointLength));
    };

    for (const rope of ROPES) {
      const cornerPosition = BOX_CORNERS[rope.cornerIndex];
      if (rope.isDirect) {
        if (rope.viaNode === nodeIndex) addDirectionTowards(cornerPosition);
        continue;
      }
      if (rope.viaNode === nodeIndex) {
        // pulley node: pulled towards its corner and towards the rope's end node
        addDirectionTowards(cornerPosition);
        addDirectionTowards(this.nodes[rope.endNode].position);
      }
      if (rope.endNode === nodeIndex) {
        // end node: pulled towards the pulley node
        addDirectionTowards(this.nodes[rope.viaNode].position);
      }
    }
    return directions;
  }

  step() {
    // compute all displacements from the same snapshot, then apply them together
    const displacements = this.nodes.map((node, nodeIndex) => {
      const wantedMove = subtract(node.target, node.position);
      const directions = this.ropePullDirections(nodeIndex);
      let pull = [0, 0, 0];
      for (const direction of directions) {
        const alignment = dot(wantedMove, direction);
        if (alignment > 0) pull = add(pull, scale(direction, alignment)); // ropes can only pull
      }
      if (directions.length > 0) pull = scale(pull, 1 / directions.length);
      return scale(pull, this.pullStrength);
    });
    this.nodes.forEach((node, nodeIndex) => (node.position = add(node.position, displacements[nodeIndex])));
  }

  nodePositions() {
    return this.nodes.map((node) => node.position);
  }

  /** Free length of each of the 16 ropes, in model units (corner -> via node [-> end node]). */
  ropeLengths() {
    return ROPES.map((rope) => {
      const viaPosition = this.nodes[rope.viaNode].position;
      const cornerToVia = distance(BOX_CORNERS[rope.cornerIndex], viaPosition);
      if (rope.isDirect) return cornerToVia;
      return cornerToVia + distance(viaPosition, this.nodes[rope.endNode].position);
    });
  }
}
