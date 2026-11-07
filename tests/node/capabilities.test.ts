import { describe, expect, it } from 'vitest';
import { hasLibreOffice, sofficeCandidates } from '../../src/node/capabilities';

const programFiles = 'D:\\Apps';
const programFilesX86 = 'E:\\Apps (x86)';

function existsOnly(...present: string[]) {
  return async (path: string) => present.includes(path);
}

describe('hasLibreOffice on Windows', () => {
  const env = { ProgramFiles: programFiles, 'ProgramFiles(x86)': programFilesX86, PATH: 'C:\\Windows;C:\\Tools' };

  it('finds soffice.exe under %ProgramFiles% when it is not on PATH', async () => {
    const found = await hasLibreOffice({
      platform: 'win32',
      env,
      isExecutable: existsOnly('D:\\Apps\\LibreOffice\\program\\soffice.exe'),
    });
    expect(found).toBe(true);
  });

  it('finds soffice.exe under %ProgramFiles(x86)%', async () => {
    const found = await hasLibreOffice({
      platform: 'win32',
      env,
      isExecutable: existsOnly('E:\\Apps (x86)\\LibreOffice\\program\\soffice.exe'),
    });
    expect(found).toBe(true);
  });

  it('finds soffice.exe on PATH', async () => {
    const found = await hasLibreOffice({
      platform: 'win32',
      env,
      isExecutable: existsOnly('C:\\Tools\\soffice.exe'),
    });
    expect(found).toBe(true);
  });

  it('reports false when nothing exists', async () => {
    expect(await hasLibreOffice({ platform: 'win32', env, isExecutable: existsOnly() })).toBe(false);
  });

  it('reads the install roots from the environment instead of assuming a drive', () => {
    const candidates = sofficeCandidates('win32', env);
    expect(candidates).toContain('D:\\Apps\\LibreOffice\\program\\soffice.exe');
    expect(candidates).toContain('E:\\Apps (x86)\\LibreOffice\\program\\soffice.exe');
    expect(candidates.some((candidate) => candidate.startsWith('C:\\Program Files'))).toBe(false);
  });

  it('skips unset install roots', () => {
    const candidates = sofficeCandidates('win32', { PATH: 'C:\\Tools' });
    expect(candidates).toEqual(['C:\\Tools\\soffice.exe', 'C:\\Tools\\libreoffice.exe']);
  });
});

describe('hasLibreOffice on other platforms', () => {
  it('adds the application bundle on macOS', async () => {
    const found = await hasLibreOffice({
      platform: 'darwin',
      env: { PATH: '/usr/bin' },
      isExecutable: existsOnly('/Applications/LibreOffice.app/Contents/MacOS/soffice'),
    });
    expect(found).toBe(true);
  });

  it('does not probe Windows locations on Linux', () => {
    expect(sofficeCandidates('linux', { PATH: '/usr/bin:/opt/bin', ProgramFiles: 'X:\\' })).toEqual([
      '/usr/bin/soffice',
      '/usr/bin/libreoffice',
      '/opt/bin/soffice',
      '/opt/bin/libreoffice',
    ]);
  });
});
