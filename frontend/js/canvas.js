class Canvas {

	constructor(elementId) {

		this.cnv = document.getElementById(elementId)
		this.cnv.width = this.cnv.offsetWidth
		this.cnv.height = this.cnv.offsetHeight
		this.ctx = this.cnv.getContext("2d")

		// config

		this.view = {"rotation": {"x": 0, "y": 0, "z": 0}, "zoom": 80}
		// this.state = {"rotation": {"x": 0, "y": 0}}
		this.mouse = {"x": 0, "y": 0, "isdown": false}
		this.rotationhistory = {"x": 0, "y": 0}

		this.data = {"object": [], "frame": [], "elements": []}
		this.rotation = {"x": 0, "y": 0, "z": 0}

		this.lines = []
		this.points = []

		this.makeRotationMatrix()

		var self = this
		this.cnv.onmousedown = function(e){
		    self.mouse.isdown = true
			self.mouse.x = e.offsetX
			self.mouse.y = e.offsetY
		}

		this.cnv.onmouseup = function(e){
		    self.mouse.isdown = false
		    self.rotationhistory.x += e.offsetX - self.mouse.x
		    self.rotationhistory.y += e.offsetY - self.mouse.y
		}

		this.cnv.onmousemove = function(e){
		    if(!self.mouse.isdown) return

		    self.view.rotation.x = (e.offsetY - self.mouse.y + self.rotationhistory.y) / 100.0
		    self.view.rotation.y = (e.offsetX - self.mouse.x + self.rotationhistory.x) / 100.0 * Math.sin(self.view.rotation.x)
		    self.view.rotation.z = (e.offsetX - self.mouse.x + self.rotationhistory.x) / 100.0 * Math.cos(self.view.rotation.x)

		    self.makeRotationMatrix()
		    self.update()

		    return false
		}

	}

	lineAdd(point1, point2, width, color){
		this.lines.push({"points": [point1, point2], "width": width, "color": color})
		return this.lines.length - 1
	}

	lineUpdate(lineidx, point1, point2){
		this.lines[lineidx].points = [point1, point2]
	}


	pointAdd(point, width, color){
		this.points.push({"point": point, "width": width, "color": color})
		return this.points.length - 1
	}

	pointUpdate(pointidx, point){
		this.points[pointidx].point = point
	}

	makeRotationMatrix() {
		this.rotation.x = [[1.0, 0, 0], [0, Math.cos(this.view.rotation.x), -1.0 * Math.sin(this.view.rotation.x)], [0, Math.sin(this.view.rotation.x), Math.cos(this.view.rotation.x)]]
		this.rotation.y = [[Math.cos(this.view.rotation.y), 0, Math.sin(this.view.rotation.y)], [0, 1.0, 0], [-1.0 * Math.sin(this.view.rotation.y), 0, Math.cos(this.view.rotation.y)]]
		this.rotation.z = [[Math.cos(this.view.rotation.z), -1.0 * Math.sin(this.view.rotation.z), 0], [Math.sin(this.view.rotation.z), Math.cos(this.view.rotation.z), 0], [0, 0, 1]]
	}

	rotatePoints(points){
		let p1 = math.multiply(points, this.rotation.x)
		return math.multiply(math.multiply(p1, this.rotation.y), this.rotation.z)
	}

	update() {
		// Clear canvas
		this.ctx.clearRect(0, 0, this.cnv.width, this.cnv.height)

		for(let pointidx = 0; pointidx < this.points.length; pointidx++){
			const points = this.rotatePoints(this.points[pointidx].point)

			let zoom0 = this.view.zoom + points[1] * this.view.zoom / 40
			// let zoom1 = this.view.zoom + points[1][1] * this.view.zoom / 40

			let x0 = points[0] * zoom0 + this.cnv.width / 2
			let y0 = points[2] * zoom0 + this.cnv.height / 2
			// let x1 = points[1][0] * zoom1 + this.cnv.width / 2
			// let y1 = points[1][2] * zoom1 + this.cnv.height / 2

			this.drawpoint([x0, y0], this.points[pointidx].width, this.points[pointidx].color)
		}


		for(let linesidx = 0; linesidx < this.lines.length; linesidx++){
			const points = this.rotatePoints(this.lines[linesidx].points)

			let zoom0 = this.view.zoom + points[0][1] * this.view.zoom / 40
			let zoom1 = this.view.zoom + points[1][1] * this.view.zoom / 40

			let x0 = points[0][0] * zoom0 + this.cnv.width / 2
			let y0 = points[0][2] * zoom0 + this.cnv.height / 2
			let x1 = points[1][0] * zoom1 + this.cnv.width / 2
			let y1 = points[1][2] * zoom1 + this.cnv.height / 2

			this.drawline([x0, y0], [x1, y1], this.lines[linesidx].width, this.lines[linesidx].color)
		}
	}


	drawline(a,b, width, color) {
		this.ctx.lineWidth = width || 1
		this.ctx.strokeStyle = color || "black"
		this.ctx.beginPath()
		this.ctx.moveTo(a[0], this.cnv.height - a[1])
		this.ctx.lineTo(b[0], this.cnv.height - b[1])
		this.ctx.stroke()
	}

	drawpoint(a, width, color) {
		this.ctx.lineWidth = 0
		// this.ctx.strokeStyle = color || "#FFF"
		this.ctx.beginPath()
		this.ctx.arc(a[0], a[1], width, 0, 2 * Math.PI, false)
		this.ctx.fillStyle = color
		this.ctx.fill()
		// this.ctx.stroke()
	}


}






