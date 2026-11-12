/*
 * test/browser-path-check.js
 *
 * Simulates the browser environment just enough to run the REAL page
 * mechanics without a browser:
 *   - a minimal `document` whose getElementById returns the five <template>
 *     fragments parsed straight out of index.html
 *   - atob / TextDecoder (provided natively by Node)
 *   - document.open/write/close capturing what the page would render
 *
 * It then (1) loads fragment-decoder.js as the page would, (2) runs the same
 * auto-render sequence as index.html's inline script, and (3) asserts the
 * captured render equals the independently decoded reference text.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

// --- Parse the five template payloads out of the real page. ---------------
const templates = {};
for (let i = 0; i < 5; i++) {
  const id = '_7RXYYPTB' + i;
  const m = html.match(new RegExp('<template id="' + id + '">([\\s\\S]*?)</template>'));
  templates[id] = m ? m[1] : '';
}

let captured = '';
const documentStub = {
  getElementById(id) {
    return Object.prototype.hasOwnProperty.call(templates, id)
      ? { innerHTML: templates[id] }
      : null;
  },
  open() {},
  write(s) { captured += s; },
  close() {}
};

const sandbox = {
  document: documentStub,
  console,
  atob,
  Uint8Array,
  TextDecoder,
  TextEncoder
};
// In a real browser `window`, `self` and the global object are the same thing.
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// --- Load the decoder library exactly as <script src> would. ---------------
vm.runInContext(fs.readFileSync(path.join(repoRoot, 'fragment-decoder.js'), 'utf8'), sandbox);

const D = sandbox.window.InterfaceFragmentDecoder;
if (typeof sandbox.window.decodeInterfaceFragments !== 'function') {
  throw new Error('global decodeInterfaceFragments was not exposed');
}
console.log('PASS  global window.decodeInterfaceFragments is exposed');

// --- Run the same auto-render sequence used by index.html. -----------------
const autoRender = `
(function(){
  var mrkBzo = window.InterfaceFragmentDecoder.decodeKey();
  var EyCOzH = [];
  for (var i = 0; i < 5; i++) {
    var el = document.getElementById('_7RXYYPTB' + i);
    EyCOzH.push(el ? el.innerHTML : '');
  }
  var result = window.decodeInterfaceFragments(EyCOzH, mrkBzo);
  if (!result.success) { console.error(result.reason); return; }
  document.open();
  document.write(result.text);
  document.close();
})();
`;
vm.runInContext(autoRender, sandbox);

// --- Independent reference decode (original algorithm). --------------------
const key = D.decodeKey();
const binary = atob(Object.keys(templates).map((k) => templates[k]).join(''));
const ref = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
  ref[i] = binary.charCodeAt(i) ^ key.charCodeAt(i % key.length);
}
const referenceText = new TextDecoder('utf-8').decode(ref);

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''));
  if (!ok) failures++;
}

check('auto-render produced output', captured.length > 0, 'length=' + captured.length);
check('auto-render text equals reference decode', captured === referenceText);
check('rendered text has <html root marker', captured.indexOf('<html') !== -1);
check('rendered text starts with <!DOCTYPE html>', captured.trimStart().startsWith('<!DOCTYPE html>'));

// --- Direct global-function call on the same fragments. ---------------------
const direct = sandbox.window.decodeInterfaceFragments(
  Object.keys(templates).map((k) => templates[k]),
  key
);
check('direct global call succeeds', direct.success === true);
check('direct global call text matches render', direct.text === captured);
check('processedFragments are [0..4]',
  JSON.stringify(direct.processedFragments) === JSON.stringify([0, 1, 2, 3, 4]));

console.log('\n' + (failures === 0 ? 'BROWSER-PATH CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
process.exit(failures === 0 ? 0 : 1);
