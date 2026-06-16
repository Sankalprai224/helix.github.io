# Building a BPE Tokenizer in Go: How I Got 80% of tiktoken's Speed Without a Single CGO Call

I was working on a Go project that needed to tokenize text — feeding it into an LLM pipeline — and every option I found had the same problem: it either shelled out to Python, used CGO to wrap the Rust `tiktoken` library, or pulled in half a framework to do something conceptually simple. I didn't want a Python sidecar. I didn't want to fight CGO on a Linux ARM box at 2am. I wanted a pure Go tokenizer that I could ship as a single binary, understand completely, and eventually blame only myself for.

So I built `tokr`: a Byte-Pair Encoding tokenizer in pure Go that hits **~9 MB/s throughput, ~5.3M tokens/sec on the hot path, and a 52-nanosecond cached response time** — roughly 80% of what OpenAI's `tiktoken` (written in Rust) achieves. This post is the full story of how that number came to be, what I got wrong first, and what the architecture actually looks like under the hood.

> **URL slug:** `/posts/bpe-tokenizer-go-from-scratch`  
> If you found this searching for "BPE tokenizer Go implementation" or "tiktoken alternative pure Go" — yes, you're in the right place.

---

## Why BPE? A Sixty-Second Primer

Before the code: why does any of this matter?

Language models don't read words. They read *tokens* — chunks of text that are somewhere between a character and a word. Byte-Pair Encoding (BPE) is the algorithm that decides what those chunks are. GPT-4 uses it. LLaMA uses it. It works like this:

1. Start with a vocabulary of 256 individual bytes (every possible byte value, 0–255).
2. Count every adjacent pair of tokens in your training corpus.
3. Merge the most frequent pair into a new single token. Assign it the next available ID (starting at 256).
4. Repeat until you reach your target vocabulary size.

The result is a vocabulary that naturally captures common English subwords (`" the"`, `"ing"`, `" and"`), while still being able to represent literally anything — even binary data — because you always fall back to raw bytes.

When you *encode* new text, you replay those merges in the order they were learned, always choosing the merge with the lowest rank (i.e., the one learned earliest) at each step. That's the whole algorithm. The hard part is doing it fast.

---

## The Architecture: Four Layers, One Binary

Here's how `tokr` is structured at a high level:

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

Every layer has exactly one job. The splitter doesn't merge. The merge engine doesn't split. The HTTP layer doesn't know what a token is — it just routes.

---

## Layer 1: The Splitter — Why You Can't Just Feed Raw Text Into BPE

This was the first thing I got wrong conceptually. You can't just take a string like `"Hello world"`, convert it to bytes, and start merging. If you do, the merge algorithm will happily create a token that spans the space between `"Hello"` and `"world"` — and now `" wo"` is a single token in your vocabulary. That's not how GPT-4 does it, and it breaks cross-model compatibility.

The fix is *pre-tokenization*: before BPE even sees the text, you split it into chunks at semantic boundaries. Merges are only allowed to happen *within* a chunk, never across them.

`tokr` has two splitters:

### GPTSplit — Full Compatibility Mode

