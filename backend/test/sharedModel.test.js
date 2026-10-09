// The shared model must behave exactly like the original browser code (frontend/elastic.js),
// and the winding maths must match omwentelingen().
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RopeModel } from '../../shared/RopeModel.js';
import { computeNodeTargets, defaultShapeInputs, mergeShapeInputs } from '../../shared/shapeControls.js';
import { NODE_REST_POSITIONS, BOX_CORNERS, ROPES, CORNER_OF_NODE } from '../../shared/tetraGeometry.js';
import { revolutionsForWoundLength, woundLengthForRevolutions } from '../../shared/winding.js';

// 1. Load the original Elastic class (and its Array.prototype helpers) in a sandbox.
const sandbox = { console };
vm.createContext(sandbox);
const frontend = new URL('../../frontend/', import.meta.url);
vm.runInContext(readFileSync(new URL('js/prototype.js', frontend), 'utf8'), sandbox);
vm.runInContext(readFileSync(new URL('elastic.js', frontend), 'utf8') + '\nthis.Elastic = Elastic;', sandbox);
const original = new sandbox.Elastic(vm.runInContext(`({
  nodes: ${JSON.stringify(NODE_REST_POSITIONS)},
  nodesfixed: ${JSON.stringify(BOX_CORNERS)},
  edges: [],
})`, sandbox));
assert.deepEqual([...original.cornerOf], CORNER_OF_NODE);

// Same inputs as a user dragging sliders.
const inputs = mergeShapeInputs(defaultShapeInputs(), { position: { x: 0.3, y: -0.2, z: 0.1 }, size: 0.25, skew: { e01: 0.4, e23: -0.3 } });
const targets = computeNodeTargets(inputs);
const model = new RopeModel();
model.setNodeTargets(targets);
targets.forEach((target, nodeIndex) => original.setTarget(nodeIndex, vm.runInContext(JSON.stringify(target.map((v, axis) => v - NODE_REST_POSITIONS[nodeIndex][axis])), sandbox)));

for (let step = 0; step < 500; step++) {
  model.step();
  original.interate();
  if (step % 50 === 0 || step === 499) {
    const expected = [...original.getRopeLengths()];
    model.ropeLengths().forEach((len, ropeIndex) => assert.ok(Math.abs(len - expected[ropeIndex]) < 1e-9, `rope ${ropeIndex} step ${step}`));
  }
}
assert.equal(ROPES.length, 16);
assert.equal(ROPES.filter((rope) => rope.isDirect).length, 4);
console.log('shared model matches frontend/elastic.js');

// 2. Winding: same formula as omwentelingen(), and the inverse round-trips.
const omwentelingen = (position, touwdikte, startRadius) => (Math.sqrt(startRadius ** 2 + (touwdikte * position) / Math.PI) - startRadius) / touwdikte;
for (const wound of [0, 100, 1000, 2500]) {
  const turns = revolutionsForWoundLength(wound, 6, 40);
  assert.equal(turns, omwentelingen(wound, 6, 40));
  assert.ok(Math.abs(woundLengthForRevolutions(turns, 6, 40) - wound) < 1e-9);
}
console.log(`winding ok (2.5 m on a 40 mm core with 6 mm rope = ${revolutionsForWoundLength(2500, 6, 40).toFixed(2)} turns)`);
