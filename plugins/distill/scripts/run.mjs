import { launch } from './launch.mjs';

process.exitCode = await launch(process.argv.slice(2), { stdio: 'inherit' });
