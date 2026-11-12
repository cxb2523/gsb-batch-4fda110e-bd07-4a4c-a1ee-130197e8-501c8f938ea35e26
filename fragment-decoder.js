/*
 * fragment-decoder.js
 *
 * Shared decoding core for the sales-dashboard landing page.
 *
 * The real interface is stored on the landing page as five <template>
 * fragments (id "_7RXYYPTB0" .. "_7RXYYPTB4"). At load time the page takes
 * each fragment by number, joins them in ascending numeric order, Base64
 * decodes the joined payload, XORs it with a fixed key and writes the
 * resulting UTF-8 text into the document.
 *
 * This module exposes that pipeline as a single structured function so a
 * collector can detect *why* a fetch failed instead of just receiving
 * garbled or blank output. It is written as a UMD-style module:
 *   - in the browser it attaches a global `window.decodeInterfaceFragments`
 *   - in Node it can be require()d by the local test script
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.InterfaceFragmentDecoder = api;
    // Primary public entry point requested for the page script.
    root.decodeInterfaceFragments = api.decodeInterfaceFragments;
  }
})(typeof self !== 'undefined' ? self
   : typeof globalThis !== 'undefined' ? globalThis
   : typeof global !== 'undefined' ? global
   : this, function () {
  'use strict';

  // Number of fragments the interface was split into (_7RXYYPTB0 .. _7RXYYPTB4).
  var FRAGMENT_COUNT = 5;
  // Common id prefix; the fragment number is the trailing digit.
  var FRAGMENT_ID_PREFIX = '_7RXYYPTB';
  // The fixed key is itself Base64 encoded in the original page. Decoded it is
  // exactly 16 bytes. A key that is empty or any other length is rejected.
  var KEY_B64 = '9Tk/XtxwXIJnDtW1sNN+VA==';
  var EXPECTED_KEY_LENGTH = 16;
  // Every successfully rendered interface is a full HTML document rooted at
  // an <html> element. Presence of this marker is the payload sanity check.
  var EXPECTED_ROOT_MARKER = '<html';

  // Machine-readable failure codes, plus a human-readable default message.
  var REASON = {
    OK: 'OK',
    MISSING_FRAGMENTS: 'MISSING_FRAGMENTS',
    INVALID_KEY: 'INVALID_KEY',
    PAYLOAD_CORRUPT: 'PAYLOAD_CORRUPT'
  };

  function reasonText(code, detail) {
    switch (code) {
      case REASON.MISSING_FRAGMENTS:
        return 'Missing template fragment(s): #' + detail.missing.join(', #');
      case REASON.INVALID_KEY:
        return detail.message || 'Invalid decryption key';
      case REASON.PAYLOAD_CORRUPT:
        return detail.message || 'Decoded payload is corrupt';
      default:
        return '';
    }
  }

  function fail(code, detail, processed) {
    var d = detail || {};
    return {
      success: false,
      text: '',
      reasonCode: code,
      reason: reasonText(code, d),
      missingFragments: d.missing || [],
      processedFragments: processed ? processed.slice() : []
    };
  }

  // Base64 -> binary string. Works in browser (atob) and Node (Buffer).
  function base64ToBinary(b64) {
    if (typeof atob === 'function') {
      return atob(b64);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(b64, 'base64').toString('binary');
    }
    throw new Error('No Base64 decoder available in this environment');
  }

  // The key may be supplied either as a raw byte string (the form used after
  // atob() on the page) or as the Base64 form shipped in the original script.
  function normalizeKey(keyInput) {
    if (keyInput == null) return '';
    if (typeof keyInput === 'string') return keyInput;
    // Uint8Array / array of byte values.
    if (typeof keyInput.length === 'number') {
      var s = '';
      for (var i = 0; i < keyInput.length; i++) s += String.fromCharCode(keyInput[i] & 0xff);
      return s;
    }
    return '';
  }

  // Pull the trailing fragment number off an id. Returns null when the id is
  // not one of ours or does not end in a valid index.
  function fragmentNumber(id) {
    if (typeof id !== 'string' || id.indexOf(FRAGMENT_ID_PREFIX) !== 0) return null;
    var tail = id.slice(FRAGMENT_ID_PREFIX.length);
    if (!/^\d+$/.test(tail)) return null;
    var n = parseInt(tail, 10);
    return n >= 0 && n < FRAGMENT_COUNT ? n : null;
  }

  // Accept the fragment set in whatever shape a collector naturally has:
  //   { _7RXYYPTB0: '...', ... }          id/number -> payload map
  //   [{ id: '_7RXYYPTB0', content: '..'}] array of objects
  //   ['part0', 'part1', ...]              array indexed by number
  function collectFragments(fragments) {
    var map = {};
    if (!fragments) return map;

    if (Array.isArray(fragments)) {
      for (var i = 0; i < fragments.length; i++) {
        var item = fragments[i];
        if (item == null) continue;
        if (typeof item === 'string') {
          if (i < FRAGMENT_COUNT) map[i] = item;
        } else if (typeof item === 'object') {
          var num = fragmentNumber(item.id);
          var content = item.content != null ? item.content
                       : item.payload != null ? item.payload
                       : item.value;
          if (num !== null && typeof content === 'string') map[num] = content;
        }
      }
      return map;
    }

    if (typeof fragments === 'object') {
      var keys = Object.keys(fragments);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var numFromId = fragmentNumber(key);
        var num = numFromId !== null ? numFromId
                  : /^\d+$/.test(key) ? parseInt(key, 10) : null;
        if (num !== null && num >= 0 && num < FRAGMENT_COUNT &&
            typeof fragments[key] === 'string') {
          map[num] = fragments[key];
        }
      }
    }
    return map;
  }

  /*
   * Decode the interface from a fragment set and a key.
   *
   * @param {Object|Array} fragments  the five template payloads (see above)
   * @param {String|Uint8Array} key   fixed XOR key (raw byte string, byte
   *                                  array, or the original Base64 string)
   * @returns {Object} {
   *   success:            boolean,
   *   text:               string  (decoded interface when success, else ''),
   *   reasonCode:         one of REASON.*,
   *   reason:             human-readable failure description ('' on success),
   *   missingFragments:   number[] (indices that were absent),
   *   processedFragments: number[] (indices actually used, ascending)
   * }
   */
  function decodeInterfaceFragments(fragments, key) {
    // --- 1. Validate the key first (empty or wrong length => key error). ---
    var keyBytes = normalizeKey(key);
    if (keyBytes.length === 0) {
      return fail(REASON.INVALID_KEY, { message: 'Decryption key is empty' }, []);
    }
    if (keyBytes.length !== EXPECTED_KEY_LENGTH) {
      return fail(REASON.INVALID_KEY, {
        message: 'Decryption key length is ' + keyBytes.length +
                 ', expected ' + EXPECTED_KEY_LENGTH
      }, []);
    }

    // --- 2. Gather fragments and make sure every index is present. --------
    var map = collectFragments(fragments);
    var missing = [];
    var processed = [];
    for (var n = 0; n < FRAGMENT_COUNT; n++) {
      if (typeof map[n] !== 'string' || map[n].length === 0) {
        missing.push(n);
      } else {
        processed.push(n);
      }
    }
    if (missing.length > 0) {
      return fail(REASON.MISSING_FRAGMENTS, { missing: missing }, processed);
    }

    // --- 3. Join in ascending numeric order and Base64 decode. ------------
    var joined = '';
    for (var j = 0; j < FRAGMENT_COUNT; j++) joined += map[j];

    var binary;
    try {
      binary = base64ToBinary(joined);
    } catch (e) {
      return fail(REASON.PAYLOAD_CORRUPT, {
        message: 'Base64 decoding failed: ' + (e && e.message ? e.message : e)
      }, processed);
    }

    // --- 4. XOR each byte with the repeating fixed key. -------------------
    var bytes = new Uint8Array(binary.length);
    for (var p = 0; p < binary.length; p++) {
      bytes[p] = binary.charCodeAt(p) ^ keyBytes.charCodeAt(p % keyBytes.length);
    }

    // --- 5. Decode as strict UTF-8 (replacement chars / errors => corrupt).
    var text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e2) {
      return fail(REASON.PAYLOAD_CORRUPT, {
        message: 'Decrypted payload is not valid UTF-8'
      }, processed);
    }
    if (text.indexOf('�') !== -1) {
      return fail(REASON.PAYLOAD_CORRUPT, {
        message: 'Decrypted payload contains replacement characters'
      }, processed);
    }

    // --- 6. Verify the expected document root marker. ---------------------
    if (text.indexOf(EXPECTED_ROOT_MARKER) === -1) {
      return fail(REASON.PAYLOAD_CORRUPT, {
        message: 'Decrypted text is missing the expected root marker "' +
                 EXPECTED_ROOT_MARKER + '"'
      }, processed);
    }

    return {
      success: true,
      text: text,
      reasonCode: REASON.OK,
      reason: '',
      missingFragments: [],
      processedFragments: processed
    };
  }

  return {
    decodeInterfaceFragments: decodeInterfaceFragments,
    // Exposed so the page and the tests share one source of truth.
    FRAGMENT_COUNT: FRAGMENT_COUNT,
    FRAGMENT_ID_PREFIX: FRAGMENT_ID_PREFIX,
    EXPECTED_KEY_LENGTH: EXPECTED_KEY_LENGTH,
    EXPECTED_ROOT_MARKER: EXPECTED_ROOT_MARKER,
    KEY_B64: KEY_B64,
    REASON: REASON,
    // Helpers reused by the page's auto-render path and by tests.
    decodeKey: function () { return base64ToBinary(KEY_B64); },
    fragmentNumber: fragmentNumber,
    collectFragments: collectFragments
  };
});
