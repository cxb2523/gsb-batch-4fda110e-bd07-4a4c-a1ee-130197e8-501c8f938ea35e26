import test from 'node:test';
import assert from 'node:assert/strict';

import { loadExtension, readZip } from './helpers/load-extension.mjs';

// One failed request, one whose body fetch failed, one healthy JSON response.
function sampleEntries() {
  return [
    {
      id: 'req-1',
      capturedAt: 1_700_000_000_000,
      requestTime: 1000,
      method: 'GET',
      url: 'https://a.example.com/broken',
      hostname: 'a.example.com',
      pathname: '/broken',
      resourceType: 'XHR',
      failed: true,
      errorText: 'net::ERR_CONNECTION_REFUSED'
    },
    {
      id: 'req-2',
      capturedAt: 1_700_000_001_000,
      requestTime: 1001,
      method: 'POST',
      url: 'https://b.example.com/upload',
      hostname: 'b.example.com',
      pathname: '/upload',
      resourceType: 'XHR',
      responseStatus: 200,
      responseMimeType: 'application/octet-stream',
      responseBodyError: 'No resource with given identifier found',
      encodedDataLength: 12
    },
    {
      id: 'req-3',
      capturedAt: 1_700_000_002_000,
      requestTime: 1002,
      method: 'GET',
      url: 'https://c.example.com/api/me',
      hostname: 'c.example.com',
      pathname: '/api/me',
      resourceType: 'Fetch',
      responseStatus: 200,
      responseMimeType: 'application/json',
      responseBody: '{"id":42,"name":"Ada"}',
      responseBodySize: 22,
      encodedDataLength: 40
    }
  ];
}

const meta = {
  startTime: 1_700_000_000_000,
  endTime: 1_700_000_010_000,
  tabUrl: 'https://example.com/',
  count: 3,
  bytes: 52,
  pauseWindows: [{ from: 1_700_000_003_000, to: 1_700_000_007_000 }]
};

async function buildZip(extension, entries) {
  const reply = await extension.chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'BUILD_AND_DOWNLOAD',
    format: 'zip',
    ts: '2026-11-13T00-00-00-000Z',
    entries,
    meta
  });
  assert.equal(reply.ok, true, `offscreen build failed: ${reply && reply.error}`);
  assert.match(reply.filename, /^network_capture_.*\.zip$/);
  const blob = extension.createdBlobs[extension.createdBlobs.length - 1];
  return readZip(blob.parts[0]);
}

test('ZIP manifest lists counts, missing bodies and per-request status', async () => {
  const extension = loadExtension();
  const zip = await buildZip(extension, sampleEntries());

  assert.ok(zip.has('summary.json'), 'summary.json must still be present');
  assert.ok(zip.has('manifest.json'), 'manifest.json must be in the archive');

  const manifest = JSON.parse(zip.text('manifest.json'));

  assert.equal(manifest.totalRequests, 3);
  assert.equal(manifest.failedCount, 1);
  assert.equal(manifest.succeededCount, 2);
  assert.ok(manifest.generatedAt, 'manifest must record a generation time');
  assert.ok(!Number.isNaN(Date.parse(manifest.generatedAt)));

  // Request 1 failed outright and request 2 never yielded a body.
  assert.deepEqual(manifest.missingResponseBody, ['00001', '00002']);
  assert.equal(manifest.bodyMissingCount, 2);

  // Capture context travels with the manifest.
  assert.equal(manifest.capture.tabUrl, 'https://example.com/');
  assert.equal(manifest.capture.startedAt, new Date(meta.startTime).toISOString());
  assert.equal(manifest.capture.pausedMs, 4000);
  assert.deepEqual(manifest.capture.pauseWindows, [{
    from: new Date(1_700_000_003_000).toISOString(),
    to: new Date(1_700_000_007_000).toISOString(),
    ms: 4000
  }]);

  assert.equal(manifest.requests.length, 3);
  const [r1, r2, r3] = manifest.requests;
  assert.equal(r1.index, 1);
  assert.equal(r1.fileIndex, '00001');
  assert.equal(r1.method, 'GET');
  assert.equal(r1.url, 'https://a.example.com/broken');
  assert.equal(r1.status, null);
  assert.equal(r1.failed, true);
  assert.equal(r1.error, 'net::ERR_CONNECTION_REFUSED');
  assert.equal(r1.hasResponseBody, false);

  assert.equal(r2.index, 2);
  assert.equal(r2.fileIndex, '00002');
  assert.equal(r2.status, 200);
  assert.equal(r2.failed, false);
  assert.equal(r2.bodyError, 'No resource with given identifier found');
  assert.equal(r2.hasResponseBody, false);

  assert.equal(r3.index, 3);
  assert.equal(r3.fileIndex, '00003');
  assert.equal(r3.status, 200);
  assert.equal(r3.hasResponseBody, true);
  assert.equal(r3.bodyFile, 'bodies/00003_c.example.com.json');

  // Cross-check the counts against the actual archive contents.
  assert.equal(zip.names.filter((n) => n.startsWith('requests/')).length, 3);
  assert.equal(zip.names.filter((n) => n.startsWith('bodies/')).length, 1);
});

