// Small 3D vector helpers as plain functions (no Array.prototype extensions),
// so the same code runs in the browser and in Node.

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, factor) => [a[0] * factor, a[1] * factor, a[2] * factor];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const length = (a) => Math.sqrt(dot(a, a));
export const distance = (a, b) => length(subtract(a, b));
