// Modbus CRC-16 (poly 0xA001, init 0xFFFF). On the wire the LOW byte goes first.
const TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
  TABLE[i] = c;
}

export function crc16(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xff];
  return crc;
}

export function appendCrc(buf) {
  const c = crc16(buf);
  return Buffer.concat([buf, Buffer.from([c & 0xff, c >> 8])]);
}

export function checkCrc(frame) {
  if (frame.length < 4) return false;
  const c = crc16(frame.subarray(0, frame.length - 2));
  return frame[frame.length - 2] === (c & 0xff) && frame[frame.length - 1] === c >> 8;
}