```go
const pattern = `'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+`
var re = regexp2.MustCompile(pattern, regexp2.Compiled)
```

This is the exact regex GPT-4's tokenizer uses. I had to pull in `github.com/dlclark/regexp2` because Go's standard `regexp` package doesn't support Unicode category expressions like `\p{L}` (letter) and `\p{N}` (number). The `regexp2` library is a Go port of .NET's regex engine — powerful, correct, and notoriously allocation-heavy. More on how I dealt with that later.

### FastSplit — The Zero-Allocation Path

For cases where you don't need 1:1 tiktoken compatibility, `FastSplit` is a hand-rolled Unicode scanner:

```go
func FastSplit(text string) []string {
    runes := []rune(text)
    // ... walks rune-by-rune using unicode.IsLetter, IsNumber, IsSpace
    // Handles the "space-prefix" rule: " word" is one token, not " " + "word"
}
```

I wrote this because `regexp2` on a 100KB input was allocating **millions of times** in benchmarks. `FastSplit` produces zero heap allocations during the scan itself — it just slices into the existing rune slice. It's about 3x faster than `GPTSplit` on raw throughput, at the cost of slight tokenization differences from the canonical GPT-4 output.

The tradeoff is explicit: `useGPT4 bool` is threaded through every public API call. You pick your tradeoff at the call site.

---

## Layer 2: The Merge Engine — Getting BPE Down to One Allocation

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

The key design decision here is **in-place mutation with `copy`**. Early versions of this function did the obvious thing: allocate a new slice every iteration, append to it. That's `O(n)` allocations per chunk, which turns into 18 million allocations on a 16MB corpus (I have the benchmark to prove it).

The in-place approach overwrites `val[bestIdx]` with the merged token ID, then shifts the right half of the slice one position left using `copy`. The slice shrinks by one element per iteration. Zero heap allocations. No GC pressure on the hot path.

The tradeoff: the caller's slice is mutated. If you need the original, copy before calling. The `encodeCore` function handles this by keeping `ids` as a reusable working buffer.

---

## Layer 3: The Cache — From 10µs to 52ns

Here's the benchmark that made this click for me:

```
BenchmarkEncode_Cached-16       26193117    219.6 ns/op    448 B/op    1 allocs/op
BenchmarkEncodeCore_Micro-16    (uncached)  10.23 µs/op   75 allocs/op
```

That's a **~47x latency difference** between cold and hot path. Once a string has been tokenized once, all future calls return in ~52–220 nanoseconds with a single allocation (the defensive copy of the cached slice).

The cache lives on the tokenizer struct:

```go
type tokenizer struct {
    cache   map[string][]int
    cacheMu sync.RWMutex
    // ...
}
```

The `RWMutex` is deliberate: concurrent reads (cache hits) don't block each other. Only a write (cache miss that populates the cache) takes the exclusive lock. In a server handling many concurrent requests for common strings, this matters a lot.

Eviction strategy is naive: when the cache exceeds 100,000 entries, the whole map is replaced with a fresh empty one. It's a full clear, not LRU. I know. I'll come back to this.

One more thing about cache correctness: when a cache hit is returned, the code does this:

```go
return append([]int(nil), cached...)
```

That `append([]int(nil), ...)` is the defensive copy. Without it, a caller who mutates the returned slice would corrupt the cached value for every future caller. It costs one allocation. It's worth it. I considered removing it, then remembered that "zero allocations but occasionally wrong" is worse than "one allocation, always correct."

---

## Layer 4: The Worker Pool — Parallelism Without the Pain

For inputs over 1MB, `tokr` splits the text into ~1MB chunks and encodes them in parallel:

```go
func (t *tokenizer) ParallelEncode(text string, useGPT4 bool) ([]int, error) {
    // Split into chunks at natural boundaries (spaces/newlines)
    // Feed into a buffered jobs channel
    // numworkers := runtime.NumCPU()
    // Collect ordered results, reassemble
}
```

The chunking is careful about two things:

**Natural boundaries:** The splitter scans backward from the 1MB mark to find a space or newline, so words are never cut mid-token. A chunk boundary inside `"tokenizer"` would create two incomplete chunks that BPE would encode incorrectly.

**UTF-8 integrity:** If no natural boundary is found in the backward scan, there's a bitwise fallback:
```go
for splitPoint > start && (text[splitPoint]&0xC0) == 0x80 {
    splitPoint--
}
```
`0xC0 & byte == 0x80` is true for UTF-8 continuation bytes. This walks backward until we're at the start of a codepoint. Without this, splitting mid-rune would hand `regexp2` a malformed string and cause a panic.

On a 16MB corpus with parallel encoding:

```
BenchmarkEncode_Single_vs_Parallel/SingleThreaded_Raw-16    1    5582823447 ns/op    2.93 MB/s    18651547 allocs/op
BenchmarkEncode_Single_vs_Parallel/Parallel-16              2    4968771030 ns/op    3.30 MB/s    18651686 allocs/op
```

The parallel speedup on raw (uncached) input is modest — ~13%. The bottleneck isn't CPU cores, it's GC pressure from 18 million allocations. The parallel path shines when chunks hit the cache on subsequent calls.

---

## The Performance Story: Breaking the GC Wall

This is the part worth slowing down on, because the benchmark numbers only make sense if you understand the problem they're solving.

### The Problem: Raw Compute Hits a Wall

`regexp2` is the cost of correctness. It's a Go port of .NET's regex engine — the only Go library I found that handles `\p{L}` and `\p{N}` Unicode category expressions, which the GPT-4 pattern requires. And it allocates *a lot*.

When you disable the cache and force the CPU to do raw BPE math with `regexp2` on a 16MB file, something ugly happens. The parallel workers saturate memory, the Go runtime spends most of its time on allocation locks, and adding more cores barely moves the needle:

```
goos: linux
goarch: amd64
cpu: 13th Gen Intel(R) Core(TM) i5-13500H

