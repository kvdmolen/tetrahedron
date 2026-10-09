// Geometry of the sculpture, in model units. The box runs from -2 to +2 on every axis,
// so 4 model units = the real box size (793 mm).

export const BOX_SIZE_MM = 793;
export const BOX_SIZE_MODEL_UNITS = 4;
export const MM_PER_MODEL_UNIT = BOX_SIZE_MM / BOX_SIZE_MODEL_UNITS;

// The 4 moving nodes (corners of the tetrahedron), at rest.
export const NODE_REST_POSITIONS = [
  [-1, 1, -1],
  [1, -1, -1],
  [-1, -1, 1],
  [1, 1, 1],
];

// The 8 fixed corners of the box.
export const BOX_CORNERS = [
  [-2, 2, -2], [2, 2, -2], [2, -2, -2], [-2, -2, -2],
  [-2, 2, 2], [2, 2, 2], [2, -2, 2], [-2, -2, 2],
];

// Each node has one box corner where its 4 motors sit.
export const CORNER_OF_NODE = [0, 2, 7, 5];

/**
 * 16 ropes. From the corner of node `viaNode` run 4 ropes:
 *   - 1 direct rope: corner -> viaNode (isDirect, constant-tension motor)
 *   - 3 through-ropes: corner -> viaNode (rope runs over a pulley there) -> endNode
 * Rope index = viaNode * 4 + endNode.
 */
export const ROPES = [];
for (let viaNode = 0; viaNode < 4; viaNode++) {
  for (let endNode = 0; endNode < 4; endNode++) {
    const isDirect = viaNode === endNode;
    ROPES.push({
      index: ROPES.length,
      name: isDirect ? `c${viaNode}→n${viaNode}` : `c${viaNode}→n${viaNode}→n${endNode}`,
      cornerIndex: CORNER_OF_NODE[viaNode],
      viaNode,
      endNode,
      isDirect,
      role: isDirect ? 'tension' : 'position',
    });
  }
}

// Lines to draw: the 6 tetrahedron edges and the 4 corner-to-node ropes ([nodeIndex, nodeIndex|corner]).
export const TETRA_EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
export const CORNER_ROPE_LINES = CORNER_OF_NODE.map((cornerIndex, nodeIndex) => [nodeIndex, cornerIndex]);

// Box outline, as pairs of corner indices.
export const BOX_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
