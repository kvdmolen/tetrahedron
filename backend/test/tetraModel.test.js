// The model: the spring network must match the reference algorithm (reference/elastic.js, March 2026),
// the inputs must hit their calibration targets, and the winding maths must match omwentelingen().
import assert from 'node:assert/strict';
import { ElasticNetwork } from '../../shared/ElasticNetwork.js';
import {
  TetraModel, ROPES, SEGMENTS, INPUTS, NODE_START_POSITIONS, BOX_CORNERS, CORNER_OF_NODE, DEFAULT_TUNING,
  MM_PER_MODEL_UNIT, MAX_POSITION_ROPE_LENGTH_MM, STEP_MS, defaultInputValues, mergeInputValues,
} from '../../shared/tetra.js';
import { distance, length } from '../../shared/vector.js';
import { revolutionsForWoundLength, woundLengthForRevolutions } from '../../shared/winding.js';
import { REFERENCE_SCENARIOS } from './referenceScenarios.js';
import { RopeDrive } from '../src/RopeDrive.js';

const close = (actual, expected, label, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} vs ${expected}`);
const mm = (modelUnits) => modelUnits * MM_PER_MODEL_UNIT;

// 1. The spring network, run the reference way (fixed step factor, the reference's linear stiffness
//    formula and input names), gives exactly the reference results.
{
  const network = new ElasticNetwork({ motion: 'reference', stepFactor: 0.5 });
  NODE_START_POSITIONS.forEach((position) => network.addNode(position));
  BOX_CORNERS.forEach((position) => network.addAnchor(position));
  const suspensions = CORNER_OF_NODE.map((corner, node) => network.addSegment({ node }, { anchor: corner }));
  const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
  const connections = pairs.map(([a, b]) => network.addSegment({ node: a }, { node: b }));
  for (const scenario of REFERENCE_SCENARIOS) {
    const v = scenario.values, expand = Math.max(0, v.sz ?? 0), contract = Math.max(0, -(v.sz ?? 0));
    suspensions.forEach((segment, node) => network.setStiffness(segment, 0.05 + (v[`s${node}`] ?? 0) * 0.1 + expand * 0.1));
    connections.forEach((segment, i) => network.setStiffness(segment, 0.016 + (v[`e${pairs[i].join('')}`] ?? 0) * 0.1 + contract * 0.1));
    for (let i = 0; i < scenario.steps; i++) network.step();
    network.nodes.forEach((position, node) => position.forEach((coordinate, axis) => close(coordinate, scenario.nodes[node][axis], `node ${node}`)));
    // reference rope order: via node t, end node e, index t * 4 + e
    for (let via = 0; via < 4; via++) {
      for (let end = 0; end < 4; end++) {
        const viaPosition = network.nodes[via];
        const ropeLength = distance(BOX_CORNERS[CORNER_OF_NODE[via]], viaPosition) + (via === end ? 0 : distance(viaPosition, network.nodes[end]));
        close(ropeLength, scenario.ropeLengths[via * 4 + end], `reference rope ${via}->${end}`);
      }
    }
  }
  console.log(`spring network matches the reference algorithm in ${REFERENCE_SCENARIOS.length} scenarios`);
}

// 2. Names and numbering: nodes A-D, 10 segments, 16 ropes, 4 per node (suspension, opposite, left, right).
assert.deepEqual(SEGMENTS.map((segment) => segment.id), ['A', 'B', 'C', 'D', 'AB', 'AC', 'AD', 'BC', 'BD', 'CD']);
assert.deepEqual(INPUTS.map((input) => input.id), [...SEGMENTS.map((segment) => segment.id), 'size']);
assert.ok(INPUTS.every((input) => input.min === -1 && input.max === 1 && input.base === 0));
assert.deepEqual(ROPES.map((rope) => rope.name), [
  'A', 'A:AB', 'A:AC', 'A:AD',
  'B', 'B:AB', 'B:BD', 'B:BC',
  'C', 'C:CD', 'C:AC', 'C:BC',
  'D', 'D:CD', 'D:BD', 'D:AD',
]);
assert.deepEqual(ROPES.filter((rope) => rope.isDirect).map((rope) => rope.index + 1), [1, 5, 9, 13]); // motor IDs of the tension ropes
assert.deepEqual(ROPES.map((rope) => rope.place).slice(0, 4), ['suspension', 'opposite', 'left', 'right']);
assert.equal(mergeInputValues(defaultInputValues(), { A: 5, size: -3, nonsense: 1, AB: 'x' }).A, 1);
assert.equal(mergeInputValues(defaultInputValues(), { size: -3 }).size, -1);

// 3. Rest pose (all inputs 0): the start tetrahedron scaled by 2·ks / (ks + 4·kc).
const equilibrium = (values, tuning = {}) => {
  const model = new TetraModel({ maxNodeSpeedMmPerS: Infinity, ...tuning });
  model.setInputs(mergeInputValues(defaultInputValues(), values));
  model.settle();
  return model.nodePositions();
};
const restScale = (2 * DEFAULT_TUNING.baseSuspension) / (DEFAULT_TUNING.baseSuspension + 4 * DEFAULT_TUNING.baseConnection);
close(equilibrium({})[3][0], restScale, 'rest pose scale', 1e-6);

// 4. Calibration: what +1 / -1 on an input does (targets in mm, see DEFAULT_TUNING).
const suspensionPoint = (node) => BOX_CORNERS[CORNER_OF_NODE[node]];
const within = (actualMm, targetMm, toleranceMm, label) => assert.ok(Math.abs(actualMm - targetMm) <= toleranceMm, `${label}: ${actualMm.toFixed(1)} mm, expected ${targetMm} ± ${toleranceMm}`);
let nodes = equilibrium({ AB: 1 });
within(mm(distance(nodes[0], nodes[1])), 17, 3, 'AB +1: A to B');
nodes = equilibrium({ A: 1 });
within(mm(distance(nodes[0], suspensionPoint(0))), 17, 3, 'A +1: A to its suspension point');
nodes = equilibrium({ size: 1 });
nodes.forEach((position, node) => within(mm(distance(position, suspensionPoint(node))), 26, 4, `size +1: node ${node} to its suspension point`));
nodes = equilibrium({ size: -1 });
nodes.forEach((position, node) => assert.ok(mm(length(position)) < 22, `size -1: node ${node} near the centre`));
const restNodes = equilibrium({});
nodes = equilibrium({ AB: -1 });
assert.ok(distance(nodes[0], nodes[1]) > distance(restNodes[0], restNodes[1]), 'AB -1 pulls A and B apart');
console.log('calibration targets ok (connection +1 ~17 mm, suspension +1 ~17 mm, size ±1)');

// 5. Motion: the same for any stiffness scale (only the equilibrium matters); without limits it jumps there.
{
  const normal = new TetraModel();
  const tenTimesStiffer = new TetraModel({ baseSuspension: 0.5, baseConnection: 0.16 });
  for (const model of [normal, tenTimesStiffer]) {
    model.setInputs(mergeInputValues(defaultInputValues(), { B: 0.5, CD: -0.3 }));
    for (let i = 0; i < 25; i++) model.step();
  }
  normal.nodePositions().forEach((position, node) => position.forEach((coordinate, axis) => close(coordinate, tenTimesStiffer.nodePositions()[node][axis], 'same motion')));
  const unlimited = new TetraModel({ maxNodeSpeedMmPerS: Infinity, maxNodeAccelerationMmPerS2: Infinity });
  unlimited.setInputs(mergeInputValues(defaultInputValues(), { A: 1 }));
  unlimited.step();
  equilibrium({ A: 1 }).forEach((position, node) => close(distance(position, unlimited.nodePositions()[node]), 0, 'no limits: there in one step'));
  console.log('motion independent of stiffness scale');
}

// 6. Like a mass: speed and acceleration never above the limits, it stops on the equilibrium without
//    overshooting, and 1 m takes about 1 s (1500 mm/s, 4500 mm/s²). Also when the inputs change on the way.
{
  const { maxNodeSpeedMmPerS: maxSpeed, maxNodeAccelerationMmPerS2: maxAcceleration } = DEFAULT_TUNING;
  const seconds = STEP_MS / 1000;
  const run = (model, steps, changeInputs = () => {}) => {
    let previous = model.nodePositions().map((position) => [...position]);
    let previousVelocities = previous.map(() => [0, 0, 0]);
    let fastest = 0, hardest = 0;
    for (let step = 1; step <= steps; step++) {
      changeInputs(step);
      model.step();
      const velocities = model.nodePositions().map((position, node) => position.map((coordinate, axis) => mm(coordinate - previous[node][axis]) / seconds));
      fastest = Math.max(fastest, ...velocities.map(length));
      hardest = Math.max(hardest, ...velocities.map((velocity, node) => length(velocity.map((v, axis) => v - previousVelocities[node][axis])) / seconds));
      previous = model.nodePositions().map((position) => [...position]);
      previousVelocities = velocities;
    }
    return { fastest, hardest };
  };
  const changes = [[{}, { A: 1 }], [{ A: 1 }, {}], [{}, { size: -1 }], [{ size: -1 }, { size: 1 }], [{ CD: -1 }, { B: 1, size: 1 }]];
  for (const [from, to] of changes) {
    const model = new TetraModel();
    model.setInputs(mergeInputValues(defaultInputValues(), from));
    model.settle();
    model.setInputs(mergeInputValues(defaultInputValues(), to));
    const goal = equilibrium(to);
    const travelMm = Math.max(...model.nodePositions().map((position, node) => mm(distance(position, goal[node]))));
    const { fastest, hardest } = run(model, 300);
    assert.ok(fastest <= maxSpeed * 1.0001 && hardest <= maxAcceleration * 1.0001, `limits: ${fastest.toFixed(0)} mm/s, ${hardest.toFixed(0)} mm/s²`);
    model.nodePositions().forEach((position, node) => assert.ok(mm(distance(position, goal[node])) < 0.01, `arrives: ${JSON.stringify(to)}`));
  }
  // no overshoot: from A -1 (settled) to A +1 at once, no node goes past its new equilibrium
  {
    const model = new TetraModel();
    model.setInputs(mergeInputValues(defaultInputValues(), { A: -1 }));
    model.settle();
    const start = model.nodePositions().map((position) => [...position]);
    model.setInputs(mergeInputValues(defaultInputValues(), { A: 1 }));
    const goal = equilibrium({ A: 1 });
    const furthest = [0, 0, 0, 0];
    for (let step = 0; step < 300; step++) {
      model.step();
      model.nodePositions().forEach((position, node) => {
        const way = goal[node].map((coordinate, axis) => coordinate - start[node][axis]);
        const along = position.reduce((sum, coordinate, axis) => sum + (coordinate - start[node][axis]) * way[axis], 0) / length(way);
        furthest[node] = Math.max(furthest[node], mm(along - length(way)));
      });
    }
    assert.ok(Math.max(...furthest) < 0.1, `overshoot ${furthest.map((overshoot) => overshoot.toFixed(3)).join(' ')} mm`);
  }
  // one node 1 m away (start positions far from the size -1 pose): about 1 s
  const far = new TetraModel();
  far.network.setNodePositions(far.nodePositions().map((position, node) => (node === 0 ? position.map((coordinate) => coordinate + 1000 / MM_PER_MODEL_UNIT / Math.sqrt(3)) : position)));
  far.settle();
  const goal = far.nodePositions().map((position) => [...position]);
  far.network.setNodePositions(goal.map((position, node) => (node === 0 ? position.map((coordinate) => coordinate - 1000 / MM_PER_MODEL_UNIT / Math.sqrt(3)) : position)));
  let steps = 0;
  while (mm(distance(far.nodePositions()[0], goal[0])) > 0.5 && steps < 1000) {
    far.step();
    steps++;
  }
  assert.ok(steps * STEP_MS >= 950 && steps * STEP_MS <= 1100, `1 m in ${steps * STEP_MS} ms`);
  // inputs changing all the time (a fast timeline): still within the limits
  const chased = new TetraModel();
  const { fastest, hardest } = run(chased, 500, (step) => chased.setInputs(mergeInputValues(defaultInputValues(), { size: Math.sin(step / 15), AB: Math.cos(step / 7) })));
  assert.ok(fastest <= maxSpeed * 1.0001 && hardest <= maxAcceleration * 1.0001, `chasing: ${fastest.toFixed(0)} mm/s, ${hardest.toFixed(0)} mm/s²`);
  console.log(`moves like a mass: max ${maxSpeed} mm/s, ${maxAcceleration} mm/s², 1 m in ${steps * STEP_MS} ms, stops without overshoot`);
}

// 7. Stable for any input combination: random extremes stay finite and inside the box.
{
  const model = new TetraModel();
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let longestPositionRope = 0;
  for (let round = 0; round < 200; round++) {
    model.setInputs(Object.fromEntries(INPUTS.map((input) => [input.id, Math.sign(random()) * (round % 2 ? 1 : Math.abs(random()))])));
    for (let i = 0; i < 5; i++) model.step();
    assert.ok(model.nodePositions().flat().every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= 2), `round ${round}`);
    model.settle();
    model.ropeLengths().forEach((length, index) => {
      if (!ROPES[index].isDirect) assert.ok(mm(length) <= MAX_POSITION_ROPE_LENGTH_MM, `${ROPES[index].name} ${mm(length).toFixed(0)} mm, round ${round}`);
      longestPositionRope = Math.max(longestPositionRope, ROPES[index].isDirect ? 0 : mm(length));
    });
  }
  console.log(`stable for 200 random extreme input settings; longest position rope ${longestPositionRope.toFixed(0)} mm (max ${MAX_POSITION_ROPE_LENGTH_MM.toFixed(0)})`);
}

// 8. Winding: same formula as omwentelingen(), and the inverse round-trips.
const omwentelingen = (position, touwdikte, startRadius) => (Math.sqrt(startRadius ** 2 + (touwdikte * position) / Math.PI) - startRadius) / touwdikte;
for (const wound of [0, 100, 1000, 2500]) {
  const turns = revolutionsForWoundLength(wound, 6, 40);
  assert.equal(turns, omwentelingen(wound, 6, 40));
  assert.ok(Math.abs(woundLengthForRevolutions(turns, 6, 40) - wound) < 1e-9);
}
console.log(`winding ok (2.5 m on a 40 mm core with 6 mm rope = ${revolutionsForWoundLength(2500, 6, 40).toFixed(2)} turns)`);

// 9. Rope drive: free length -> turns from the empty drum, in the configured winding direction.
{
  const rope = ROPES[1];
  const pulley = { ropeThicknessMm: 5, coreRadiusMm: 40 };
  const drive = (windRotation, positiveRotation = 'cw') => new RopeDrive({ rope, windRotation, positiveRotation, ropeLengthMm: MAX_POSITION_ROPE_LENGTH_MM, minFreeLengthMm: 100 }, pulley);
  const wound = (freeLengthMm) => revolutionsForWoundLength(MAX_POSITION_ROPE_LENGTH_MM - freeLengthMm, 5, 40);
  assert.equal(drive('cw').motorTargetForFreeLength(MAX_POSITION_ROPE_LENGTH_MM).revolutions, 0); // all rope given: empty drum = 0
  assert.equal(drive('cw').motorTargetForFreeLength(1000).revolutions, wound(1000));
  assert.equal(drive('ccw').motorTargetForFreeLength(1000).revolutions, -wound(1000));
  assert.equal(drive('ccw', 'ccw').motorTargetForFreeLength(1000).revolutions, wound(1000));
  assert.equal(drive('cw').motorTargetForFreeLength(0).woundLengthMm, MAX_POSITION_ROPE_LENGTH_MM - 100); // never shorter than the minimum
  assert.throws(() => drive('clockwise'), /cw/);
  console.log(`rope drive ok (fully wound to 100 mm free: ${wound(100).toFixed(2)} turns on a 40 mm core with 5 mm rope)`);
}
