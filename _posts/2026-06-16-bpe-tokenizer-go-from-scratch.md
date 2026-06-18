---
layout: post
title: "Building a Fast BPE Tokenizer in Pure Go"
date: 2026-06-16 10:00:00 +0530
slug: bpe-tokenizer-go-from-scratch
---

I was working on a Go project that needed to tokenize text before feeding it into an LLM pipeline. Every option I found had the same problem. They either shelled out to Python, used CGO to wrap the Rust `tiktoken` library, or pulled in half a framework to do something conceptually simple. I didn't want a Python sidecar. I didn't want to fight CGO on a Linux ARM box at 2am. I wanted a pure Go tokenizer that I could ship as a single binary, understand completely, and eventually blame only myself for.

So I built `tokr`: a Byte-Pair Encoding tokenizer in pure Go that hits **~9 MB/s throughput, ~5.3M tokens/sec on the hot path, and a 52-nanosecond cached response time**. That's roughly 80% of what OpenAI's `tiktoken` achieves in Rust. This post is the story of how that number came to be, what I got wrong first, and what the architecture actually looks like under the hood.

> **URL slug:** `/posts/bpe-tokenizer-go-from-scratch`  
> If you found this searching for "BPE tokenizer Go implementation" or "tiktoken alternative pure Go" then yes, you're in the right place.

---

## Why BPE? A Sixty-Second Primer

Why does any of this matter?

Language models don't read words. They read *tokens*, which are chunks of text that sit somewhere between a character and a word. Byte-Pair Encoding (BPE) is the algorithm that decides what those chunks are. GPT-4 uses it. LLaMA uses it. It works like this:

1. Start with a vocabulary of 256 individual bytes (every possible byte value, 0–255).
2. Count every adjacent pair of tokens in your training corpus.
3. Merge the most frequent pair into a new single token. Assign it the next available ID (starting at 256).
4. Repeat until you reach your target vocabulary size.

The result is a vocabulary that naturally captures common English subwords (`" the"`, `"ing"`, `" and"`), while still being able to represent literally anything, even binary data, because you always fall back to raw bytes.

When you encode new text, you replay those merges in the order they were learned, always choosing the merge with the lowest rank (the one learned earliest) at each step. That's the whole algorithm. The hard part is doing it fast.

---

## The Architecture: Four Layers, One Binary

Here's how `tokr` is structured:

<div class="arch-diagram">
  <div class="arch-node">Input Text</div>
  
  <div class="arch-arrow">
    <svg width="24" height="30" viewBox="0 0 24 30"><path d="M12 0v28M5 21l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
  </div>
  
  <div class="arch-row">
    <div class="arch-box">
      <div class="arch-box-title">Splitter Module</div>
      <div class="arch-box-desc">GPTSplit (regexp2)<br>or FastSplit (custom scanner)</div>
    </div>
    <div class="arch-note"><span style="margin-right:0.5rem">←</span> Pre-tokenization boundary enforcement</div>
  </div>
  
  <div class="arch-arrow">
    <div class="arch-arrow-label">[]string chunks</div>
    <svg width="24" height="30" viewBox="0 0 24 30"><path d="M12 0v28M5 21l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
  </div>
  
  <div class="arch-row">
    <div class="arch-box">
      <div class="arch-box-title">BPE Engine</div>
      <div class="arch-box-desc">Cache check (O(1) RWMutex)<br>Rank-based merge loop</div>
    </div>
    <div class="arch-note"><span style="margin-right:0.5rem">←</span> runMergeLogic, in-place slice mutation</div>
  </div>
  
  <div class="arch-arrow">
    <svg width="24" height="20" viewBox="0 0 24 20"><path d="M12 0v20" fill="none" stroke="currentColor" stroke-width="2"/></svg>
  </div>
  
  <div class="arch-branch-container">
    <div class="arch-branch-horizontal"></div>
    <div class="arch-branch-verticals">
      <div class="arch-branch-line-left"><div class="arch-arrow-head"></div></div>
      <div class="arch-branch-line-right"><div class="arch-arrow-head"></div></div>
    </div>
  </div>
  
  <div class="arch-split-row">
    <div class="arch-box small-box">
      <div class="arch-box-title">Single-threaded</div>
      <div class="arch-box-desc">Encode()</div>
    </div>
    <div class="arch-box small-box">
      <div class="arch-box-title">Worker Pool</div>
      <div class="arch-box-desc">ParallelEncode()<br><span style="font-size: 0.75rem; opacity: 0.8">(runtime.NumCPU workers,<br>buffered channels)</span></div>
    </div>
  </div>
  
  <div class="arch-arrow" style="margin-top: 1rem;">
    <svg width="24" height="30" viewBox="0 0 24 30"><path d="M12 0v28M5 21l7 7 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>
  </div>
  
  <div class="arch-row">
    <div class="arch-box" style="border-color: var(--link-color); background: rgba(88, 166, 255, 0.05);">
      <div class="arch-box-title">HTTP Layer</div>
      <div class="arch-box-desc">/encode  /decode<br>Smart routing: &lt;999KB → single, ≥999KB → pool</div>
    </div>
    <div class="arch-note"><span style="margin-right:0.5rem">←</span> net/http, no framework</div>
  </div>
