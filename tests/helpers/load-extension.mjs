// Loads zip.js / offscreen.js / background.js into one Node VM with just
// enough chrome.* surface to exercise the export pipeline end to end.
// No dependencies — run with `node --test`.

import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const sourcePath = (name) => fileURLToPath(new URL(name, ROOT));

export function loadExtension({ storageSeed = {} } = {}) {
  const messageListeners = [];
  const runtimeMessageCalls = [];
  const createdBlobs = [];

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      getManifest: () => ({ version: '1.1.0' }),
      getURL: (p) => 'chrome-extension://test/' + p,
      // Dispatch to the registered listeners; the first sendResponse wins.
      sendMessage: (msg) => {
        runtimeMessageCalls.push(msg);
        return new Promise((resolve) => {
          let settled = false;
          const sendResponse = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          for (const listener of messageListeners) {
            try { listener(msg, {}, sendResponse); } catch (e) { sendResponse({ ok: false, error: String(e) }); }
          }
        });
      }
    },
    storage: {
      local: {
        get: async () => storageSeed,
        set: async () => {}
      }
    },
    debugger: {
      onEvent: { addListener: () => {} },
      onDetach: { addListener: () => {} },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({})
    },
    tabs: {
      onRemoved: { addListener: () => {} },
      query: async () => [],
      get: async () => ({ id: 1, url: 'https://example.com/' }),
      update: async () => {},
      create: async () => {},
      reload: async () => {}
    },
    action: {
      setBadgeText: () => {},
      setBadgeBackgroundColor: () => {}
    },
    downloads: {
      calls: [],
      download(opts) {
        this.calls.push(opts);
        return Promise.resolve(this.calls.length);
      }
    },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    browsingData: { remove: async () => {} }
  };

  const context = vm.createContext({
    console,
    Date,
    Promise,
    atob,
    btoa,
    // Don't keep the test process alive for the 90s URL-revoke timer.
    setTimeout: (fn, ms) => { const t = setTimeout(fn, Math.min(ms, 5)); t.unref?.(); return t; },
    clearTimeout,
    chrome,
    Blob: class Blob {
      constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; }
    },
    URL: {
      createObjectURL: (blob) => { createdBlobs.push(blob); return `blob:test/${createdBlobs.length}`; },
      revokeObjectURL: () => {}
    }
  });

  // TextEncoder/TextDecoder are not intrinsic to bare vm contexts. Inject them,
  // but bridge through context-side wrappers so encode() yields a Uint8Array
  // from THIS realm — zip.js checks `f.data instanceof Uint8Array`.
  context.__ncpOuterEnc = new TextEncoder();
  context.__ncpOuterDec = new TextDecoder();
  vm.runInContext(`
    globalThis.TextEncoder = class {
      encode(s) {
        const a = __ncpOuterEnc.encode(s);
        const b = new Uint8Array(a.length);
        for (let i = 0; i < a.length; i++) b[i] = a[i];
        return b;
      }
    };
    globalThis.TextDecoder = class {
      decode(b) { return __ncpOuterDec.decode(b); }
    };
  `, context, { filename: 'realm-bridge.js' });

  for (const name of ['zip.js', 'offscreen.js', 'background.js']) {
    vm.runInContext(fs.readFileSync(sourcePath(name), 'utf8'), context, { filename: sourcePath(name) });
  }

  const state = vm.runInContext('state', context);
  const sendToBackground = (type, data = {}) => chrome.runtime.sendMessage({ target: 'background', type, ...data });

  return { context, state, chrome, createdBlobs, messageListeners, runtimeMessageCalls, sendToBackground };
}

// Parses a STORE-method ZIP produced by zip.js into name -> bytes.
export function readZip(bytes) {
  const buf = Uint8Array.from(bytes);
  const td = new TextDecoder();
  const entries = new Map();
  let p = 0;
  while (p + 30 <= buf.length && readU32(buf, p) === 0x04034b50) {
    const method = readU16(buf, p + 8);
    if (method !== 0) throw new Error(`unexpected ZIP compression method ${method}`);
    const size = readU32(buf, p + 18);
    const nameLen = readU16(buf, p + 26);
    const extraLen = readU16(buf, p + 28);
    const name = td.decode(buf.subarray(p + 30, p + 30 + nameLen));
    const dataStart = p + 30 + nameLen + extraLen;
    entries.set(name, buf.subarray(dataStart, dataStart + size));
    p = dataStart + size;
  }
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    get: (name) => entries.get(name),
    text: (name) => {
      const data = entries.get(name);
      return data === undefined ? undefined : td.decode(data);
    }
  };
}

function readU16(buf, p) {
  return buf[p] | (buf[p + 1] << 8);
}
function readU32(buf, p) {
  return (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0;
}
