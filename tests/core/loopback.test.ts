import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from '@core/loopback';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', 'evil.example', '192.168.1.5', '', '127.0.0.1.evil.example', '[::2]'])('rejects %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
