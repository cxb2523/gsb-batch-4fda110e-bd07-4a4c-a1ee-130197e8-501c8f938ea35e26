# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `manifest.json` in the ZIP archive (alongside `summary.json`): generation time,
  capture start/end/tab, request totals, success/failure counts, the number and list
  of requests missing a response body, and per-request index / method / URL /
  status-or-error / body availability. Indices use the same five-digit prefix as the
  `requests/` and `bodies/` file names.
- The manifest records capture start/end/tab URL plus every pause window, so it is
  visible where CDP events were ignored and requests may be absent.
- Dependency-free test suite (`node --test`) covering the ZIP manifest, file-name
  alignment, pause/resume export isolation, and the empty-capture rejection.

### Fixed
- `DOWNLOAD` on an empty capture now returns `{ ok: false, error }` with a readable
  message instead of building an empty ZIP or surfacing an unhandled exception.
- Export now takes a snapshot of the request set, so requests recorded after an
  export (e.g. following a resume) never leak into an earlier archive.

## [1.1.0]

The current release. Core feature set:

### Added
- Full request/response capture via the Chrome DevTools Protocol (`chrome.debugger`),
  including request/response headers, cookies, query params, POST bodies
  (raw + parsed JSON/form), and response bodies (text and base64 binary).
- WebSocket frame capture.
- One-click export to **ZIP**, **JSON**, **HAR 1.2**, and **CSV**.
- ZIP archive with per-request JSON files, raw response bodies, post-data,
  parsed request/response cookies, a CSV + HAR, and a clickable `index.html`.
- Three UIs: toolbar popup, full-page panel, and an embedded DevTools tab.
- Live capture controls: Start, Pause, Resume, Stop, Clear — with request
  counter, byte counter, elapsed timer, and a recording badge.
- Smart filters by URL, method, status, MIME, and resource type.
- Per-origin **Clear cookies** and **Clear cache** tools via `chrome.browsingData`.
- Tab tools: open/focus the captured tab, reload, and hard reload.
- Capture persistence across service-worker restarts via `chrome.storage.local`.

> Version history before 1.1.0 was not tracked in a changelog.

[Unreleased]: https://github.com/Mahdi-hasan-shuvo/network-capture-pro-chrome-extension/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Mahdi-hasan-shuvo/network-capture-pro-chrome-extension/releases/tag/v1.1.0
