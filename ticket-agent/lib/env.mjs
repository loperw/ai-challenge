import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const libDir = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(libDir, '..');
export const rootDir = path.resolve(appDir, '..');

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '');
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  }
}

// App-local settings override root settings; both files are excluded from Git.
readEnvFile(path.join(appDir, '.env'));
readEnvFile(path.join(rootDir, '.env'));
