---
layout: post
title: "Building a BPE Tokenizer in Go: How I Got 80% of tiktoken's Speed Without a Single CGO Call"
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

```
Input Text
     │
     ▼
┌─────────────────────────────┐
│       Splitter Module       │  ← Pre-tokenization boundary enforcement
│  GPTSplit (regexp2) or      │
│  FastSplit (custom scanner) │
└────────────┬────────────────┘
             │  []string chunks
             ▼
┌─────────────────────────────┐
│       BPE Engine            │  ← runMergeLogic, in-place slice mutation
│  Cache check (O(1) RWMutex) │
│  Rank-based merge loop      │
└────────────┬────────────────┘
             │
     ┌───────┴────────┐
     │                │
     ▼                ▼
Single-threaded   Worker Pool
  Encode()       ParallelEncode()
                 (runtime.NumCPU workers,
                  buffered channels)
             │
             ▼
┌─────────────────────────────┐
│       HTTP Layer            │  ← net/http, no framework
│  /encode  /decode           │
│  Smart routing: <999KB      │
│  → single, ≥999KB → pool   │
└─────────────────────────────┘
```

Every layer has exactly one job. The splitter doesn't merge. The merge engine doesn't split. The HTTP layer doesn't know what a token is; it just routes.

---

## Layer 1: The Splitter

This was the first thing I got wrong conceptually. You can't just take a string like `"Hello world"`, convert it to bytes, and start merging. If you do, the merge algorithm will happily create a token that spans the space between `"Hello"` and `"world"`. Now `" wo"` is a single token in your vocabulary. That's not how GPT-4 does it, and it breaks cross-model compatibility.

The fix is pre-tokenization. Before BPE even sees the text, you split it into chunks at semantic boundaries. Merges are only allowed to happen *within* a chunk, never across them.

`tokr` has two splitters.

### GPTSplit: Full Compatibility Mode

