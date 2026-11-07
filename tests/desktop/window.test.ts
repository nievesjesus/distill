import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopUrl, isAllowedExternal, isPermissionAllowed, isSameOrigin, tessdataDir, windowOptions } from '../../desktop/window';

describe('windowOptions', () => {
  it('uses the hardened distill window defaults', () => {
    expect(windowOptions('linux')).toMatchObject({
      width: 640,
      height: 780,
      minWidth: 440,
      minHeight: 520,
      title: 'distill',
      backgroundColor: '#0B0B10',
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
  });

  it('declares no preload script unless one is given', () => {
    expect(windowOptions('darwin').webPreferences).not.toHaveProperty('preload');
  });

  it('loads the given preload without weakening isolation', () => {
    expect(windowOptions('darwin', '/app/preload.cjs').webPreferences).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      preload: '/app/preload.cjs',
    });
  });

  it('integrates the title bar with inset traffic lights on macOS', () => {
    const options = windowOptions('darwin');
    expect(options.titleBarStyle).toBe('hiddenInset');
    expect(options.trafficLightPosition).toEqual({ x: 16, y: 14 });
    expect(options).not.toHaveProperty('titleBarOverlay');
  });

  it('draws the window controls overlay on Windows', () => {
    expect(windowOptions('win32')).toMatchObject({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#0B0B10', symbolColor: '#A0A0AE', height: 40 },
    });
  });

  it('keeps the native frame on Linux', () => {
    const options = windowOptions('linux');
    expect(options).not.toHaveProperty('titleBarStyle');
    expect(options).not.toHaveProperty('titleBarOverlay');
  });
});

describe('desktopUrl', () => {
  it('adds the shell and platform query and stays same-origin', () => {
    const url = desktopUrl('http://127.0.0.1:5123/', 'darwin');
    expect(url).toBe('http://127.0.0.1:5123/?shell=desktop&platform=darwin');
    expect(isSameOrigin(url, 'http://127.0.0.1:5123/')).toBe(true);
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
  const resources = join('/app', 'Resources');
  const trained = join(resources, 'tessdata', 'eng.traineddata');

  it('returns the bundled directory when packaged and the data exists', () => {
    expect(tessdataDir(true, resources, (path) => path === trained)).toBe(join(resources, 'tessdata'));
  });

  it('is undefined in development', () => {
    expect(tessdataDir(false, resources, () => true)).toBeUndefined();
  });

  it('is undefined when packaged without the data', () => {
    expect(tessdataDir(true, resources, () => false)).toBeUndefined();
  });
});

describe('isPermissionAllowed', () => {
  it('allows only sanitized clipboard writes', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true);
  });

  it.each(['media', 'geolocation', 'notifications', 'clipboard-read', 'openExternal', 'fullscreen', 'midi'])(
    'denies %s',
    (permission) => {
      expect(isPermissionAllowed(permission)).toBe(false);
    },
  );
});
