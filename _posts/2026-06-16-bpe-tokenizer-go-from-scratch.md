---
layout: post
title: "tokr: A Pure Go BPE Tokenizer"
date: 2026-06-16 10:00:00 +0530
slug: bpe-tokenizer-go-from-scratch
---

Every Go project that needs tokenization lands on the same answer: shell out to Python or wrap OpenAI's Rust library via CGO. That means your Docker image needs a C toolchain, cross-compilation breaks, and you're debugging crashes across the Go/C boundary.

I wanted a single binary. No sidecar. No CGO. So I built `tokr`, a Byte-Pair Encoding tokenizer in pure Go.

**[GitHub →](https://github.com/Sankalprai224/tokr)**

---

## What is BPE?

Language models don't read words. They read tokens, chunks somewhere between a character and a word. BPE is the algorithm that decides what those chunks are. GPT-4 uses it, LLaMA uses it.

Start with 256 raw bytes. Find the most frequent adjacent pair in your training data, merge it into a new token, repeat until you hit your target vocabulary size. When you encode new text, you replay those merges in the order they were learned. That's the whole thing.

---

## The HTTP API

`tokr` runs as a lightweight HTTP server, `net/http` only, no frameworks.

```
POST /encode   { "text": "..." }  →  { "tokens": [...], "count": N, "time_seconds": 0.000052 }
POST /decode   { "tokens": [...] }  →  { "text": "..." }
```

Small requests go through the single-threaded cached path. Anything over 999KB routes automatically to the parallel worker pool. The model loads once at startup and stays in memory.

---

## The Architecture

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 910" width="100%" style="font-family:'JetBrains Mono',ui-monospace,monospace;border-radius:12px;display:block;margin:2rem 0">
  <defs>
    <marker id="a" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="rgba(255,255,255,0.35)"/></marker>
    <marker id="b" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="rgba(255,255,255,0.18)"/></marker>
  </defs>
  <!-- Background -->
  <rect width="720" height="910" fill="#111" rx="12"/>
  <!-- Section labels -->
  <text transform="rotate(-90,20,185)" x="20" y="185" text-anchor="middle" fill="rgba(255,255,255,0.22)" font-size="10" font-weight="700" letter-spacing="3">TRAIN</text>
  <text transform="rotate(-90,20,500)" x="20" y="500" text-anchor="middle" fill="rgba(255,255,255,0.22)" font-size="10" font-weight="700" letter-spacing="3">ENCODE</text>
  <text transform="rotate(-90,20,710)" x="20" y="710" text-anchor="middle" fill="rgba(255,255,255,0.22)" font-size="10" font-weight="700" letter-spacing="3">DECODE</text>
  <!-- Section backgrounds -->
  <rect x="36" y="18" width="672" height="320" rx="10" fill="rgba(60,32,125,0.07)" stroke="rgba(90,59,163,0.22)" stroke-width="1"/>
  <rect x="36" y="352" width="672" height="270" rx="10" fill="rgba(138,39,18,0.07)" stroke="rgba(179,62,37,0.22)" stroke-width="1"/>
  <rect x="36" y="636" width="672" height="92" rx="10" fill="rgba(12,62,122,0.07)" stroke="rgba(26,93,179,0.22)" stroke-width="1"/>
  <!-- ── TRAIN NODES ── -->
  <!-- Raw text input -->
  <rect x="268" y="32" width="170" height="42" rx="8" fill="#1e1e1e" stroke="#555" stroke-width="1"/>
  <text x="353" y="49" text-anchor="middle" fill="#999" font-size="12" font-weight="600">Raw text input</text>
  <!-- SplitText -->
  <rect x="48" y="98" width="174" height="54" rx="8" fill="#2d1865" stroke="#6a4bd4" stroke-width="1"/>
  <text x="135" y="120" text-anchor="middle" fill="#c8b8ff" font-size="12" font-weight="700">SplitText</text>
  <text x="135" y="138" text-anchor="middle" fill="#c8b8ff" font-size="10" opacity=".7">GPT-4 regex or FastSplit</text>
  <!-- getStats -->
  <rect x="254" y="98" width="196" height="54" rx="8" fill="#0a3d2e" stroke="#1a9970" stroke-width="1"/>
  <text x="352" y="120" text-anchor="middle" fill="#7ee8c2" font-size="11" font-weight="700">getStats + merge loop</text>
  <text x="352" y="138" text-anchor="middle" fill="#7ee8c2" font-size="10" opacity=".7">vocabSize – 256 iterations</text>
  <!-- orderedPairs -->
  <rect x="482" y="98" width="210" height="54" rx="8" fill="#2d1865" stroke="#6a4bd4" stroke-width="1"/>
  <text x="587" y="120" text-anchor="middle" fill="#c8b8ff" font-size="11" font-weight="700">orderedPairs + merges</text>
  <text x="587" y="138" text-anchor="middle" fill="#c8b8ff" font-size="10" opacity=".7">pair→rank map, ordered list</text>
  <!-- [][]int -->
  <rect x="48" y="186" width="174" height="42" rx="8" fill="#2d1865" stroke="#6a4bd4" stroke-width="1"/>
  <text x="135" y="212" text-anchor="middle" fill="#c8b8ff" font-size="11" font-weight="600">[][]int ids workspace</text>
  <!-- merger() -->
  <rect x="254" y="180" width="196" height="54" rx="8" fill="#0a3d2e" stroke="#1a9970" stroke-width="1"/>
  <text x="352" y="202" text-anchor="middle" fill="#7ee8c2" font-size="12" font-weight="700">merger()</text>
  <text x="352" y="220" text-anchor="middle" fill="#7ee8c2" font-size="10" opacity=".7">sync.Pool buf, in-place collapse</text>
  <!-- buildVocab() -->
  <rect x="482" y="180" width="210" height="54" rx="8" fill="#2d1865" stroke="#6a4bd4" stroke-width="1"/>
  <text x="587" y="202" text-anchor="middle" fill="#c8b8ff" font-size="12" font-weight="700">buildVocab()</text>
  <text x="587" y="220" text-anchor="middle" fill="#c8b8ff" font-size="10" opacity=".7">vocab + tokenLens maps</text>
  <!-- Save/Load -->
  <rect x="482" y="264" width="210" height="42" rx="8" fill="#1e1e1e" stroke="#555" stroke-width="1"/>
  <text x="587" y="281" text-anchor="middle" fill="#999" font-size="11" font-weight="600">Save / Load</text>
  <text x="587" y="297" text-anchor="middle" fill="#999" font-size="10" opacity=".7">(.model file)</text>
  <!-- TRAIN ARROWS -->
  <line x1="353" y1="74" x2="200" y2="98" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="222" y1="125" x2="254" y2="125" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="450" y1="125" x2="482" y2="125" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="135" y1="152" x2="135" y2="186" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="222" y1="207" x2="254" y2="207" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="450" y1="207" x2="482" y2="207" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="587" y1="234" x2="587" y2="264" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- next merge dashed loop -->
  <path d="M352 234 L352 255 L228 255 L228 125" stroke="rgba(255,255,255,0.18)" stroke-width="1.5" stroke-dasharray="5,4" fill="none" marker-end="url(#b)"/>
  <text x="244" y="268" fill="rgba(255,255,255,0.28)" font-size="10">next merge</text>
  <!-- ── ENCODE NODES ── -->
  <!-- Encode() -->
  <rect x="48" y="368" width="174" height="54" rx="8" fill="#5c1a0e" stroke="#c44025" stroke-width="1"/>
  <text x="135" y="390" text-anchor="middle" fill="#ffb3a3" font-size="12" font-weight="700">Encode()</text>
  <text x="135" y="408" text-anchor="middle" fill="#ffb3a3" font-size="10" opacity=".7">single-threaded entry</text>
  <!-- cache lookup -->
  <rect x="254" y="368" width="196" height="54" rx="8" fill="#5c3700" stroke="#c4820a" stroke-width="1"/>
  <text x="352" y="390" text-anchor="middle" fill="#ffd07a" font-size="12" font-weight="700">cache lookup</text>
  <text x="352" y="408" text-anchor="middle" fill="#ffd07a" font-size="10" opacity=".7">cacheMu RWMutex, full-clear evict</text>
  <!-- cache hit -->
  <rect x="482" y="368" width="210" height="54" rx="8" fill="#5c3700" stroke="#c4820a" stroke-width="1"/>
  <text x="587" y="390" text-anchor="middle" fill="#ffd07a" font-size="12" font-weight="700">cache hit → return</text>
  <text x="587" y="408" text-anchor="middle" fill="#ffd07a" font-size="10" opacity=".7">reads t.merges</text>
  <!-- ParallelEncode() -->
  <rect x="48" y="456" width="174" height="54" rx="8" fill="#5c1a0e" stroke="#c44025" stroke-width="1"/>
  <text x="135" y="478" text-anchor="middle" fill="#ffb3a3" font-size="11" font-weight="700">ParallelEncode()</text>
  <text x="135" y="496" text-anchor="middle" fill="#ffb3a3" font-size="10" opacity=".7">1 MB chunks, boundary scan</text>
  <!-- encodeCore() -->
  <rect x="254" y="456" width="196" height="54" rx="8" fill="#5c1a0e" stroke="#c44025" stroke-width="1"/>
  <text x="352" y="478" text-anchor="middle" fill="#ffb3a3" font-size="12" font-weight="700">encodeCore()</text>
  <text x="352" y="496" text-anchor="middle" fill="#ffb3a3" font-size="10" opacity=".7">regex match or FastSplit loop</text>
  <!-- runMergeLogic() -->
  <rect x="482" y="456" width="210" height="54" rx="8" fill="#0a3d2e" stroke="#1a9970" stroke-width="1"/>
  <text x="587" y="478" text-anchor="middle" fill="#7ee8c2" font-size="12" font-weight="700">runMergeLogic()</text>
  <text x="587" y="496" text-anchor="middle" fill="#7ee8c2" font-size="10" opacity=".7">O(n²) greedy BPE merge</text>
  <!-- worker pool -->
  <rect x="48" y="542" width="174" height="54" rx="8" fill="#0a3d2e" stroke="#1a9970" stroke-width="1"/>
  <text x="135" y="564" text-anchor="middle" fill="#7ee8c2" font-size="12" font-weight="700">worker pool</text>
  <text x="135" y="582" text-anchor="middle" fill="#7ee8c2" font-size="10" opacity=".7">NumCPU goroutines, ordered results</text>
  <!-- ENCODE ARROWS -->
  <line x1="222" y1="395" x2="254" y2="395" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="450" y1="395" x2="482" y2="395" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="352" y1="422" x2="352" y2="456" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <text x="358" y="442" fill="rgba(255,255,255,0.3)" font-size="10">miss</text>
  <line x1="135" y1="510" x2="135" y2="542" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="222" y1="483" x2="254" y2="483" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="450" y1="483" x2="482" y2="483" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- worker pool → encodeCore diagonal -->
  <line x1="222" y1="566" x2="283" y2="510" stroke="rgba(255,255,255,0.2)" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- ── DECODE NODES ── -->
  <!-- Decode() -->
  <rect x="48" y="650" width="174" height="54" rx="8" fill="#0a2a52" stroke="#1a6dd4" stroke-width="1"/>
  <text x="135" y="672" text-anchor="middle" fill="#7ab8ff" font-size="12" font-weight="700">Decode()</text>
  <text x="135" y="690" text-anchor="middle" fill="#7ab8ff" font-size="10" opacity=".7">mu.Rlock, tokenLens prealloc</text>
  <!-- strings.Builder -->
  <rect x="254" y="650" width="196" height="54" rx="8" fill="#0a2a52" stroke="#1a6dd4" stroke-width="1"/>
  <text x="352" y="672" text-anchor="middle" fill="#7ab8ff" font-size="12" font-weight="700">strings.Builder</text>
  <text x="352" y="690" text-anchor="middle" fill="#7ab8ff" font-size="10" opacity=".7">Grow(totalLen), vocab[] write</text>
  <!-- string output -->
  <rect x="482" y="650" width="210" height="54" rx="8" fill="#1e1e1e" stroke="#555" stroke-width="1"/>
  <text x="587" y="677" text-anchor="middle" fill="#999" font-size="12" font-weight="600">string output</text>
  <!-- DECODE ARROWS -->
  <line x1="222" y1="677" x2="254" y2="677" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="450" y1="677" x2="482" y2="677" stroke="rgba(255,255,255,0.3)" stroke-width="1.5" marker-end="url(#a)"/>
  <!-- ── TOKENIZER STRUCT ── -->
  <text x="460" y="748" text-anchor="middle" fill="rgba(255,255,255,0.22)" font-size="10">↓ written by Train / Load</text>
  <line x1="587" y1="306" x2="587" y2="742" stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="4,4"/>
  <rect x="36" y="758" width="672" height="82" rx="10" fill="#1e124a" stroke="#6a4bd4" stroke-width="1"/>
  <text x="372" y="780" text-anchor="middle" fill="#d4c0ff" font-size="13" font-weight="700">tokenizer struct (shared state)</text>
  <text x="150" y="802" text-anchor="middle" fill="#d4c0ff" font-size="10" opacity=".65">merges map[pair]int</text>
  <text x="372" y="802" text-anchor="middle" fill="#d4c0ff" font-size="10" opacity=".65">vocab map[int][]byte</text>
  <text x="600" y="802" text-anchor="middle" fill="#d4c0ff" font-size="10" opacity=".65">tokenLens map[int]int</text>
  <text x="150" y="820" text-anchor="middle" fill="#d4c0ff" font-size="10" opacity=".65">cache + cacheMu</text>
  <text x="372" y="820" text-anchor="middle" fill="#d4c0ff" font-size="10" opacity=".65">mu sync.RWMutex</text>
  <text x="600" y="820" text-anchor="middle" fill="#d4c0ff" font-size="10" opacity=".65">bufferpool sync.Pool</text>
  <!-- ── LEGEND ── -->
  <rect x="48" y="858" width="11" height="11" rx="2" fill="#6a4bd4"/><text x="65" y="868" fill="rgba(255,255,255,0.45)" font-size="11">core data structures</text>
  <rect x="220" y="858" width="11" height="11" rx="2" fill="#1a9970"/><text x="237" y="868" fill="rgba(255,255,255,0.45)" font-size="11">merge algorithms</text>
  <rect x="380" y="858" width="11" height="11" rx="2" fill="#c44025"/><text x="397" y="868" fill="rgba(255,255,255,0.45)" font-size="11">encode entry points</text>
  <rect x="560" y="858" width="11" height="11" rx="2" fill="#c4820a"/><text x="577" y="868" fill="rgba(255,255,255,0.45)" font-size="11">cache layer</text>
  <rect x="48" y="880" width="11" height="11" rx="2" fill="#1a6dd4"/><text x="65" y="890" fill="rgba(255,255,255,0.45)" font-size="11">decode path</text>
  <rect x="220" y="880" width="11" height="11" rx="2" fill="#555"/><text x="237" y="890" fill="rgba(255,255,255,0.45)" font-size="11">I/O and external</text>
</svg>

Four layers, each with one job. The splitter doesn't merge. The merge engine doesn't split. The HTTP layer just routes.

---

## The Four Layers



**Layer 1, Splitter:** Raw text can't go directly into BPE. Without boundaries, merges cross word edges and produce tokens that straddle spaces, which breaks compatibility with every other tokenizer. The splitter cuts text at semantic boundaries first. `GPTSplit` uses the exact GPT-4 regex pattern for tiktoken compatibility. `FastSplit` is a hand-rolled Unicode scanner with zero allocations, about 3x faster with slight edge-case differences.

**Layer 2, Merge Engine:** Scans the token array for the lowest-rank pair, merges it in-place using `copy`, shrinks the slice, repeats. No new allocations per iteration. Early versions allocated a fresh slice every step, which turns into 18 million allocations on a 16MB file. In-place drops that to zero.

**Layer 3, Cache:** Natural language is repetitive. `" the"` doesn't need to be encoded from scratch a million times. Every encoded chunk gets stored in a `sync.RWMutex`-guarded map. Cache hits skip the regex engine and the merge loop entirely, it's just a map lookup. The result is a 47x latency difference between cold and warm path.

**Layer 4, Worker Pool:** For inputs over 1MB, the text splits into chunks and encodes across `runtime.NumCPU()` goroutines via buffered channels. The chunker scans backward from each split point to find a natural boundary so words are never cut mid-token. A bitwise check handles multi-byte Unicode so the regex engine never gets a malformed string.

---

## Benchmarks

### How the comparison was set up

tiktoken was benchmarked using its official Python library (`tiktoken` package, `cl100k_base` encoding). tokr was benchmarked using its own `ParallelEncode` path with `useGPT4=true`, which runs the same GPT-4 regex pattern. Both were run on the same corpus.

The benchmark corpus (`real_world.txt`) was generated by `generate_data.py`, a script that mixes English prose paragraphs, code snippets (Go, Python, SQL, JS), and Unicode edge cases (Japanese, emoji, accented Latin). This was intentional. A tokenizer that only performs well on clean English prose is not useful in production.

```python
SIZES = {
    "prose":   50000,   # paragraphs
    "code":    20000,   # code blocks
    "unicode": 10000,   # mixed scripts
}
```

The heavy test (`10MB.txt`) was generated by `generate_heavy.py`, which cycles through prose, code, JSON log lines, whitespace-only strings, and punctuation noise to stress the branch predictor and avoid an artificially warm cache from repetition.

### Go benchmark suite

The Go benchmarks in `bpe/bench_test.go` cover:

- `BenchmarkEncodeCore_Micro`: cold path with a minimal dummy tokenizer, measures raw merge loop cost
- `BenchmarkEncode_Cached`: hot path after cache warm, measures the map lookup and defensive copy
- `BenchmarkEncode_RealModel_{1KB,100KB,500KB}`: single-threaded Encode on realistic input sizes
- `BenchmarkParallelEncode_10MB`: full worker pool on a 10MB corpus
- `BenchmarkEncode_Single_vs_Parallel`: side-by-side on a 16MB payload to isolate the GC bottleneck
- `BenchmarkEncode_CacheHitRate`: server simulation with 5 rotating sentences to measure cache efficiency
- `BenchmarkDecode_RealModel`: measures the pre-computed allocation and Builder write path
- `BenchmarkRoundTrip_RealModel`: encode then decode round-trip on 50KB

Run them yourself:

```
make bench
# or
go test -bench=. -benchmem ./bpe/
```

### Server load test

`bench_server.go` hammers the live HTTP server with 50 concurrent workers firing 10,000 total requests. Each request is a roughly 160-byte realistic payload. This measures real request-per-second throughput including HTTP overhead, JSON marshalling, and goroutine scheduling.

### Fuzzing

`fuzz_test.go` and `test_fuzzy.py` both target round-trip integrity: `Decode(Encode(text)) == text`. The Go fuzzer runs against the `FastSplit` path with randomized inputs. The Python fuzzer (`hypothesis` library, 1000 examples) sends requests to the live server and checks every response. Neither has found a mismatch.

```
make fuzz   # Go native fuzzer, 10s
```

### Results

Tests run on AMD Ryzen 5 7530U, 25MB mixed corpus.

**vs tiktoken:**

<div class="table-wrapper" markdown="1">

| Library  | Language       | Throughput  | Speed           |
|----------|----------------|-------------|-----------------|
| tiktoken | Rust + Python  | 11.33 MB/s  | ~3.7M tokens/s  |
| tokr     | Pure Go        | 9.03 MB/s   | ~5.3M tokens/s  |

</div>

<div id="chart-tiktoken-compare" class="chart-container" style="margin-top:2rem;margin-bottom:1rem;"></div>

tokr shows higher tokens/sec but lower MB/s. These measure different things. MB/s is raw input bytes per second. Tokens/sec depends on average token length. tokr's vocabulary produces slightly shorter average tokens on this corpus so it generates more tokens per byte. Both are real, they just answer different questions.

**Hot vs cold path:**

<div class="table-wrapper" markdown="1">

| Path            | Latency      | Allocations |
|-----------------|--------------|-------------|
| Cached (hot)    | 52–220 ns    | 1           |
| Uncached (cold) | ~10.23 µs    | 75          |

</div>

<div id="chart-latency-bar" class="chart-container" style="margin-top:2rem;margin-bottom:1rem;"></div>

The single allocation on the hot path is a defensive copy of the cached slice. Without it, callers could corrupt the cache for every future request.

<div id="chart-latency-line" class="chart-container" style="margin-top: 2rem; margin-bottom: 2rem;"></div>

**Raw parallel scaling:**

```
SingleThreaded   2.93 MB/s    18.6M allocs
Parallel         3.30 MB/s    18.6M allocs
```

<div id="chart-scaling-bar" class="chart-container" style="margin-top:2rem;margin-bottom:1rem;"></div>

Adding more cores bought only 13%. The root cause is `regexp2`. To match the GPT-4 pattern exactly, tokr uses a Go port of the .NET regex engine. It's the only option in Go that supports the `\p{L}` and `\p{N}` Unicode category expressions the pattern requires. The problem is that `regexp2` is allocation-heavy by design. On a 16MB cold input, it produces 18.6 million allocations. The Go runtime ends up spending most of its time on allocation locks rather than actual BPE work. Adding cores doesn't help because they all contend on the same allocator. This is the GC wall. Parallel only pays off once the cache is warm and the merge loop stops touching `regexp2` entirely.

---

## What Still Needs Fixing

- `sync.Pool` unused in inference: wired into training but not the hot path
- O(N²) on pathological input: a 10k-char base64 blob as one chunk will lock up the CPU
- Cache eviction is a full clear: needs LRU before running on diverse-input servers
- Worker chunk size is hardcoded: should scale dynamically with `runtime.NumCPU()`
- No HTTP timeouts: needs `ReadTimeout` and `WriteTimeout` before going public

<script src="{{ '/assets/js/charts.js' | relative_url }}"></script>
<script>
document.addEventListener('DOMContentLoaded', () => {

  // ── Chart 1: tokr vs tiktoken comparison (grouped bars) ──
  new GroupedBarChart('chart-tiktoken-compare', {
    yAxisTitle: 'Value',
    labels: ['Throughput (MB/s)', 'Speed (M tokens/s)'],
    datasets: [
      { label: 'tiktoken', color: '#6c8ebf', values: [11.33, 3.7] },
      { label: 'tokr',     color: '#d79b00', values: [9.03,  5.3] }
    ]
  });

  // ── Chart 2: Hot vs Cold path (simple bar) ──
  new BarChart('chart-latency-bar', {
    data: [
      { label: 'Uncached (cold)', value: 10.23, valueDisplay: '10.23 µs', color: '#e5534b' },
      { label: 'Cached (hot)',    value: 0.22,  valueDisplay: '52–220 ns', color: '#4caf50' }
    ]
  });

  // ── Chart 3: Cache latency drop line chart ──
  const latencyData = [{x:1,y:10.23},{x:2,y:0.18},{x:3,y:0.15},{x:4,y:0.14},
    {x:5,y:0.13},{x:6,y:0.13},{x:7,y:0.12},{x:8,y:0.12},
    {x:9,y:0.12},{x:10,y:0.11},{x:11,y:0.11}];
  new LineChart('chart-latency-line', {
    title: 'Cache Latency Drop',
    xAxisTitle: 'Request Number',
    yAxisTitle: 'Latency (µs)',
    yUnit: ' µs',
    yDecimals: 2,
    yMin: 0,
    xLabels: [1,'','','','','','','','','',11],
    datasets: [{ label: 'tokr latency', color: '#bc1888', data: latencyData }]
  });

  // ── Chart 4: Single vs Parallel (grouped bars) ──
  new GroupedBarChart('chart-scaling-bar', {
    yAxisTitle: 'MB/s',
    yUnit: '',
    labels: ['Throughput'],
    datasets: [
      { label: 'SingleThreaded', color: '#e5534b', values: [2.93] },
      { label: 'Parallel',       color: '#4caf50', values: [3.30] }
    ]
  });

});
</script>
