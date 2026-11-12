/// <reference types="node" />
import assert from "node:assert/strict"
import { gzipSync } from "node:zlib"
import { api, connectNodes, groupsOf, safeNodes, sample, speedHistory, type Node } from "./api.ts"

const node = { id: 1, metrics: { uptime: 100, cpu: 1, load: [0.1, 0.2, 0.3],
  mem_total: 1024, mem_used: 512, swap_total: 0, swap_used: 0, disk_total: 2048, disk_used: 1024,
  net_rx: 10, net_tx: 20, total_rx: 100, total_tx: 200, month_rx: 50, month_tx: 100,
  tcp: 3, udp: 4, procs: 20 } } as Node
assert.equal(safeNodes([node])[0], node)
for (const patch of [{ load: null }, { load: [1, "bad", 3] }, { cpu: "bad" }, { net_rx: Infinity }]) {
  const bad = { ...node, metrics: { ...node.metrics, ...patch } } as unknown as Node
  const result = safeNodes([bad, node])
  assert.equal(result[0].metrics, null)
  assert.equal(result[1], node)
}
console.log("invalid live reports are isolated")

// Tabs follow the node order; ungrouped nodes and a hub without the field add none.
assert.deepEqual(groupsOf([{ group: "东京" }, { group: "" }, {}, { group: "香港" }, { group: "东京" }]), ["东京", "香港"])
console.log("groups follow the node order")

// Each group keeps its own throughput line beside the fleet's, and a group that
// empties stops being tracked.
const live = (group: string, rx: number) => ({ ...node, group, online: true, metrics: { ...node.metrics!, net_rx: rx, net_tx: 0 } }) as Node
sample([live("东京", 5), live("", 7), { ...live("东京", 9), online: false }])
assert.deepEqual([speedHistory.get(null)?.at(-1)?.rx, speedHistory.get("东京")?.at(-1)?.rx, speedHistory.get("")?.at(-1)?.rx], [12, 5, 7])
sample([live("", 1)])
assert.equal(speedHistory.has("东京"), false)
// A group may be named anything, the fleet's own key included.
sample([live("*", 5), live("", 7)])
assert.deepEqual([speedHistory.get(null)?.at(-1)?.rx, speedHistory.get("*")?.at(-1)?.rx], [12, 5])
console.log("throughput is kept per group")

// A timeout is retried, since the next attempt may take a live connection; a
// read cut off by it reads as a network failure, never as the browser's message.
{
  let calls = 0
  const timeout = () => new DOMException("signal timed out", "TimeoutError")
  globalThis.fetch = async () => {
    if (++calls < 3) throw timeout()
    return { ok: true, status: 200, json: async () => ({ nodes: [] }) } as unknown as Response
  }
  assert.deepEqual(await api("/nodes"), { nodes: [] })
  assert.equal(calls, 3)
  globalThis.fetch = async () => {
    throw timeout()
  }
  await assert.rejects(api("/nodes"), { status: 0, message: "网络连接失败，稍后再试" })
  globalThis.fetch = async () =>
    ({ ok: false, status: 503, headers: new Headers({ "content-type": "text/plain" }), text: async () => { throw new DOMException("aborted", "AbortError") } }) as unknown as Response
  await assert.rejects(api("/nodes"), { status: 0 })
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse("<html>") }) as unknown as Response
  await assert.rejects(api("/nodes"), { status: 200, message: "收到的不是状态数据，稍后再试" })
  console.log("timeouts are retried and read as network failures")
}