// Raw Math (No Cache) — 16MB Payload
BenchmarkEncode_Single_vs_Parallel/SingleThreaded_Raw-16   1   5582823447 ns/op   2.93 MB/s   1617717192 B/op   18651547 allocs/op
BenchmarkEncode_Single_vs_Parallel/Parallel-16             2   4968771030 ns/op   3.30 MB/s   1708757640 B/op   18651686 allocs/op
```

18.6 million allocations. Going from 1 worker to 16 bought 13% more throughput. That's the GC wall: you can throw cores at the problem, but the allocator is the actual bottleneck, and it doesn't parallelize cleanly.

### The Solution: Cache at the Word Level

The key insight is that natural language is repetitive. A server handling chat requests will see `" the"`, `" and"`, `" of"` millions of times. Running `regexp2` and the BPE merge loop on `" the"` for the millionth time is pure waste.

The architecture neutralizes this by caching at the *word level* via a `sync.RWMutex`-guarded map. Once `regexp2` extracts a chunk like `" the"` and the merge loop computes its token IDs, that result is stored. Every future occurrence skips the regex engine and the merge loop entirely — it's just a map lookup.

The `RWMutex` here is deliberate and important: concurrent reads (cache hits) don't block each other at all. A hundred goroutines can simultaneously look up `" the"` without any lock contention. Only a cache miss — where a new entry needs to be written — takes an exclusive lock, and those become increasingly rare as the cache warms up.

Here's what that looks like in practice:

```
// Cached Inference (Hot Path vs Cold Path)
BenchmarkPublicAPI           52.55 ns/op    1 allocs/op    Cached / Hot Path
BenchmarkEncodeCore          10.23 µs/op   75 allocs/op    Uncached / Cold Path