test('manifest indices match the five-digit requests/ and bodies/ file names', async () => {
  const extension = loadExtension();
  const entries = sampleEntries();
  const zip = await buildZip(extension, entries);
  const manifest = JSON.parse(zip.text('manifest.json'));

  const requestFiles = zip.names.filter((n) => n.startsWith('requests/') && n.endsWith('.json'));
  const bodyFiles = zip.names.filter((n) => n.startsWith('bodies/'));
  assert.equal(requestFiles.length, entries.length);

  for (const row of manifest.requests) {
    const prefix = String(row.index).padStart(5, '0');
    assert.equal(row.fileIndex, prefix);
    assert.ok(
      requestFiles.includes(row.detailFile),
      `manifest detailFile ${row.detailFile} is missing from the archive`
    );
    assert.equal(row.detailFile.split('/')[1].slice(0, 5), prefix);
    if (row.hasResponseBody) {
      assert.ok(bodyFiles.includes(row.bodyFile), `manifest bodyFile ${row.bodyFile} is missing`);
      assert.equal(row.bodyFile.split('/')[1].slice(0, 5), prefix);
    } else {
      assert.equal(row.bodyFile, null);
      assert.ok(!bodyFiles.some((n) => n.split('/')[1].slice(0, 5) === prefix));
    }
  }

  // Every body file is accounted for in the manifest, and vice versa.
  const manifestBodies = manifest.requests.map((r) => r.bodyFile).filter(Boolean).sort();
  assert.deepEqual(manifestBodies, bodyFiles.slice().sort());

  // Every request file is accounted for in the manifest, in order.
  const manifestFiles = manifest.requests.map((r) => r.detailFile).slice().sort();
  assert.deepEqual(manifestFiles, requestFiles.slice().sort());
});

test('index.html links use the same numbering as manifest.json', async () => {
  const extension = loadExtension();
  const zip = await buildZip(extension, sampleEntries());
  const manifest = JSON.parse(zip.text('manifest.json'));
  const html = zip.text('index.html');
  for (const row of manifest.requests) {
    assert.ok(html.includes(row.detailFile), `index.html should link ${row.detailFile}`);
  }
});

test('manifest bodyFile matches the file actually written (base64 fallback)', async () => {
  const extension = loadExtension();
  const entries = [{
    id: 'req-b64',
    method: 'GET',
    url: 'https://cdn.example.com/img.png',
    hostname: 'cdn.example.com',
    responseStatus: 200,
    responseMimeType: 'image/png',
    responseBody: '!!!not-decodable!!!',
    responseBase64Encoded: true
  }];
  const zip = await buildZip(extension, entries);
  const manifest = JSON.parse(zip.text('manifest.json'));
  const bodyNames = zip.names.filter((n) => n.startsWith('bodies/'));

  assert.equal(bodyNames.length, 1);
  assert.equal(manifest.requests[0].hasResponseBody, true);
  assert.equal(manifest.requests[0].bodyFile, bodyNames[0]);
  assert.deepEqual(manifest.missingResponseBody, []);
});

test('a retrieved empty body counts as present, an unretrieved body does not', async () => {
  const extension = loadExtension();
  const entries = [
    { method: 'GET', url: 'https://e.example.com/204', hostname: 'e.example.com', responseStatus: 204, responseBody: '' },
    { method: 'GET', url: 'https://e.example.com/lost', hostname: 'e.example.com', responseStatus: 200, responseBodyError: 'gone' }
  ];
  const zip = await buildZip(extension, entries);
  const manifest = JSON.parse(zip.text('manifest.json'));
  assert.equal(manifest.requests[0].hasResponseBody, true);
  assert.equal(manifest.requests[1].hasResponseBody, false);
  assert.deepEqual(manifest.missingResponseBody, ['00002']);
});

