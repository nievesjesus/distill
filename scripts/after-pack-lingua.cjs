const { cpSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const BINDINGS = join('node_modules', 'onnxruntime-node', 'bin', 'napi-v6');

function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  }
  return join(context.appOutDir, 'resources');
}

module.exports = async function afterPack(context) {
  const source = join(context.packager.projectDir, 'build', 'lingua');
  const target = join(resourcesDir(context), 'lingua');
  cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  const bindings = join(target, BINDINGS);
  for (const platform of readdirSync(bindings)) {
    if (platform !== context.electronPlatformName) rmSync(join(bindings, platform), { recursive: true, force: true });
  }
};