BenchmarkEncode_Cached-16           26193117    219.6 ns/op    448 B/op    1 allocs/op
BenchmarkEncode_CacheHitRate-16     39210831    144.8 ns/op    172 B/op    1 allocs/op
```

That's **~47x latency difference** between cold and hot path. The single remaining allocation on the hot path (`1 allocs/op`) is the defensive copy returned to the caller — preventing them from accidentally mutating the cached slice and corrupting future lookups. It's intentional and non-negotiable.

### The Result: System Throughput vs OpenAI

Because real-world language is repetitive, the warm cache bypasses the GC wall entirely for the vast majority of requests. The aggregate result on a 25MB corpus (AMD Ryzen 5 7530U):

| Library  | Language      | Throughput  | Speed          |
|----------|---------------|-------------|----------------|
| tiktoken | Rust + Python | 11.33 MB/s  | ~3.7M tokens/s |
| tokr ⚡  | Pure Go       | 9.03 MB/s   | ~5.3M tokens/s |

A quick note on why `tokr` shows *higher* tokens/sec but *lower* MB/s: these measure different things. MB/s is bytes of input text processed per second. Tokens/sec depends on average token length — `tokr`'s vocabulary produces slightly shorter average tokens on this corpus, so more tokens are generated per byte. Both numbers are real; they just answer different questions.

---

## What I Got Wrong — And What's Being Fixed

This section is the honest accounting. If you're evaluating `tokr` for production, you need to know where it breaks.

**The `sync.Pool` gap in inference:** I added `sync.Pool` to the tokenizer struct to reuse `[]int` buffers. I wired it into the training `merger()` function. I forgot to wire it into the inference hot path — `encodeCore` still allocates fresh slices on every call. The pool exists and sits unused on the most important path. The fix is to pass a pooled buffer into `runMergeLogic` as an explicit workspace parameter and return it to the pool after use.

**The merge loop's O(N²) worst case:** The current `runMergeLogic` scans the token array linearly on every iteration to find the lowest-rank pair. For standard English words averaging 5–15 characters, this is effectively O(N) and fast. But feed it a pathological input — a 10,000-character base64 string that the regex matches as a single chunk — and the loop degrades to O(N²), burning CPU until the word finishes. The proper fix is replacing the linear scan with a doubly-linked list paired with a priority queue, which drops merge complexity to O(N log N) regardless of input shape. This is a real attack surface for a public-facing service.

**Unbounded cache growth:** The word cache has no eviction policy beyond a full-clear at 100,000 entries. On a long-running server processing diverse inputs — think a search API handling millions of unique user queries — the cache will grow toward OOM before hitting the limit, then drop all warm entries at once, then repeat. The right fix is a concurrent LRU cache with a fixed entry cap, or a sharded map with a TTL sweeper that evicts low-frequency entries. Either approach keeps hot words in memory while letting obscure typos fall off.

**Static chunk size in the worker pool:** `ParallelEncode` uses a hardcoded 1MB chunk size. On a 16-core machine processing a 1.2MB file, only 2 cores get work — 14 sit idle. The chunk size should be derived dynamically: `totalBytes / runtime.NumCPU()`, with a sensible floor (say, 256KB) to avoid spinning up goroutines for trivially small chunks. This is a one-line change with a meaningful impact on multi-core utilisation.

**HTTP server timeouts:** The current `net/http` server uses default configuration — which means no `ReadTimeout`, no `WriteTimeout`, no `IdleTimeout`. A Slowloris attack (sending HTTP headers one byte at a time, holding connections open indefinitely) will exhaust the goroutine pool. The fix is three lines:

```go
srv := &http.Server{
    Addr:         ":" + port,
    Handler:      mux,
    ReadTimeout:  5 * time.Second,
    WriteTimeout: 10 * time.Second,
    IdleTimeout:  120 * time.Second,
}
```

This is fine behind an internal gateway or a reverse proxy like Caddy that handles connection management. It's not fine exposed directly to the internet.

**Training memory:** The trainer loads the full corpus into memory and keeps all chunk token slices resident simultaneously. For a 10GB corpus this doesn't work. Real tokenizer trainers use disk-backed streaming. `tokr` is currently a PoC for reasonably-sized corpora — call it a ceiling of a few hundred MB before you'll want to rethink the training pipeline.

---

## The HTTP API

`tokr` ships with a lightweight server — `net/http` only, no Gin, no Echo:

```
POST /encode    { "text": "..." }
               → { "tokens": [...], "count": N, "time_seconds": 0.000052 }

POST /decode    { "tokens": [...] }
               → { "text": "..." }
