class Elastic {
	constructor(modeldata) {
		this.nodes = modeldata.nodes.map(node => ({
			org: node,
			pos: [...node],
			target: [...node]
		}))

		this.nodesfixed = modeldata.nodesfixed

		// Each node's anchor corner (index into nodesfixed)
		// Node 0 → nodesfixed[0] = [-2, 2,-2]
		// Node 1 → nodesfixed[2] = [ 2,-2,-2]
		// Node 2 → nodesfixed[7] = [-2,-2, 2]
		// Node 3 → nodesfixed[5] = [ 2, 2, 2]
		this.cornerOf = [0, 2, 7, 5]

		// 16 ropes: from each corner, 1 direct + 3 through-ropes
		// Direct rope:  corner → node  (1 segment)
		// Through-rope: corner → throughNode (pulley) → endNode  (2 segments, 1 continuous rope)
		this.ropes = []
		for (let t = 0; t < 4; t++) {
			for (let e = 0; e < 4; e++) {
				this.ropes.push({
					cornerIdx: this.cornerOf[t],
					throughNode: t,
					endNode: e,
					isDirect: t === e
				})
			}
		}

		this.strength = 0.05
	}

	setTarget(nodeidx, target) {
		this.nodes[nodeidx].target = this.nodes[nodeidx].org.add(target)
	}

	// Collect all rope-pull unit vectors acting on a specific node.
	// A direct rope pulls the node toward its corner.
	// A through-rope pulls the pulley node toward corner AND toward the endpoint,
	// and pulls the endpoint toward the pulley node.
	getRopeDirections(nodeidx) {
		const dirs = []
		const pos = this.nodes[nodeidx].pos

		for (const rope of this.ropes) {
			const cornerPos = this.nodesfixed[rope.cornerIdx]

			if (rope.isDirect && rope.throughNode === nodeidx) {
				// Direct rope: node pulled toward corner
				const v = cornerPos.substract(pos)
				const d = v.norm()
				if (d > 0.001) dirs.push(v.divideby(d))

			} else if (!rope.isDirect) {
				if (rope.throughNode === nodeidx) {
					// Pulley node: pulled toward corner
					const v1 = cornerPos.substract(pos)
					const d1 = v1.norm()
					if (d1 > 0.001) dirs.push(v1.divideby(d1))

					// Pulley node: pulled toward endpoint
					const v2 = this.nodes[rope.endNode].pos.substract(pos)
					const d2 = v2.norm()
					if (d2 > 0.001) dirs.push(v2.divideby(d2))
				}

				if (rope.endNode === nodeidx) {
					// Endpoint: pulled toward pulley node
					const v = this.nodes[rope.throughNode].pos.substract(pos)
					const d = v.norm()
					if (d > 0.001) dirs.push(v.divideby(d))
				}
			}
		}
		return dirs
	}

	interate() {
		// Compute constrained displacements for all nodes from current state
		const updates = []

		for (let i = 0; i < this.nodes.length; i++) {
			const desired = this.nodes[i].target.substract(this.nodes[i].pos)
			const dirs = this.getRopeDirections(i)

			// Project desired displacement onto each rope direction.
			// Only keep positive components (ropes can only pull).
			let pull = [0, 0, 0]
			for (const dir of dirs) {
				const alignment = desired.dot(dir)
				if (alignment > 0) {
					pull = pull.add(dir.multiply(alignment))
				}
			}

			// Average across all rope directions to prevent overcounting
			if (dirs.length > 0) {
				pull = pull.divideby(dirs.length)
			}

			updates.push(pull.multiply(this.strength))
		}

		// Apply all updates simultaneously (consistent snapshot)
		for (let i = 0; i < this.nodes.length; i++) {
			this.nodes[i].pos = this.nodes[i].pos.add(updates[i])
		}
	}

	getNodes() {
		return this.nodes.map(el => el.pos)
	}

	// Output: 16 rope lengths (motor positions)
	getRopeLengths() {
		return this.ropes.map(rope => {
			const cornerPos = this.nodesfixed[rope.cornerIdx]
			const tPos = this.nodes[rope.throughNode].pos
			const seg1 = cornerPos.substract(tPos).norm()
			if (rope.isDirect) return seg1
			const ePos = this.nodes[rope.endNode].pos
			return seg1 + tPos.substract(ePos).norm()
		})
	}
}
