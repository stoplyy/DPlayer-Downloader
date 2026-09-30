// Copies browser-agnostic modules from extensions/shared into this browser's
// extension directory. Chrome/Edge MV3 `scripting.executeScript` cannot import
// ES modules, so each browser extension must ship a physical copy of the shared
// files. extensions/shared is the single source of truth; run this script after
// editing anything under extensions/shared.
//
// Usage: node extensions/edge/sync-shared.mjs [--check]

import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const sharedDirectory = join(extensionDirectory, '..', 'shared');
const checkOnly = process.argv.includes('--check');

const sharedFiles = readdirSync(sharedDirectory).filter((name) => name.endsWith('.mjs')).sort();
if (sharedFiles.length === 0) {
  console.error(`No shared modules found in ${sharedDirectory}`);
  process.exit(1);
}

mkdirSync(extensionDirectory, { recursive: true });

const stale = [];
for (const name of sharedFiles) {
  const source = join(sharedDirectory, name);
  const destination = join(extensionDirectory, name);
  const expected = readFileSync(source);

  let current = null;
  try {
    current = readFileSync(destination);
  } catch {
    current = null;
  }

  if (current && current.equals(expected)) continue;

  if (checkOnly) {
    stale.push(name);
    continue;
  }
  copyFileSync(source, destination);
  console.log(`synced ${name}`);
}

if (checkOnly && stale.length > 0) {
  console.error(`Out-of-date shared copies: ${stale.join(', ')}. Run: node extensions/edge/sync-shared.mjs`);
  process.exit(1);
}

console.log(checkOnly ? 'shared copies are up to date' : `shared modules synced (${sharedFiles.length} files)`);