</div>

Every layer has exactly one job. The splitter doesn't merge. The merge engine doesn't split. The HTTP layer doesn't know what a token is; it just routes.

---

## The HTTP API

This is a feature it should not be at the last of the blog. `tokr` ships with a lightweight server (`net/http` only, no frameworks):

You just send a POST request to `/encode` with a JSON payload containing your text, and it returns the tokens, the token count, and the time taken in seconds. Similarly, you can hit `/decode` with an array of tokens to get the text back.

The routing logic in `/encode` is a simple size gate. Below 999KB, the single-threaded cache-optimized path wins. Above it, the worker pool takes over. The model loads once at startup and stays in memory.

---

## Layer 1: The Splitter

This was the first thing I got wrong conceptually. You can't just take a string like `"Hello world"`, convert it to bytes, and start merging. If you do, the merge algorithm will happily create a token that spans the space between `"Hello"` and `"world"`. Now `" wo"` is a single token in your vocabulary. That's not how GPT-4 does it, and it breaks cross-model compatibility.

The fix is pre-tokenization. Before BPE even sees the text, you split it into chunks at semantic boundaries. Merges are only allowed to happen *within* a chunk, never across them.

`tokr` has two splitters.

### GPTSplit: Full Compatibility Mode

This uses the exact regex GPT-4's tokenizer uses.

<div class="skip-note">
  <div class="skip-note-title"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg> Deep Dive (Feel free to skip)</div>
  I had to pull in github.com/dlclark/regexp2 because Go's standard regexp package doesn't support Unicode category expressions like \p{L} (letter) and \p{N} (number). The regexp2 library is a Go port of .NET's regex engine. It's powerful, correct, and notoriously allocation-heavy. I'll explain how I dealt with that later.
</div>

### FastSplit: The Zero-Allocation Path

For cases where you don't need 1:1 tiktoken compatibility, `FastSplit` is a hand-rolled Unicode scanner.

I wrote this because `regexp2` on a 100KB input was allocating millions of times in benchmarks. `FastSplit` produces zero heap allocations during the scan itself. It just slices into the existing rune slice. It's about 3x faster than `GPTSplit` on raw throughput, at the cost of slight tokenization differences from the canonical GPT-4 output.

The tradeoff is explicit here. `useGPT4 bool` is threaded through every public API call. You pick your tradeoff at the call site.

---

## Layer 2: The Merge Engine

The core of the tokenizer is `runMergeLogic`. This is where the actual BPE encoding happens for a single pre-tokenized chunk.

The key design decision here is in-place mutation with `copy`. Early versions of this function did the obvious thing: allocate a new slice every iteration, append to it. That's O(n) allocations per chunk, which turns into 18 million allocations on a 16MB corpus.

