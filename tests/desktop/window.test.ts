import { describe, expect, it } from 'vitest';
import { isAllowedExternal, isSameOrigin, tessdataDir, windowOptions } from '../../desktop/window';

describe('windowOptions', () => {
  it('uses the hardened distill window defaults', () => {
    expect(windowOptions()).toMatchObject({
      width: 760,
      height: 860,
      minWidth: 420,
      minHeight: 560,
      title: 'distill',
      backgroundColor: '#0B0B10',
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
  });

  it('declares no preload script', () => {
    expect(windowOptions().webPreferences).not.toHaveProperty('preload');
  });
});

describe('isAllowedExternal', () => {
  it('allows only https links', () => {
    expect(isAllowedExternal('https://www.libreoffice.org/download/')).toBe(true);
    expect(isAllowedExternal('http://evil.example')).toBe(false);
    expect(isAllowedExternal('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternal('javascript:alert(1)')).toBe(false);
  });

  it('rejects strings that are not URLs', () => {
    expect(isAllowedExternal('not a url')).toBe(false);
  });
});

describe('isSameOrigin', () => {
  it('compares scheme, host and port', () => {
    expect(isSameOrigin('http://127.0.0.1:5123/x', 'http://127.0.0.1:5123/')).toBe(true);
    expect(isSameOrigin('http://127.0.0.1:9999/', 'http://127.0.0.1:5123/')).toBe(false);
    expect(isSameOrigin('https://127.0.0.1:5123/', 'http://127.0.0.1:5123/')).toBe(false);
  });

  it('rejects strings that are not URLs', () => {
    expect(isSameOrigin('::bad::', 'http://127.0.0.1:5123/')).toBe(false);
  });
});

describe('tessdataDir', () => {
  const resources = '/app/Resources';
  const trained = '/app/Resources/tessdata/eng.traineddata';

  it('returns the bundled directory when packaged and the data exists', () => {
    expect(tessdataDir(true, resources, (path) => path === trained)).toBe('/app/Resources/tessdata');
  });

  it('is undefined in development', () => {
    expect(tessdataDir(false, resources, () => true)).toBeUndefined();
  });

  it('is undefined when packaged without the data', () => {
    expect(tessdataDir(true, resources, () => false)).toBeUndefined();
  });
});
