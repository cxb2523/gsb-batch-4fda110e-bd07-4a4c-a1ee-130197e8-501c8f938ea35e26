/*
 * test/run-tests.js
 *
 * Local test script for the fragment decoder. Run with:
 *
 *     node test/run-tests.js
 *
 * It covers the four required scenarios (success, missing fragment, corrupt
 * payload, empty/bad key) using self-made fragments and key, and additionally
 * verifies that decodeInterfaceFragments() on the REAL index.html fragments
 * returns text identical to what the original page renders.
 *
 * Exits non-zero if any case fails so it can be used in CI / manual checks.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const D = require('../fragment-decoder.js');
const F = require('./fixtures.js');

let failures = 0;

function heading(line) {
  console.log('\n=== ' + line + ' ===');
}

// ---------------------------------------------------------------------------
// 1. The four required scenarios on self-made data.
// ---------------------------------------------------------------------------
heading('Self-made fragment scenarios');
const cases = F.executeCases(D);
for (const c of cases) {
  console.log((c.pass ? 'PASS' : 'FAIL') + '  ' + c.name);
  if (!c.pass) {
    failures++;
    console.log('       detail: ' + JSON.stringify(c.detail, null, 2));
  } else {
    // Emit the structured judgement for human verification.
    console.log('       ' + summarize(c.detail));
  }
}

function summarize(detail) {
  if (!detail) return '';
  if (detail.name) detail = detail.detail; // unwrap if needed
  return JSON.stringify(detail);
}

// ---------------------------------------------------------------------------
// 2. Parity check against the real landing page fragments and the original
//    render pipeline (re-implemented independently below, mirroring the old
//    inline script exactly).
// ---------------------------------------------------------------------------
heading('Parity with real index.html and original render pipeline');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const realFragments = [];
for (let i = 0; i < D.FRAGMENT_COUNT; i++) {
  const id = D.FRAGMENT_ID_PREFIX + i;
  const m = html.match(new RegExp('<template id="' + id + '">([\\s\\S]*?)</template>'));
  realFragments.push(m ? m[1] : '');
}

// Independent re-implementation of the ORIGINAL page logic, for comparison.
const key = D.decodeKey();
const joined = realFragments.join('');
const binary = atob(joined);
const xored = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
  xored[i] = binary.charCodeAt(i) ^ key.charCodeAt(i % key.length);
}
const originalRenderText = new TextDecoder('utf-8').decode(xored);

// New structured function on the same inputs (fragments passed as an array).
const structured = D.decodeInterfaceFragments(realFragments.slice(), key);

const parityPass =
  structured.success === true &&
  structured.text === originalRenderText &&
  structured.reasonCode === 'OK' &&
  F.arrEq(structured.processedFragments, [0, 1, 2, 3, 4]);

console.log((parityPass ? 'PASS' : 'FAIL') + '  real-fragment parity');
console.log('       original render length : ' + originalRenderText.length);
console.log('       structured text length  : ' + structured.text.length);
console.log('       starts with "<!DOCTYPE": ' +
  structured.text.trimStart().startsWith('<!DOCTYPE html>'));
console.log('       contains root "<html"   : ' +
  structured.text.indexOf(D.EXPECTED_ROOT_MARKER) !== -1);
if (!parityPass) {
  failures++;
  console.log('       detail: ' + JSON.stringify(structured).slice(0, 500));
}

// Also confirm the map/object input shape works on the real fragments.
const asMap = {};
realFragments.forEach((payload, i) => { asMap[D.FRAGMENT_ID_PREFIX + i] = payload; });
const mapResult = D.decodeInterfaceFragments(asMap, key);
const mapPass = mapResult.success && mapResult.text === originalRenderText;
console.log((mapPass ? 'PASS' : 'FAIL') + '  object/map fragment input shape');
if (!mapPass) failures++;

// And the {id, content} array shape.
const objArray = realFragments.map((payload, i) => ({
  id: D.FRAGMENT_ID_PREFIX + i,
  content: payload
}));
const objResult = D.decodeInterfaceFragments(objArray, key);
const objPass = objResult.success && objResult.text === originalRenderText;
console.log((objPass ? 'PASS' : 'FAIL') + '  {id,content} array input shape');
if (!objPass) failures++;

// ---------------------------------------------------------------------------
heading(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
