# 视频大小快速探测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在扫描结果中逐项展示 MP4/WebM 精确大小或 HLS 估算大小，不下载媒体、不发送 Cookie。

**Architecture:** 扫描先返回并渲染候选；Popup 为候选发出 `probeSize` Native Messaging 请求。Host 在现有公网校验 EgressProxy 后用 HEAD 或受限读取 HLS 播放列表，响应中区分精确、估算、不可估算和失败。探测使用专用短超时，不改变下载代理的默认超时。

**Tech Stack:** Python 3.12、Native Messaging、urllib、Edge Manifest V3、原生 Node.js test runner。

---

## 文件职责

- Create `host/probing.py`: 安全取数、HTTP/HLS 元数据解析、精确/估算/失败结果。
- Modify `host/proxy.py`: 允许 EgressProxy 单独配置上游连接超时，默认值维持下载行为。
- Modify `host/native_host.py`: 校验并处理 `probeSize` 请求。
- Modify `extension/service_worker.js`: 转发大小探测请求。
- Modify `extension/popup.js` and `extension/popup.css`: 候选行初始状态、大小格式化和逐项异步更新。
- Create `extension/probe_queue.mjs`: 限制 Popup 同时探测候选数为 3。
- Create `tests/test_probing.py`: 元数据解析和边界测试。
- Modify `tests/test_proxy.py` and `tests/test_protocol.py`: 专用超时与 Native Messaging 契约测试。
- Create `tests/test_size_display.mjs` and `tests/test_probe_queue.mjs`: UI 大小格式化与并发队列测试。
- Modify `tests/test_scanner.mjs` only if candidate metadata normalization needs coverage.

## Task 1: Probe Parsing Tests

**Files:** Create `tests/test_probing.py`.

- [ ] **Step 1: Write failing parser tests** for MP4 `Content-Length`, HLS master selection (`AVERAGE-BANDWIDTH`/`BANDWIDTH`), duration summation, missing metadata, malformed and oversized playlists.
- [ ] **Step 2: Run `python -m unittest discover -s tests -t . -p test_probing.py -v`** and confirm failure because `host.probing` is not implemented.
- [ ] **Step 3: Implement only pure parsers/result formatting in `host/probing.py`.** Keep raw URLs and response bodies out of returned error text.
- [ ] **Step 4: Rerun the focused test command and confirm all parser cases pass.**

## Task 2: Bounded HTTP Probe

**Files:** Modify `host/proxy.py`; modify `host/probing.py`; modify `tests/test_proxy.py`, `tests/test_probing.py`.

- [ ] **Step 1: Add a failing proxy test** that a probe-specific connect timeout can be set while the existing default remains unchanged.
- [ ] **Step 2: Run `python -m unittest discover -s tests -t . -p test_proxy.py -v`** and confirm the new configuration assertion fails.
- [ ] **Step 3: Add the optional timeout parameter to `EgressProxy` and its server; retain the current 10-second default and pass 3 seconds only from the probe path.**
- [ ] **Step 4: Rerun `python -m unittest discover -s tests -t . -p test_proxy.py -v`** and confirm the default and probe-specific timeout assertions pass.
- [ ] **Step 5: Add failing probe tests** for HEAD exact size, HLS bounded playlist reads, maximum three redirects, 3-second request timeout, 8-second candidate deadline, and a request with no Cookie/Referer/Authorization headers. Inject the opener/clock only at the network boundary; use local fixtures/mocks, never real media URLs.
- [ ] **Step 6: Implement the HTTP(S) probe** using the existing EgressProxy, with a 256 KiB playlist cap, no media-segment requests, explicit redirect handler, HTTP(S)-only redirects, and monotonic total deadline. Do not change shared proxy header filtering because authorized downloads must continue forwarding their explicit Cookie header.
- [ ] **Step 7: Run `python -m unittest discover -s tests -t . -p test_probing.py -v` and `python -m unittest discover -s tests -t . -p test_proxy.py -v`.**

## Task 3: Native Messaging Contract

**Files:** Modify `host/native_host.py`; modify `tests/test_protocol.py`.

- [ ] **Step 1: Add failing tests** that `probeSize` accepts only `id`, `type`, and a valid credential-free HTTP(S) URL no longer than 8192 characters, and rejects unknown fields, credentials, invalid schemes, and oversized URLs.
- [ ] **Step 2: Run `python -m unittest discover -s tests -t . -p test_protocol.py -v`** and confirm the message is rejected as unsupported.
- [ ] **Step 3: Add the message validation and dispatch.** Return `replyTo`, a result status (`exact`, `estimated`, `unavailable`, or `failed`), and `sizeBytes` only for exact/estimated results.
- [ ] **Step 4: Dispatch probe requests through a three-worker executor** so the Native Messaging read loop remains responsive; correlate out-of-order responses by `replyTo` and wait for workers during shutdown.
- [ ] **Step 5: Add tests** for the service-level probe response with a deterministic local stub, two overlapping probe requests completing out of order, and failure isolation. Verify results never include the input URL.
- [ ] **Step 6: Rerun the protocol and probe tests.**

## Task 4: Candidate UI

**Files:** Modify `extension/service_worker.js`, `extension/popup.js`, `extension/popup.css`; create `tests/test_size_display.mjs`.

- [ ] **Step 1: Write failing formatting tests** for exact MB/GB values, approximate HLS labels, unavailable and failed states.
- [ ] **Step 2: Run `node --test tests/test_size_display.mjs`** and confirm the formatter module is missing.
- [ ] **Step 3: Implement and verify the pure size formatter** in `extension/size_display.mjs` using `tests/test_size_display.mjs`.
- [ ] **Step 4: Write failing tests in `tests/test_probe_queue.mjs`** proving at most three probes run at once and one rejected probe does not stop remaining results; run `node --test tests/test_probe_queue.mjs` and confirm the queue module is missing.
- [ ] **Step 5: Create `extension/probe_queue.mjs`** implementing the tested three-worker queue, then rerun its focused Node test.
- [ ] **Step 6: Route `probeSize` through `nativeRequest` in the worker and add a size line to each candidate.** Render candidates immediately with “正在探测大小…”, then update each row independently; per-candidate errors must not cancel the scan or other probes.
- [ ] **Step 7: Run the focused Node tests and `node --check extensions/edge/service_worker.js` plus `node --check extensions/edge/popup.js`.**

## Task 5: Full Validation and Deployment

**Files:** No additional source files expected.

- [ ] **Step 1: Run all Python tests:** `python -m unittest discover -s tests -t . -p "test_*.py" -v`.
- [ ] **Step 2: Run all Node tests:** `node --test tests/test_cookie_authorization.mjs tests/test_open_directory.mjs tests/test_scanner.mjs tests/test_size_display.mjs tests/test_probe_queue.mjs`.
- [ ] **Step 3: Run `get_errors` on changed Python and JavaScript files and build a uniquely named PyInstaller Host binary.**
- [ ] **Step 4: Smoke-test the built binary with Native Messaging `ping`; verify source and installed hashes after copying. Do not probe external URLs in automated tests.**
- [ ] **Step 5: Before deployment, check for active `yt-dlp` processes. Do not replace/reload the installed extension while a download is active; once safe, update extension files and Host manifest. Verify UI flow using a mocked Native Host response; any real page scan must be initiated by the user.**

## Constraints

- No cookies or request bodies; do not fetch media segments.
- Any network request must pass through the existing public-address validator.
- Unknown metadata is `unavailable`; actual request/HTTP failures are `failed`; do not silently convert one into the other.
- Do not commit or create a worktree because this workspace is not a Git repository.
