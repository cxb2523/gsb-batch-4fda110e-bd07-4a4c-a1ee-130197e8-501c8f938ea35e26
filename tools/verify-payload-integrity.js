// Asserts the 11 template payloads in the working-tree index.html are
// byte-for-byte identical to the committed snapshot; only the decoder tail
// was allowed to change. Run: node tools/verify-payload-integrity.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const current = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const original = execFileSync('git', ['show', 'HEAD:index.html'], {
  cwd: root, encoding: 'utf8'
});

let identical = 0;
for (let i = 0; i < 11; i++) {
  const re = new RegExp('<template id="lndoxffylyyj' + i + '">([\\s\\S]*?)</template>');
  const a = re.exec(original);
  const b = re.exec(current);
  if (!a || !b) throw new Error('template ' + i + ' missing in one of the versions');
  if (a[1] === b[1]) identical++;
  else throw new Error('template ' + i + ' payload changed');
}
console.log(identical + '/11 template payloads byte-identical to HEAD');
