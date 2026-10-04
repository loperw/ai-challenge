// Runs the Python pipeline with either a normal Python installation or Codex runtime.
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const bundled = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
const python = process.env.INDEX_PYTHON || (existsSync(bundled) ? bundled : 'python');
const result = spawnSync(python, [path.join(__dirname, '..', 'indexing', 'pipeline.py'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) console.error(`Cannot start Python: ${result.error.message}. Set INDEX_PYTHON.`);
process.exit(result.status ?? 1);