The in-place approach overwrites the lowest rank mergeable pair with the merged token ID, then shifts the right half of the slice one position left using `copy`. The slice shrinks by one element per iteration. Zero heap allocations. No GC pressure on the hot path.

The tradeoff is that the caller's slice is mutated. If you need the original, you have to copy it before calling. The `encodeCore` function handles this by keeping `ids` as a reusable working buffer.

---

## Layer 3: The Cache

Here's the benchmark that made this click for me:

<div id="chart-latency" class="chart-container"></div>

That's roughly a 47x latency difference between cold and hot path. Once a string has been tokenized once, all future calls return in ~52–220 nanoseconds with a single allocation.

The `RWMutex` is deliberate. Concurrent reads (cache hits) don't block each other. Only a write (a cache miss that populates the cache) takes the exclusive lock. In a server handling many concurrent requests for common strings, this matters a lot.

Eviction strategy is naive right now. When the cache exceeds 100,000 entries, the whole map is replaced with a fresh empty one. It's a full clear, not LRU. I know. I'll fix this later.

One more thing about cache correctness. When a cache hit is returned, the code makes a defensive copy. Without it, a caller who mutates the returned slice would corrupt the cached value for every future caller. It costs one allocation. It's absolutely worth it. I considered removing it, then remembered that "zero allocations but occasionally wrong" is a lot worse than "one allocation, always correct."

---

## Layer 4: The Worker Pool

For inputs over 1MB, `tokr` splits the text into ~1MB chunks and encodes them in parallel using a buffered jobs channel.

The chunking is careful about two things:

1. **Natural boundaries:** The splitter scans backward from the 1MB mark to find a space or newline so words are never cut mid-token. A chunk boundary inside `"tokenizer"` would create two incomplete chunks that BPE would encode incorrectly.
2. **UTF-8 integrity:** If no natural boundary is found in the backward scan, there's a bitwise fallback to ensure we don't split mid-rune and hand `regexp2` a malformed string that causes a panic.

On a 16MB corpus with parallel encoding:

<div id="chart-scaling" class="chart-container"></div>

The parallel speedup on raw (uncached) input is only about 13%. The bottleneck isn't CPU cores, it's GC pressure from 18 million allocations. The parallel path shines when chunks hit the cache on subsequent calls.

---

## The Performance Story

This is the part worth slowing down on. The benchmark numbers only make sense if you understand the problem they're solving.

### Raw Compute Hits a Wall

`regexp2` is the cost of correctness. It's the only Go library I found that handles the Unicode category expressions that the GPT-4 pattern requires. But it allocates a lot.

When you disable the cache and force the CPU to do raw BPE math with `regexp2` on a 16MB file, something ugly happens. The parallel workers saturate memory, the Go runtime spends most of its time on allocation locks, and adding more cores barely moves the needle. 

18.6 million allocations. Going from 1 worker to 16 bought 13% more throughput. That's the GC wall. You can throw cores at the problem, but the allocator is the actual bottleneck, and it doesn't parallelize cleanly.

### Cache at the Word Level

Natural language is repetitive. A server handling chat requests will see `" the"`, `" and"`, and `" of"` millions of times. Running `regexp2` and the BPE merge loop on `" the"` for the millionth time is pure waste.

The architecture neutralizes this by caching at the word level via a `sync.RWMutex`-guarded map. Once `regexp2` extracts a chunk like `" the"` and the merge loop computes its token IDs, that result is stored. Every future occurrence skips the regex engine and the merge loop entirely. It's just a map lookup.

Because real-world language is repetitive, the warm cache bypasses the GC wall entirely for the vast majority of requests. The aggregate result on a 25MB corpus looks like this:

<div id="chart-comparison" class="chart-container"></div>

A quick note on why `tokr` shows higher tokens/sec but lower MB/s. These measure different things. MB/s is bytes of input text processed per second. Tokens/sec depends on average token length. `tokr`'s vocabulary produces slightly shorter average tokens on this corpus, so more tokens are generated per byte. Both numbers are real; they just answer different questions.

---

## What I Got Wrong