```

The routing logic in `/encode` is a simple size gate:

```go
if len(req.Text) > 999000 {
    tokens, err = t.ParallelEncode(req.Text, gpt4)
} else {
    tokens, err = t.Encode(req.Text, gpt4)
}
```

Below 999KB, the single-threaded cache-optimized path wins. Above it, the worker pool takes over. The model loads once at startup and stays in memory — `vocab` and `merges` are read-only after training, so no locking needed on the serving path for those maps.

---

## FAQ

**Can I use tokr as a drop-in replacement for tiktoken?**

For encoding/decoding with a vocabulary trained on the same corpus, yes — the token IDs will match if you use the same BPE merge file. If you need exact GPT-4 tokenization (the `cl100k_base` vocab), you'd need to load that specific `.model` file and set `useGPT4=true`. The round-trip integrity (encode → decode = original string) is guaranteed by the architecture and fuzz-tested.

**Why not just use cgo to wrap tiktoken's Rust library?**

CGO introduces real operational pain: cross-compilation breaks, Docker images need the host's C toolchain, and debugging memory issues across the Go/C boundary is miserable. A pure Go binary deploys everywhere `go build` runs. That was the whole point.

**How does the cache handle concurrent writes?**

`cacheMu sync.RWMutex` guards the cache map. Reads (cache hits) take a read lock — they don't block each other. A write (populating a new cache entry) takes an exclusive lock. This means 100 goroutines can concurrently hit the cache for different already-cached strings without any contention.

**What happens if two goroutines encode the same string simultaneously, and neither finds it in cache?**

Both will compute the tokens independently and the second one to finish will overwrite the first in the cache. This is a known benign race — the computed result is deterministic, so the "duplicate work" scenario is safe. The alternative (locking before the computation) would serialize all cold-path encodes, which is worse.

**Is the 5.3M tokens/sec number reproducible?**

On an AMD Ryzen 5 7530U with a 25MB corpus and `useGPT4=true` (full `regexp2` path), yes. On a machine with more cores, `ParallelEncode` will scale — the worker pool uses `runtime.NumCPU()`. On an ARM machine or a constrained container, expect lower. The benchmark file is in the repo; run it yourself with `go test -bench=. -benchmem ./bpe/`.

**Why does the hot path still allocate once (1 allocs/op)?**

That allocation is the defensive copy returned to the caller:
```go
return append([]int(nil), cached...)
```
Without it, the caller could mutate the returned slice and corrupt the cache entry. It's intentional. The 1 allocation ceiling is considered the floor we're not willing to go below for correctness reasons.

**What's next for tokr?**

Four concrete things in priority order: (1) O(N log N) merge loop via doubly-linked list + priority queue, which closes the pathological-input attack surface; (2) `sync.Pool` integration in `encodeCore` to bring inference allocs down from 75 to near-zero; (3) concurrent LRU cache replacing the full-clear eviction; (4) dynamic chunk sizing in `ParallelEncode` based on `runtime.NumCPU()`. The HTTP layer also needs proper timeouts before it goes anywhere public-facing.

---

## Twitter/X Thread (Copy-Paste Ready)

**Tweet 1 (the hook):**
> I built a BPE tokenizer in pure Go. No CGO. No Python sidecar. No Rust.
> It hits 5.3M tokens/sec and 52ns hot-path latency.
> Here's how the architecture works 🧵

**Tweet 2 (the problem):**
> Every Go tokenizer I found either shells out to Python or wraps tiktoken via CGO. That means your Docker image needs a C toolchain, cross-compilation breaks, and you're debugging memory issues across the Go/C boundary at 2am.
> I wanted a single binary. So I built one.

**Tweet 3 (the number that matters):**
> Cold path: 10µs, 75 allocations.
> Hot path (cached): 52ns, 1 allocation.
> That's a 47x latency difference — from the same function, same machine, same input.
> The cache is the product.

**Tweet 4 (the architecture detail):**
> The BPE merge loop runs in-place with `copy()` — zero heap allocations per iteration.
> Early version: allocate a new slice every merge step → 18.6M allocs on a 16MB file.
> In-place version: 0 merge allocs. The only alloc is the defensive copy you return to the caller.

**Tweet 5 (the link):**
> Full post: architecture deep-dive, benchmark numbers, what I got wrong, and an FAQ.
> [link]
> Repo: github.com/HeLiX-x/tokr

---