// The live chain behind useNodes, driven through a fake WebSocket, fetch,
// document and clock -- no hub involved. connectNodes() starts at once: it
// pulls a snapshot, opens a stream, and returns a stop function.
{
  // A clock the test turns by hand: advance() runs what would have fired.
  const realSetTimeout = globalThis.setTimeout
  let now = 0
  let nextId = 1
  let timers: { id: number; at: number; fn: () => void; every: number | null }[] = []
  const install = (fn: () => void, ms: number, every: number | null) => {
    const t = { id: nextId++, at: now + ms, fn, every }
    timers.push(t)
    return t.id
  }
  globalThis.setTimeout = ((fn: () => void, ms = 0) => install(fn, ms, null)) as unknown as typeof setTimeout
  globalThis.setInterval = ((fn: () => void, ms = 0) => install(fn, ms, ms)) as unknown as typeof setInterval
  const clear = (id: number) => {
    timers = timers.filter((t) => t.id !== id)
  }
  globalThis.clearTimeout = clear as unknown as typeof clearTimeout
  globalThis.clearInterval = clear as unknown as typeof clearInterval
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      now = due.at
      if (due.every === null) timers = timers.filter((t) => t !== due)
      else due.at = now + due.every
      due.fn()
    }
    now = target
  }
  // Frame decoding is asynchronous; give it real event-loop turns.
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => realSetTimeout(r, 0))
  }

  class FakeWebSocket {
    static instances: FakeWebSocket[] = []
    static OPEN = 1
    static CLOSED = 3
    readyState = FakeWebSocket.OPEN
    onmessage: ((event: { data: unknown }) => void) | null = null
    onerror: (() => void) | null = null
    onclose: (() => void) | null = null
    url: string
    constructor(url: string) {
      this.url = url
      FakeWebSocket.instances.push(this)
    }
    close() {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.()
    }
    /** A frame arrives from the hub. */
    frame(data: unknown) {
      this.onmessage?.({ data })
    }
    /** The hub ends the stream. */
    drop() {
      this.readyState = FakeWebSocket.CLOSED
      this.onclose?.()
    }
  }
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket

  let hidden = false
  const listeners = new Map<string, () => void>()
  globalThis.document = {
    get hidden() {
      return hidden
    },
    addEventListener: (type: string, fn: () => void) => void listeners.set(type, fn),
    removeEventListener: (type: string) => void listeners.delete(type),
  } as unknown as Document
  globalThis.location = { protocol: "http:", host: "hub.test" } as unknown as Location
  const visibility = (h: boolean) => {
    hidden = h
    listeners.get("visibilitychange")?.()
  }

  let snapshot: Node[] = [node]
  let fetches = 0
  globalThis.fetch = async () => {
    fetches++
    return { ok: true, status: 200, json: async () => ({ nodes: snapshot }) } as unknown as Response
  }

  const realWarn = console.warn
  let warnings = 0
  console.warn = () => {
    warnings++
  }

  const start = () => {
    const state = { nodes: null as Node[] | null, error: null as string | null, closed: false }
    const stop = connectNodes({
      nodes: (n) => {
        state.nodes = n
      },
      error: (e) => {
        state.error = e
      },
      closed: (c) => {
        state.closed = c
      },
    })
    return { state, stop }
  }
  const lastSocket = () => FakeWebSocket.instances.at(-1)!
  const frameOf = (list: Node[]) => JSON.stringify({ nodes: list })
  const reset = () => {
    timers = []
    FakeWebSocket.instances = []
    fetches = 0
    warnings = 0
    snapshot = [node]
    speedHistory.clear()
  }

  // A good frame lands in the list, with no error raised.
  reset()
  {
    const { state, stop } = start()
    await flush() // the snapshot resume() asks for
    assert.deepEqual(state.nodes, [node])
    assert.equal(state.error, null)
    const other = { ...node, id: 2, name: "第二台" } as Node
    lastSocket().frame(frameOf([other]))
    await flush()
    assert.deepEqual(state.nodes, [other])
    assert.equal(state.error, null)
    stop()
  }
  console.log("live frames update the node list")

  // A frame that cannot be read -- broken JSON, no `nodes` in it, corrupt
  // gzip -- is dropped; the stream stays up and the next good frame lands.
  reset()
  {
    const { state, stop } = start()
    await flush()
    lastSocket().frame("{ 不是 JSON")
    lastSocket().frame(JSON.stringify({ nope: 1 }))
    lastSocket().frame(new Blob([new Uint8Array([1, 2, 3, 4])])) // 不是 gzip
    await flush()
    assert.deepEqual(state.nodes, [node]) // 坏帧不改数据
    assert.equal(state.error, null)
    assert.equal(FakeWebSocket.instances.length, 1) // 流没有被终止
    assert.ok(warnings >= 2, "坏帧被记录而不是静默吞掉")
    lastSocket().frame(new Blob([gzipSync(frameOf([node]))])) // 合法的 gzip 帧
    await flush()
    assert.deepEqual(state.nodes, [node])
    assert.equal(state.error, null)
    stop()
  }
  console.log("bad frames are dropped, good frames still land")

  // Ten seconds without a readable frame -- even with frames arriving that
  // cannot be read -- is an interruption: the notice shows and the stream is
  // rebuilt; the first good frame on the new stream clears the notice.
  reset()
  {
    const { state, stop } = start()
    await flush()
    advance(6_000)
    lastSocket().frame("{ 坏帧不算可读帧")
    await flush()
    advance(4_000) // 距上一个可读帧已 10 秒
    assert.equal(state.error, "实时数据中断，正在重新连接")
    assert.equal(FakeWebSocket.instances.length, 2) // 连接被重建
    assert.ok(fetches >= 2, "重建的同时拉了一次快照")
    lastSocket().frame(frameOf([node]))
    await flush()
    assert.equal(state.error, null) // 重建成功后提示消失
    assert.deepEqual(state.nodes, [node])
    stop()
  }
  console.log("silence is reported and the stream rebuilt")

  // Hidden then visible: a snapshot is pulled and a fresh stream opened at
  // once, and the throughput history from before the gap is dropped when the
  // first new data arrives rather than joined to it.
  reset()
  snapshot = [live("", 40)]
  {
    const { stop } = start()
    await flush()
    lastSocket().frame(frameOf([live("", 60)]))
    await flush()
    assert.equal(speedHistory.get(null)?.length, 2) // 断档前已攒两点
    const fetchesBefore = fetches
    const socketsBefore = FakeWebSocket.instances.length
    visibility(true)
    visibility(false)
    assert.equal(fetches, fetchesBefore + 1) // 立即重新拉快照
    assert.equal(FakeWebSocket.instances.length, socketsBefore + 1) // 重开新流
    await flush() // 恢复后的第一份数据到达
    assert.deepEqual(speedHistory.get(null), [{ rx: 40, tx: 0 }]) // 旧历史不与新数据相连
    stop()
  }
  console.log("returning from the background refetches and restarts the throughput line")

  // The fallback poll runs only while no stream is held: it starts when the
  // stream drops, and stops once a frame arrives on the rebuilt one.
  reset()
  {
    const { state, stop } = start()
    await flush()
    lastSocket().drop() // 流断开
    const before = fetches
    advance(5_000)
    assert.ok(fetches > before, "断开后开始 5 秒一次的轮询")
    assert.equal(FakeWebSocket.instances.length, 2) // 同时安排了重连
    lastSocket().frame(frameOf([node]))
    await flush()
    const steady = fetches
    advance(5_000)
    assert.equal(fetches, steady, "流恢复后轮询停止")
    assert.equal(state.error, null)
    stop()
  }
  console.log("the fallback poll runs only while the stream is down")

  console.warn = realWarn
  globalThis.setTimeout = realSetTimeout
}
