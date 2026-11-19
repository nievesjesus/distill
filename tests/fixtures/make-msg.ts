const SECTOR = 512;
const MINI = 64;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FAT_SECTOR = 0xfffffffd;

export interface MsgFixture {
  subject: string;
  senderName: string;
  senderEmail: string;
  body: string;
}

interface Stream {
  name: string;
  data: Buffer;
}

const utf16 = (text: string): Buffer => Buffer.from(text, 'utf16le');

function property(tag: number, type: number, size: number): Buffer {
  const entry = Buffer.alloc(16);
  entry.writeUInt32LE(((tag << 16) | type) >>> 0, 0);
  entry.writeUInt32LE(0x6, 4);
  entry.writeUInt32LE(size, 8);
  return entry;
}

function directoryEntry(name: string, type: number, left: number, right: number, child: number, start: number, size: number): Buffer {
  const entry = Buffer.alloc(128);
  const encoded = Buffer.from(`${name}\0`, 'utf16le');
  encoded.copy(entry, 0);
  entry.writeUInt16LE(encoded.length, 64);
  entry.writeUInt8(type, 66);
  entry.writeUInt8(1, 67);
  entry.writeUInt32LE(left >>> 0, 68);
  entry.writeUInt32LE(right >>> 0, 72);
  entry.writeUInt32LE(child >>> 0, 76);
  entry.writeUInt32LE(start >>> 0, 116);
  entry.writeUInt32LE(size, 120);
  return entry;
}

export function makeMsg(fixture: MsgFixture): Buffer {
  const strings: [number, string][] = [
    [0x0037, fixture.subject],
    [0x0c1a, fixture.senderName],
    [0x0c1f, fixture.senderEmail],
    [0x1000, fixture.body],
  ];
  const streams: Stream[] = strings.map(([tag, value]) => ({
    name: `__substg1.0_${tag.toString(16).toUpperCase().padStart(4, '0')}001F`,
    data: utf16(value),
  }));
  const props: Buffer[] = [];
  const header = Buffer.alloc(32);
  props.push(header);
  for (const [tag, value] of strings) props.push(property(tag, 0x1f, utf16(value).length + 2));
  streams.unshift({ name: '__properties_version1.0', data: Buffer.concat(props) });

  const miniParts: Buffer[] = [];
  const miniStarts: number[] = [];
  let miniCount = 0;
  const miniFat: number[] = [];
  for (const stream of streams) {
    const count = Math.max(1, Math.ceil(stream.data.length / MINI));
    miniStarts.push(miniCount);
    for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END : miniCount + i + 1);
    const padded = Buffer.alloc(count * MINI);
    stream.data.copy(padded);
    miniParts.push(padded);
    miniCount += count;
  }
  const miniStream = Buffer.concat(miniParts);
  const miniStreamSectors = Math.ceil(miniStream.length / SECTOR);
  const miniFatBytes = Buffer.alloc(Math.ceil(miniFat.length / 128) * SECTOR, 0xff);
  miniFat.forEach((value, index) => miniFatBytes.writeUInt32LE(value >>> 0, index * 4));
  const miniFatSectors = miniFatBytes.length / SECTOR;

  const entries: Buffer[] = [];
  const total = streams.length + 1;
  const directorySectors = Math.ceil(total / 4);
  const dirStart = 1;
  const miniFatStart = dirStart + directorySectors;
  const miniStreamStart = miniFatStart + miniFatSectors;
  entries.push(directoryEntry('Root Entry', 5, FREE, FREE, total > 1 ? 1 : FREE, miniStreamStart, miniStream.length));
  streams.forEach((stream, index) => {
    entries.push(directoryEntry(stream.name, 2, FREE, index + 2 < total ? index + 2 : FREE, FREE, miniStarts[index] as number, stream.data.length));
  });
  while (entries.length % 4 !== 0) entries.push(Buffer.alloc(128));
  const directory = Buffer.concat(entries);

  const sectorCount = 1 + directorySectors + miniFatSectors + miniStreamSectors;
  const fat = Buffer.alloc(SECTOR, 0xff);
  const setFat = (index: number, value: number): void => {
    fat.writeUInt32LE(value >>> 0, index * 4);
  };
  setFat(0, FAT_SECTOR);
  const chain = (start: number, count: number): void => {
    for (let i = 0; i < count; i++) setFat(start + i, i === count - 1 ? END : start + i + 1);
  };
  chain(dirStart, directorySectors);
  chain(miniFatStart, miniFatSectors);
  chain(miniStreamStart, miniStreamSectors);
  if (sectorCount > 128) throw new Error('fixture too large');

  const head = Buffer.alloc(SECTOR, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(head, 0);
  head.writeUInt16LE(0x3e, 24);
  head.writeUInt16LE(0x3, 26);
  head.writeUInt16LE(0xfffe, 28);
  head.writeUInt16LE(9, 30);
  head.writeUInt16LE(6, 32);
  head.writeUInt32LE(0, 40);
  head.writeUInt32LE(1, 44);
  head.writeUInt32LE(dirStart, 48);
  head.writeUInt32LE(4096, 56);
  head.writeUInt32LE(miniFatStart, 60);
  head.writeUInt32LE(miniFatSectors, 64);
  head.writeUInt32LE(END, 68);
  head.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) head.writeUInt32LE(i === 0 ? 0 : FREE, 76 + i * 4);

  const miniPadded = Buffer.alloc(miniStreamSectors * SECTOR);
  miniStream.copy(miniPadded);
  return Buffer.concat([head, fat, directory, miniFatBytes, miniPadded]);
}
