// One-off migration: replace the inline, unauditable self-decoding tail of
// index.html with a reference to the observable external decoder. The 11
// template pieces are left byte-for-byte untouched.
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '..', 'index.html');
let html = fs.readFileSync(file, 'utf8');

const start = html.indexOf('<div id="_xI5RNUz"');
const end = html.lastIndexOf('</script>') + '</script>'.length;
if (start === -1 || end <= start) throw new Error('legacy segment not found');

const replacement =
  '<!-- observable decoder: publishes window.LND_DECODE_STATUS; see js/lnd-decoder.js -->\n' +
  '<script src="js/lnd-decoder.js"></script>';

html = html.slice(0, start) + replacement + html.slice(end);
fs.writeFileSync(file, html, 'utf8');
console.log('index.html migrated, new length:', html.length);
