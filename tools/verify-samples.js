// Verifies every generated sample page against its embedded expectation by
// extracting the template pieces from the actual HTML file and running the
// same pure decode stage the browser runs. Run: node tools/verify-samples.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const Lnd = require(path.join(root, 'js', 'lnd-decoder.js'));
const samplesDir = path.join(root, 'samples');

const FILES = [
  '01-missing-piece.html',
  '02-bad-base64.html',
  '03-empty-key.html',
  '04-invalid-utf8.html',
  '05-full-success.html'
];

let failures = 0;
for (const file of FILES) {
  const html = fs.readFileSync(path.join(samplesDir, file), 'utf8');
  const pieces = [];
  for (let i = 0; i < Lnd.PIECE_COUNT; i++) {
    const m = new RegExp('<template id="' + Lnd.PIECE_PREFIX + i + '">([\\s\\S]*?)</template>').exec(html);
    pieces.push(m ? m[1] : null);
  }
  const cfgMatch = /window\.LND_DECODER_CONFIG\s*=\s*(\{[^}]*\})/.exec(html);
  const config = cfgMatch ? JSON.parse(cfgMatch[1]) : {};
  const keyBase64 = Object.prototype.hasOwnProperty.call(config, 'keyBase64')
    ? config.keyBase64 : Lnd.DEFAULT_KEY_B64;
  const expectedMatch = /var expected = (\{[\s\S]*?\});\n/.exec(html);
  const expected = JSON.parse(expectedMatch[1]);

  const result = Lnd.decode({ pieces, keyBase64 });
  const status = result.status || (function () {
    const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(result.html)[1];
    const scripts = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    return {
      success: true,
      failureCategory: null,
      pieces: [],
      restoredHtmlLength: result.html.length,
      inlineScriptCount: scripts.filter((m) => !/src\s*=/.test(m[1]) && m[2].trim()).length,
      externalScriptCount: scripts.filter((m) => /src\s*=/.test(m[1])).length,
      reason: null
    };
  })();

  const ok = Object.keys(expected).every((k) =>
    JSON.stringify(status[k]) === JSON.stringify(expected[k]));
  if (!ok) failures++;
  console.log((ok ? 'PASS ' : 'FAIL ') + file);
  if (!ok) {
    console.log('  expected:', JSON.stringify(expected));
    console.log('  actual:  ', JSON.stringify(status));
  } else {
    console.log('  ->', status.success ? 'success, html=' + status.restoredHtmlLength +
      ' inline=' + status.inlineScriptCount + ' external=' + status.externalScriptCount
      : status.failureCategory + ' pieces=[' + status.pieces.join(',') + '] :: ' + status.reason);
  }
}
console.log(failures ? '\n' + failures + ' sample(s) failed' : '\nall 5 samples match their expected status');
process.exitCode = failures ? 1 : 0;
