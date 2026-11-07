export function applyShell(root: HTMLElement, search: string): void {
  const params = new URLSearchParams(search);
  if (params.get('shell') !== 'desktop') return;
  root.dataset.shell = 'desktop';
  const platform = params.get('platform');
  if (platform) root.dataset.platform = platform;
}

export function isDesktopShell(): boolean {
  return document.documentElement.dataset.shell === 'desktop';
}
