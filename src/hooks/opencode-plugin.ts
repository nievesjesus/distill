import { isHookConvertible } from './supported';

const CANDIDATE_EXTENSIONS = ['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'odt', 'ods', 'odp', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp'];

export function hookExtensions(): string[] {
  return CANDIDATE_EXTENSIONS.filter((extension) => isHookConvertible(`file.${extension}`));
}

export function opencodePluginSource(command: string): string {
  return [
    `import { execFile } from 'node:child_process';`,
    `import { extname, isAbsolute, resolve } from 'node:path';`,
    ``,
    `const COMMAND = ${JSON.stringify(command)}.split(' ');`,
    `const EXTENSIONS = new Set(${JSON.stringify(hookExtensions())});`,
    `const ARG_KEYS = ['filePath', 'file_path', 'path'];`,
    `const TIMEOUT_MS = 120000;`,
    ``,
    `const convert = (file) =>`,
    `  new Promise((done) => {`,
    `    const [bin, ...base] = COMMAND;`,
    `    execFile(bin, [...base, 'hook', 'convert', file], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => {`,
    `      if (error) return done(null);`,
    `      try {`,
    `        const parsed = JSON.parse(String(stdout));`,
    `        done(typeof parsed.path === 'string' && parsed.path !== '' ? parsed.path : null);`,
    `      } catch {`,
    `        done(null);`,
    `      }`,
    `    });`,
    `  });`,
    ``,
    `export const DistillPlugin = async (context) => {`,
    `  const base = (context && (context.directory || context.worktree)) || process.cwd();`,
    `  return {`,
    `    'tool.execute.before': async (input, output) => {`,
    `      try {`,
    `        if (!input || input.tool !== 'read') return;`,
    `        const args = output && output.args;`,
    `        if (!args) return;`,
    `        const key = ARG_KEYS.find((name) => typeof args[name] === 'string');`,
    `        if (key === undefined) return;`,
    `        const value = args[key];`,
    `        if (!EXTENSIONS.has(extname(value).slice(1).toLowerCase())) return;`,
    `        const converted = await convert(isAbsolute(value) ? value : resolve(base, value));`,
    `        if (converted !== null) args[key] = converted;`,
    `      } catch {}`,
    `    },`,
    `  };`,
    `};`,
    ``,
  ].join('\n');
}
