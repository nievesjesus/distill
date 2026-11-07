const CONTEXT_LINES = 2;

export function lineDiff(before: string, after: string): string[] {
  const a = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  const b = after === '' ? [] : after.replace(/\n$/, '').split('\n');
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: { mark: string; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ mark: ' ', text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ mark: '-', text: a[i++] });
    } else {
      ops.push({ mark: '+', text: b[j++] });
    }
  }
  while (i < a.length) ops.push({ mark: '-', text: a[i++] });
  while (j < b.length) ops.push({ mark: '+', text: b[j++] });

  const visible = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.mark === ' ') return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    for (let k = from; k <= to; k++) visible[k] = true;
  });

  const out: string[] = [];
  let collapsed = false;
  ops.forEach((op, index) => {
    if (!visible[index]) {
      if (!collapsed) out.push('…');
      collapsed = true;
      return;
    }
    collapsed = false;
    out.push(`${op.mark} ${op.text}`);
  });
  return out;
}
