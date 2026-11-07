export interface HookCommandDeps {
  which: (bin: string) => string | null;
  version: string;
}

export function hookCommand(deps: HookCommandDeps): string {
  return deps.which('distillmd') !== null ? 'distillmd' : `npx -y distillmd@${deps.version}`;
}
