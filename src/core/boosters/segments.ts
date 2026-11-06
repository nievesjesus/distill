interface Segment {
  lines: string[];
  protectedBlock: boolean;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

function frontMatterEnd(lines: string[]): number {
  if (lines[0] !== '---') return -1;
  return lines.indexOf('---', 1);
}

function closesFence(line: string, fenceChar: string, fenceLen: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return match !== null && match[1][0] === fenceChar && match[1].length >= fenceLen;
}

function splitSegments(md: string): Segment[] {
  const lines = md.split('\n');
  const segments: Segment[] = [];
  let current: Segment | null = null;

  const push = (line: string, protectedBlock: boolean) => {
    if (current === null || current.protectedBlock !== protectedBlock) {
      current = { lines: [], protectedBlock };
      segments.push(current);
    }
    current.lines.push(line);
  };

  let start = 0;
  const frontEnd = frontMatterEnd(lines);
  if (frontEnd > 0) {
    for (let i = 0; i <= frontEnd; i++) push(lines[i], true);
    start = frontEnd + 1;
  }

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (inFence) {
      push(line, true);
      if (closesFence(line, fenceChar, fenceLen)) inFence = false;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      inFence = true;
      fenceChar = open[1][0];
      fenceLen = open[1].length;
      push(line, true);
      continue;
    }
    push(line, false);
  }

  return segments;
}

export function mapProse(md: string, fn: (prose: string) => string): string {
  return splitSegments(md)
    .map((segment) => {
      const text = segment.lines.join('\n');
      return segment.protectedBlock ? text : fn(text);
    })
    .join('\n');
}