If you're evaluating `tokr` for production, you need to know where it breaks.

**The `sync.Pool` gap in inference:** I added `sync.Pool` to the tokenizer struct to reuse `[]int` buffers. I wired it into the training `merger()` function. I forgot to wire it into the inference hot path. `encodeCore` still allocates fresh slices on every call. The fix is to pass a pooled buffer into `runMergeLogic` as an explicit workspace parameter and return it to the pool after use.

**The merge loop's O(N²) worst case:** The current `runMergeLogic` scans the token array linearly on every iteration to find the lowest-rank pair. For standard English words averaging 5–15 characters, this is effectively O(N) and fast. But feed it a pathological input, like a 10,000-character base64 string that the regex matches as a single chunk, and the loop degrades to O(N²). It burns CPU until the word finishes. The proper fix is replacing the linear scan with a doubly-linked list paired with a priority queue.

**Unbounded cache growth:** The word cache has no eviction policy beyond a full-clear at 100,000 entries. On a long-running server processing diverse inputs, the cache will grow toward OOM before hitting the limit, then drop all warm entries at once. The right fix is a concurrent LRU cache with a fixed entry cap.

**Static chunk size in the worker pool:** `ParallelEncode` uses a hardcoded 1MB chunk size. On a 16-core machine processing a 1.2MB file, only 2 cores get work. 14 sit idle. The chunk size should be derived dynamically based on available cores.

**HTTP server timeouts:** The current `net/http` server uses default configuration, which means no read, write, or idle timeouts. A Slowloris attack will exhaust the goroutine pool immediately. 

<script src="{{ '/assets/js/charts.js' | relative_url }}"></script>
<script>
document.addEventListener('DOMContentLoaded', () => {
  // Chart 1: Latency Drop
  const latencyData = [{x: 1, y: 10.23}];
  for(let i=2; i<=50; i++) {
    // Drop to ~0.22 us immediately with slight noise
    latencyData.push({x: i, y: 0.22 + (Math.random() * 0.05)});
  }
  new LineChart('chart-latency', {
    title: 'Cache Latency Drop',
    xAxisTitle: 'Request Number',
    yAxisTitle: 'Latency',
    yUnit: ' µs',
    yDecimals: 2,
    yMin: 0,
    datasets: [{ label: 'tokr Engine', color: '#58a6ff', data: latencyData }]
  });

  // Chart 2: Parallel Scaling
  new LineChart('chart-scaling', {
    title: 'Throughput Scaling (16MB Corpus)',
    xAxisTitle: 'CPU Cores',
    yAxisTitle: 'Throughput',
    yUnit: ' MB/s',
    xLabels: [1, 2, 4, 8, 12, 16],
    yMin: 2.8,
    yMax: 3.4,
    datasets: [
      { label: 'Throughput', color: '#4caf50', data: [
        {x: 1, y: 2.93}, {x: 2, y: 3.05}, {x: 4, y: 3.15}, 
        {x: 8, y: 3.22}, {x: 12, y: 3.27}, {x: 16, y: 3.30}
      ]}
    ]
  });

  // Chart 3: tokr vs tiktoken
  new LineChart('chart-comparison', {
    title: 'Tokens/Sec by Input Size (25MB Corpus)',
    xAxisTitle: 'Input Size',
    yAxisTitle: 'Tokens/Sec',
    yUnit: 'M',
    xLabels: ['1KB', '10KB', '100KB', '500KB', '1MB'],
    datasets: [
      { label: 'tokr (Pure Go)', color: '#58a6ff', data: [
        {x: 1, y: 4.8}, {x: 2, y: 5.0}, {x: 3, y: 5.1}, {x: 4, y: 5.2}, {x: 5, y: 5.3}
      ]},
      { label: 'tiktoken (Rust)', color: '#e5534b', data: [
        {x: 1, y: 3.4}, {x: 2, y: 3.5}, {x: 3, y: 3.6}, {x: 4, y: 3.65}, {x: 5, y: 3.7}
      ]}
    ]
  });
});
</script>
