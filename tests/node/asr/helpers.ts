export interface WavSpec {
  rate: number;
  channels: number;
  bits: 16 | 24 | 32;
  float?: boolean;
  frames: (index: number, channel: number) => number;
  count: number;
  extensible?: boolean;
  extraChunk?: number;
  dataSizeOverride?: number;
}

export function makeWav(spec: WavSpec): Buffer {
  const bytes = spec.bits / 8;
  const blockAlign = spec.channels * bytes;
  const data = Buffer.alloc(spec.count * blockAlign);
  for (let i = 0; i < spec.count; i++) {
    for (let c = 0; c < spec.channels; c++) {
      const value = Math.max(-1, Math.min(1, spec.frames(i, c)));
      const at = i * blockAlign + c * bytes;
      if (spec.float) data.writeFloatLE(value, at);
      else if (spec.bits === 16) data.writeInt16LE(Math.round(value * 32767), at);
      else if (spec.bits === 24) data.writeIntLE(Math.round(value * 8388607), at, 3);
      else data.writeInt32LE(Math.round(value * 2147483647), at);
    }
  }
  const tag = spec.float ? 3 : 1;
  const fmtSize = spec.extensible ? 40 : 16;
  const fmt = Buffer.alloc(8 + fmtSize);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(fmtSize, 4);
  fmt.writeUInt16LE(spec.extensible ? 0xfffe : tag, 8);
  fmt.writeUInt16LE(spec.channels, 10);
  fmt.writeUInt32LE(spec.rate, 12);
  fmt.writeUInt32LE(spec.rate * blockAlign, 16);
  fmt.writeUInt16LE(blockAlign, 20);
  fmt.writeUInt16LE(spec.bits, 22);
  if (spec.extensible) {
    fmt.writeUInt16LE(22, 24);
    fmt.writeUInt16LE(spec.bits, 26);
    fmt.writeUInt32LE(3, 28);
    fmt.writeUInt16LE(tag, 32);
  }
  const extra = spec.extraChunk ? Buffer.concat([Buffer.from('LIST'), u32(spec.extraChunk), Buffer.alloc(spec.extraChunk + (spec.extraChunk % 2))]) : Buffer.alloc(0);
  const dataHeader = Buffer.concat([Buffer.from('data'), u32(spec.dataSizeOverride ?? data.length)]);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, extra, dataHeader, data]);
  return Buffer.concat([Buffer.from('RIFF'), u32(body.length), body]);
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value, 0);
  return b;
}

export function sine(hz: number, rate: number) {
  return (i: number) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
}
