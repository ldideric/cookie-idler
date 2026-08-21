// Re-proves that findChrome still lands on a working Chromium.
//
//   docker exec <container> node /app/checkchrome.mjs
//
// Playwright lays Chromium out per architecture, so a build for a new platform
// can pass and still have no browser to launch. Exits non-zero if the binary is
// missing or will not report a version.

import { execFileSync } from 'node:child_process';
import { findChrome } from './cdp.mjs';

const chrome = findChrome();
const version = execFileSync(chrome, ['--version'], { encoding: 'utf8' }).trim();
console.log(`${process.arch}  ${chrome}  ${version}`);
