const SEPARATORS = /[\\/]/;
const FALLBACK = 'document';
const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function baseName(original: string): string {
  const parts = original.split(SEPARATORS).filter((part) => part.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : FALLBACK;
}

export function mdName(original: string): string {
  const base = baseName(original);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.md`;
}

export function jsonName(original: string): string {
  return mdName(original).replace(/\.md$/, '.json');
}

export function uniqueNames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    const stem = name.endsWith('.md') ? name.slice(0, -3) : name;
    let candidate = name;
    let counter = 2;
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${stem} (${counter}).md`;
      counter += 1;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

export function zipEntryName(name: string): string {
  const stem = name.endsWith('.md') ? name.slice(0, -3) : name;
  const cleaned = stem.replace(WINDOWS_FORBIDDEN, '_').replace(/[. ]+$/, '');
  const base = cleaned === '' ? FALLBACK : cleaned;
  return `${WINDOWS_RESERVED.test(base) ? `_${base}` : base}.md`;
}