```go
const pattern = `'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`
var re = regexp2.MustCompile(pattern, regexp2.Compiled)
```

This is the exact regex GPT-4's tokenizer uses. I had to pull in `github.com/dlclark/regexp2` because Go's standard `regexp` package doesn't support Unicode category expressions like `\p{L}` (letter) and `\p{N}` (number). The `regexp2` library is a Go port of .NET's regex engine. It's powerful, correct, and notoriously allocation-heavy. I'll explain how I dealt with that later.

### FastSplit: The Zero-Allocation Path

For cases where you don't need 1:1 tiktoken compatibility, `FastSplit` is a hand-rolled Unicode scanner:

```go
func FastSplit(text string) []string {
    runes := []rune(text)
    // ... walks rune-by-rune using unicode.IsLetter, IsNumber, IsSpace
    // Handles the "space-prefix" rule: " word" is one token, not " " + "word"
}
```

I wrote this because `regexp2` on a 100KB input was allocating millions of times in benchmarks. `FastSplit` produces zero heap allocations during the scan itself. It just slices into the existing rune slice. It's about 3x faster than `GPTSplit` on raw throughput, at the cost of slight tokenization differences from the canonical GPT-4 output.

The tradeoff is explicit here. `useGPT4 bool` is threaded through every public API call. You pick your tradeoff at the call site.

---

## Layer 2: The Merge Engine

The core of the tokenizer is `runMergeLogic`. This is where the actual BPE encoding happens for a single pre-tokenized chunk:

```go
func runMergeLogic(t *tokenizer, val []int) []int {
    for {
        if len(val) < 2 {
            break
        }
        bestIdx := -1
        minrank := math.MaxInt

        // Scan for the lowest-rank mergeable pair
        for i := 0; i < len(val)-1; i++ {
            p := pair{val[i], val[i+1]}
            if rank, ok := t.merges[p]; ok {
                if rank < minrank {
                    minrank = rank
                    bestIdx = i
                }
            }
        }
        if bestIdx == -1 {
            break
        }

        // Merge in-place: overwrite left element, shift everything left
        val[bestIdx] = minrank
        copy(val[bestIdx+1:], val[bestIdx+2:])
        val = val[:len(val)-1]
    }
    return val
}
```

The key design decision here is in-place mutation with `copy`. Early versions of this function did the obvious thing: allocate a new slice every iteration, append to it. That's O(n) allocations per chunk, which turns into 18 million allocations on a 16MB corpus.

The in-place approach overwrites `val[bestIdx]` with the merged token ID, then shifts the right half of the slice one position left using `copy`. The slice shrinks by one element per iteration. Zero heap allocations. No GC pressure on the hot path.

The tradeoff is that the caller's slice is mutated. If you need the original, you have to copy it before calling. The `encodeCore` function handles this by keeping `ids` as a reusable working buffer.

---

## Layer 3: The Cache

Here's the benchmark that made this click for me:

```
BenchmarkEncode_Cached-16       26193117    219.6 ns/op    448 B/op    1 allocs/op
BenchmarkEncodeCore_Micro-16    (uncached)  10.23 µs/op   75 allocs/op
```

That's roughly a 47x latency difference between cold and hot path. Once a string has been tokenized once, all future calls return in ~52–220 nanoseconds with a single allocation.

The cache lives on the tokenizer struct:

```go
type tokenizer struct {
    cache   map[string][]int
    cacheMu sync.RWMutex
    // ...
}
```

The `RWMutex` is deliberate. Concurrent reads (cache hits) don't block each other. Only a write (a cache miss that populates the cache) takes the exclusive lock. In a server handling many concurrent requests for common strings, this matters a lot.

Eviction strategy is naive right now. When the cache exceeds 100,000 entries, the whole map is replaced with a fresh empty one. It's a full clear, not LRU. I know. I'll fix this later.

One more thing about cache correctness. When a cache hit is returned, the code does this:

```go
return append([]int(nil), cached...)
```

That `append([]int(nil), ...)` is the defensive copy. Without it, a caller who mutates the returned slice would corrupt the cached value for every future caller. It costs one allocation. It's absolutely worth it. I considered removing it, then remembered that "zero allocations but occasionally wrong" is a lot worse than "one allocation, always correct."

---

## Layer 4: The Worker Pool

For inputs over 1MB, `tokr` splits the text into ~1MB chunks and encodes them in parallel:

```go
func (t *tokenizer) ParallelEncode(text string, useGPT4 bool) ([]int, error) {
    // Split into chunks at natural boundaries (spaces/newlines)
    // Feed into a buffered jobs channel
    // Collect ordered results, reassemble
}
```

The chunking is careful about two things:

1. **Natural boundaries:** The splitter scans backward from the 1MB mark to find a space or newline so words are never cut mid-token. A chunk boundary inside `"tokenizer"` would create two incomplete chunks that BPE would encode incorrectly.
2. **UTF-8 integrity:** If no natural boundary is found in the backward scan, there's a bitwise fallback to ensure we don't split mid-rune and hand `regexp2` a malformed string that causes a panic.

On a 16MB corpus with parallel encoding:

```
BenchmarkEncode_Single_vs_Parallel/SingleThreaded_Raw-16    1    5582823447 ns/op    2.93 MB/s    18651547 allocs/op
BenchmarkEncode_Single_vs_Parallel/Parallel-16              2    4968771030 ns/op    3.30 MB/s    18651686 allocs/op
```

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

| Library  | Language      | Throughput  | Speed          |
|----------|---------------|-------------|----------------|
| tiktoken | Rust + Python | 11.33 MB/s  | ~3.7M tokens/s |
| tokr     | Pure Go       | 9.03 MB/s   | ~5.3M tokens/s |

A quick note on why `tokr` shows higher tokens/sec but lower MB/s. These measure different things. MB/s is bytes of input text processed per second. Tokens/sec depends on average token length. `tokr`'s vocabulary produces slightly shorter average tokens on this corpus, so more tokens are generated per byte. Both numbers are real; they just answer different questions.

---

## What I Got Wrong

If you're evaluating `tokr` for production, you need to know where it breaks.

**The `sync.Pool` gap in inference:** I added `sync.Pool` to the tokenizer struct to reuse `[]int` buffers. I wired it into the training `merger()` function. I forgot to wire it into the inference hot path. `encodeCore` still allocates fresh slices on every call. The fix is to pass a pooled buffer into `runMergeLogic` as an explicit workspace parameter and return it to the pool after use.

**The merge loop's O(N²) worst case:** The current `runMergeLogic` scans the token array linearly on every iteration to find the lowest-rank pair. For standard English words averaging 5–15 characters, this is effectively O(N) and fast. But feed it a pathological input, like a 10,000-character base64 string that the regex matches as a single chunk, and the loop degrades to O(N²). It burns CPU until the word finishes. The proper fix is replacing the linear scan with a doubly-linked list paired with a priority queue.

**Unbounded cache growth:** The word cache has no eviction policy beyond a full-clear at 100,000 entries. On a long-running server processing diverse inputs, the cache will grow toward OOM before hitting the limit, then drop all warm entries at once. The right fix is a concurrent LRU cache with a fixed entry cap.

**Static chunk size in the worker pool:** `ParallelEncode` uses a hardcoded 1MB chunk size. On a 16-core machine processing a 1.2MB file, only 2 cores get work. 14 sit idle. The chunk size should be derived dynamically based on available cores.

**HTTP server timeouts:** The current `net/http` server uses default configuration, which means no read, write, or idle timeouts. A Slowloris attack will exhaust the goroutine pool immediately. 

---

## The HTTP API

`tokr` ships with a lightweight server (`net/http` only, no frameworks):

```
POST /encode    { "text": "..." }
               → { "tokens": [...], "count": N, "time_seconds": 0.000052 }

