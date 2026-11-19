const SPEC = {
  arms: { type: 'list', default: 'baseline,distill' },
  repeats: { type: 'int', default: 1, min: 1 },
  tasks: { type: 'string', default: '' },
  model: { type: 'string', default: 'sonnet' },
  'max-cost-usd': { type: 'number', default: 20 },
  'max-runs': { type: 'int', default: Number.POSITIVE_INFINITY, min: 1 },
  package: { type: 'string', default: 'distill-llm@latest' },
  results: { type: 'string', default: '' },
  resume: { type: 'bool', default: false },
  night: { type: 'string', default: '' },
  seed: { type: 'string', default: '' },
  claude: { type: 'string', default: '' },
  'run-budget-usd': { type: 'number', default: 2 },
  'max-turns': { type: 'int', default: 30, min: 1 },
  'timeout-ms': { type: 'int', default: 15 * 60 * 1000, min: 1 },
  'tasks-file': { type: 'string', default: '' },
  'corpus-file': { type: 'string', default: '' },
  keep: { type: 'bool', default: false },
  'dry-run': { type: 'bool', default: false },
};

export function parseArgs(argv) {
  const values = {};
  for (const [key, spec] of Object.entries(SPEC)) values[key] = spec.default;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const inline = arg.indexOf('=');
    const key = inline === -1 ? arg.slice(2) : arg.slice(2, inline);
    const spec = SPEC[key];
    if (!spec) throw new Error(`Unknown option --${key}`);
    if (spec.type === 'bool') {
      values[key] = true;
      continue;
    }
    let raw = inline === -1 ? argv[i + 1] : arg.slice(inline + 1);
    if (inline === -1) i += 1;
    if (raw === undefined || (inline === -1 && raw.startsWith('--'))) throw new Error(`--${key} needs a value`);
    raw = String(raw);
    if (spec.type === 'int' || spec.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n)) || (spec.min !== undefined && n < spec.min) || n < 0) {
        throw new Error(`--${key} must be a valid number, got ${raw}`);
      }
      values[key] = n;
    } else if (spec.type === 'list') {
      values[key] = raw.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      values[key] = raw;
    }
  }
  if (typeof values.arms === 'string') values.arms = values.arms.split(',');
  for (const arm of values.arms) if (arm !== 'baseline' && arm !== 'distill') throw new Error(`Unknown arm ${arm}`);
  if (values.arms.length === 0) throw new Error('--arms needs at least one arm');
  return values;
}
