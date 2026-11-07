import { readFileSync, writeFileSync } from 'node:fs';

const variant = process.argv[2];
if (variant !== 'lite' && variant !== 'full') {
  console.error('usage: node scripts/make-signed-config.mjs <lite|full>');
  process.exit(1);
}

const source = `electron-builder.${variant}.yml`;
const target = `electron-builder.${variant}.signed.yml`;
const unsignedMac = '  identity: "-"\n  hardenedRuntime: false\n';
const signedMac = [
  '  hardenedRuntime: true',
  '  gatekeeperAssess: false',
  '  entitlements: build/entitlements.mac.plist',
  '  entitlementsInherit: build/entitlements.mac.plist',
  '  notarize: true',
  '',
].join('\n');

const text = readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
if (!text.includes(unsignedMac)) {
  console.error(`${source}: ad-hoc mac block not found`);
  process.exit(1);
}
let signedText = text.replace(unsignedMac, signedMac);
if (/^dmg:[ \t]*$/m.test(signedText)) {
  signedText = signedText.replace(/^dmg:[ \t]*\n(?:[ \t]+sign:.*\n)?/m, 'dmg:\n  sign: true\n');
} else {
  signedText = `${signedText.replace(/\n*$/, '\n')}dmg:\n  sign: true\n`;
}
writeFileSync(target, signedText);
console.log(`wrote ${target}`);
