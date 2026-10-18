const path = require('node:path');
const fs = require('node:fs');
const { review } = require('../pr-review');
(async () => {
  const root = path.resolve(__dirname, '..');
  // Local runs may use the existing ignored configuration; CI injects secrets.
  if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
  const [base, head = 'HEAD', output = 'data/pr-review'] = process.argv.slice(2);
  if (!base) throw new Error('Usage: node scripts/review-pr.cjs BASE [HEAD] [OUTPUT]');
  const markdown = await review({ root, base, head, output: path.resolve(output) });
  console.log(markdown);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
