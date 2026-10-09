Object.defineProperty(Array.prototype,  "contains",    {enumerable: false, value: function(idx){return this.indexOf(idx)>-1}})
Object.defineProperty(Array.prototype,  "shuffle",     {enumerable: false, value: function(){var i = this.length, j, temp;if ( i == 0 ) return this;while ( --i ) {j = Math.floor( Math.random() * ( i + 1 ) );temp = this[i];this[i] = this[j];this[j] = temp;}return this;}})
Object.defineProperty(Array.prototype,  "includesall", {enumerable: false, value: function(arr){var self = this; return arr.reduce((acc, el) => {return !acc ? false : self.includes(el)}, true)}})
Object.defineProperty(Number.prototype, "range",       {enumerable: false, value: function(min, max) {return Math.min(Math.max(this, min), max)}})
Object.defineProperty(Array.prototype,  "first",       {enumerable: false, value:  function(def) {return this && this.length ? this[0] : def ? def : null}})
Object.defineProperty(Array.prototype,  "unique",      {enumerable: false, value: function(){return this.filter(function(value, index, self){return self.indexOf(value) === index})}})
Object.defineProperty(Array.prototype,  "removelast",  {enumerable: false, value: function(){return this.slice(0, this.length-1)}})
Object.defineProperty(Array.prototype,  "removefirst", {enumerable: false, value: function(){this.splice(0, 1); return this}})
Object.defineProperty(Array.prototype,  "remove",      {enumerable: false, value: function(id){const index = this.indexOf(id);if(index>-1){this.splice(index, 1);} return this}})


// Object.defineProperty(Object.prototype, "flatten",     {enumerable: false, value: function(){
// 	return Object.keys(this).reduce((acc, curr) => Object.keys(this[curr]).length ? acc + ":" + curr + ":" + this[curr].flatten() : acc + ":" + curr )
// }})
var copy = function(obj){
	return JSON.parse(JSON.stringify())
}
var log = function(obj){
	if(typeof(obj) == "object"){
		console.log(copy(obj))
	}else{
		console.log(obj)
	}
}

var copy = function(obj){return JSON.parse(JSON.stringify(obj))}
var log = function(obj){if(typeof(obj) == "object"){console.log(copy(obj))}else{console.log(obj)}}


Object.defineProperty(Array.prototype,  "substract",    {enumerable: false, value: function(arr){
	return this.map((el, idx) => {
		return el - arr[idx]
	})
}})

Object.defineProperty(Array.prototype,  "add",    {enumerable: false, value: function(arr){
	return this.map((el, idx) => {
		return el + arr[idx]
	})
}})

Object.defineProperty(Array.prototype,  "norm",    {enumerable: false, value: function(){
	let tot = 0
	for(let i = 0; i < this.length; i++){
		tot += this[i]*this[i]
	}
	return Math.sqrt(tot)
}})

Object.defineProperty(Array.prototype,  "divideby",    {enumerable: false, value: function(arg){
	if(typeof(arg) == "number"){
		return this.map(el => {
			return el / arg
		})
	}else if(typeof(arg) == "object" && this.length == arg.length){
		return this.map((el, idx) => {
			return el / arg[idx]
		})		
	}
}})


Object.defineProperty(Array.prototype,  "multiply",    {enumerable: false, value: function(arg){
	if(typeof(arg) == "number"){
		return this.map(el => {
			return el * arg
		})
	}else if(typeof(arg) == "object" && this.length == arg.length){
		return this.map((el, idx) => {
			return el * arg[idx]
		})		
	}
}})


// Object.defineProperty(Array.prototype,  "unit",    {enumerable: false, value: function(){
	// let len = this.normalize()
	// return 
	// let tot = this.reduce((accumulator, currentValue) => {
	// 	return (accumulator + currentValue * currentValue)
	// })
	// return Math.sqrt(tot)
// }})

Object.defineProperty(Array.prototype,  "sum",    {enumerable: false, value: function(){
	return this.reduce((accumulator, currentValue) => {
		return (accumulator + currentValue)
	})
}})

Object.defineProperty(Array.prototype,  "invert",    {enumerable: false, value: function(){
	return this.multiply(-1)
}})


Object.defineProperty(Array.prototype,  "dot",    {enumerable: false, value: function(arr){
	let tot = 0
	for(let i = 0; i < this.length; i++){
		tot += this[i] * arr[i]
	}
	return tot	
	// return this.map((el, idx) => {
	// 	this[idx] * arr[idx]
	// }).reduce((acc, curr) => {
	// 	acc + curr
	// })
	// return this.reduce((acc, curr, idx)=>{
	// 	acc += curr * arr[idx]
	// })
}})

// dot = (a, b) => 
// console.log(dot([1,2,3], [1,0,1]));

// Object.defineProperty(Array.prototype,  "angleto",    {enumerable: false, value: function(arr){
// 	return Math.acos(this.dot(arr) / (this.length * arr.length)
// }})

Object.defineProperty(Array.prototype,  "projectto",    {enumerable: false, value: function(arr){
	let sc = this.dot(arr)
	let a = sc / arr.norm()
	console.log(a)
	console.log(arr.divideby(arr.norm()))
	return arr.divideby(arr.norm()).multiply(a)
}})


Object.defineProperty(Array.prototype,  "projecton",    {enumerable: false, value: function(arr){
	let tot = 0
	for(let i = 0; i < arr.length; i++){
		tot += arr[i]*arr[i]
	}


	return this.dot(arr) / Math.sqrt(tot)
	// console.log(a)
	// console.log(arr.divideby(arr.norm()))
	// return arr.divideby(arr.norm()).multiply(a)
}})

Object.defineProperty(Array.prototype,  "reset",    {enumerable: false, value: function(arr){
	return [0,0,0]
	// console.log(a)
	// console.log(arr.divideby(arr.norm()))
	// return arr.divideby(arr.norm()).multiply(a)
}})