test('paused export excludes requests recorded after resume', async () => {
  const extension = loadExtension();
  const [failed, noBody, healthy] = sampleEntries();

  // Record two requests, then pause through the real message router.
  extension.state.capturing = true;
  extension.state.startTime = meta.startTime;
  extension.state.tabUrl = meta.tabUrl;
  extension.state.requests.set(failed.id, failed);
  extension.state.requests.set(noBody.id, noBody);
  assert.equal((await extension.sendToBackground('PAUSE')).ok, true);
  assert.equal(extension.state.paused, true);

  const firstReply = await extension.sendToBackground('DOWNLOAD', { format: 'zip' });
  assert.equal(firstReply.ok, true);
  const firstZip = readZip(extension.createdBlobs[0].parts[0]);
  const firstManifest = JSON.parse(firstZip.text('manifest.json'));
  assert.equal(firstManifest.totalRequests, 2);
  assert.equal(firstManifest.failedCount, 1);
  assert.deepEqual(firstManifest.missingResponseBody, ['00001', '00002']);
  assert.equal(firstZip.names.filter((n) => n.startsWith('requests/')).length, 2);

  // The manifest documents that the export was taken mid-pause.
  assert.equal(firstManifest.capture.pauseWindows.length, 1);
  assert.ok(firstManifest.capture.pauseWindows[0].from);
  assert.ok(firstManifest.capture.pauseWindows[0].to);
  assert.ok(firstManifest.capture.pausedMs >= 0);

  // Resume, record a new request, export again.
  assert.equal((await extension.sendToBackground('RESUME')).ok, true);
  assert.equal(extension.state.paused, false);
  extension.state.requests.set(healthy.id, healthy);
  const secondReply = await extension.sendToBackground('DOWNLOAD', { format: 'zip' });
  assert.equal(secondReply.ok, true);
  const secondZip = readZip(extension.createdBlobs[1].parts[0]);
  const secondManifest = JSON.parse(secondZip.text('manifest.json'));
  assert.equal(secondManifest.totalRequests, 3);
  assert.deepEqual(secondManifest.missingResponseBody, ['00001', '00002']);
  // The pause window is closed by the resume and carried in the later archive.
  assert.equal(secondManifest.capture.pauseWindows.length, 1);
  assert.ok(secondManifest.capture.pauseWindows[0].to);

  // The earlier archive was already frozen — it cannot grow.
  assert.equal(firstManifest.totalRequests, 2);
  assert.equal(firstManifest.requests.some((r) => r.url === healthy.url), false);
});

test('DOWNLOAD with an empty capture is rejected with a readable error', async () => {
  const extension = loadExtension();
  const reply = await extension.sendToBackground('DOWNLOAD', { format: 'zip' });

  assert.equal(reply.ok, false);
  assert.equal(typeof reply.error, 'string');
  assert.match(reply.error, /no requests/i);
  assert.equal(reply.filename, undefined);

  // No build request was sent to the offscreen document and no download started.
  assert.ok(!extension.runtimeMessageCalls.some((m) => m.type === 'BUILD_AND_DOWNLOAD'));
  assert.equal(extension.chrome.downloads.calls.length, 0);
  assert.equal(extension.createdBlobs.length, 0);
});

test('offscreen build refuses an empty entry list', async () => {
  const extension = loadExtension();
  const reply = await extension.chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'BUILD_AND_DOWNLOAD',
    format: 'zip',
    ts: '2026-11-13T00-00-00-000Z',
    entries: [],
    meta
  });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /nothing to download/i);
  assert.equal(extension.createdBlobs.length, 0);
});

test('DOWNLOAD succeeds and keeps the {ok, filename} contract when entries exist', async () => {
  const extension = loadExtension();
  extension.state.requests.set('req-1', sampleEntries()[0]);
  extension.state.startTime = meta.startTime;
  extension.state.endTime = meta.endTime;
  extension.state.tabUrl = meta.tabUrl;

  const reply = await extension.sendToBackground('DOWNLOAD', { format: 'zip' });
  assert.equal(reply.ok, true);
  assert.match(reply.filename, /\.zip$/);
  assert.equal(extension.chrome.downloads.calls.length, 1);
});
