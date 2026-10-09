/** Serial port helpers shared by the CLI and the server. */

// The Ben's Electronics USB-RS485 converter (FTDI) on the studio Mac.
export const DEFAULT_RS485_PORT = '/dev/cu.usbserial-A50285BI';
export const DEFAULT_BAUD_RATE = 115200;
export async function listSerialPorts() {
  const { SerialPort } = await import('serialport');
  return SerialPort.list();
}

/** The given path, or the first FTDI converter found (prefers /dev/cu.*). */
export async function findRs485Port(path) {
  if (path) return path;
  const ports = await listSerialPorts();
  const isFtdi = (port) => port.vendorId?.toLowerCase() === '0403';
  const hit = ports.find((port) => isFtdi(port) && /cu\./.test(port.path)) ?? ports.find(isFtdi) ?? ports.find((port) => /usbserial/i.test(port.path));
  if (!hit) throw new Error('No FTDI serial port found. Run "node bin/cli.js ports" and set serial.path in the config.');
  return hit.path;
}
