import { createRuntimeInstaller, RuntimeInstallFailure } from './runtime-install';
import type { RuntimeInstaller, RuntimeInstallerOptions } from './runtime-install';

export { findNpm, NPM_ARGS } from './runtime-install';
export type { FileOps, FindNpmProbe, InstallerStatus, NpmCommand, SpawnFn } from './runtime-install';

export const REQUIRED_PACKAGES: readonly string[] = ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken'];

export const INTEL_MAC_REASON = 'LLMLingua-2 is not available on Intel Macs: its ONNX runtime only supports Apple Silicon.';

export const LinguaInstallFailure = RuntimeInstallFailure;
export type LinguaInstallFailure = RuntimeInstallFailure;
export type LinguaInstaller = RuntimeInstaller;

export interface InstallerOptions extends Omit<RuntimeInstallerOptions, 'installDir' | 'packages' | 'label' | 'unsupportedReason'> {
  platform?: NodeJS.Platform;
  arch?: string;
}

export function createLinguaInstaller(opts: InstallerOptions): LinguaInstaller {
  const { platform, arch, ...rest } = opts;
  const intelMac = (platform ?? process.platform) === 'darwin' && (arch ?? process.arch) === 'x64';
  return createRuntimeInstaller({
    ...rest,
    installDir: 'lingua',
    packages: REQUIRED_PACKAGES,
    label: 'LLMLingua-2',
    ...(intelMac ? { unsupportedReason: INTEL_MAC_REASON } : {}),
  });
}