POST /decode    { "tokens": [...] }
               → { "text": "..." }
```

The routing logic in `/encode` is a simple size gate. Below 999KB, the single-threaded cache-optimized path wins. Above it, the worker pool takes over. The model loads once at startup and stays in memory.

---

## FAQ

**Can I use tokr as a drop-in replacement for tiktoken?**

For encoding/decoding with a vocabulary trained on the same corpus, yes. The token IDs will match if you use the same BPE merge file. If you need exact GPT-4 tokenization (the `cl100k_base` vocab), you'd need to load that specific `.model` file and set `useGPT4=true`. 

**Why not just use cgo to wrap tiktoken's Rust library?**

CGO introduces real operational pain. Cross-compilation breaks, Docker images need the host's C toolchain, and debugging memory issues across the Go/C boundary is miserable. A pure Go binary deploys everywhere `go build` runs. That was the whole point.

**How does the cache handle concurrent writes?**

`cacheMu sync.RWMutex` guards the cache map. Reads (cache hits) take a read lock, so they don't block each other. A write (populating a new cache entry) takes an exclusive lock. This means 100 goroutines can concurrently hit the cache for different already-cached strings without any contention.

**What happens if two goroutines encode the same string simultaneously, and neither finds it in cache?**

Both will compute the tokens independently and the second one to finish will overwrite the first in the cache. This is a known benign race. The computed result is deterministic, so the "duplicate work" scenario is safe. 

**Is the 5.3M tokens/sec number reproducible?**

On an AMD Ryzen 5 7530U with a 25MB corpus and `useGPT4=true` (full `regexp2` path), yes. On a machine with more cores, `ParallelEncode` will scale because the worker pool uses `runtime.NumCPU()`. 

**What's next for tokr?**

Four concrete things in priority order: 
1. O(N log N) merge loop via doubly-linked list and priority queue.
2. `sync.Pool` integration in `encodeCore` to bring inference allocs down.
3. Concurrent LRU cache replacing the full-clear eviction.
4. Dynamic chunk sizing in `ParallelEncode` based on core count. 

The HTTP layer also needs proper timeouts before it goes anywhere public-facing.
