# Bought Or Not

A decentralised, trust-based decision engine that helps you decide whether to purchase any good or service, based on your values and the knowledge of people and organisations you trust.

## The problem

We all make purchasing decisions every day. Not all of them need deep thinking — sometimes we can trust someone else's judgement. But reading every label, researching every company, and cross-referencing every claim is impractical. What if you could scan a barcode and instantly know whether a product aligns with your values?

## How it works

Each user publishes three types of statements as Markdown files in a git repository:

### Information

Facts about products, producers, or practices, each with a certainty percentage. If certainty is not stated, it is assumed to be 100%.

Information can be **static** (direct statements) or **API-backed** (instructions for fetching data from an external API at query time).

Static example: "Nutella (barcode 3017620422003) made by Ferrero is not certified organic, certainty 100%"

API-backed example: "To check if a food product is certified organic, call GET https://example.com/api/product/{barcode}.json and look at the `labels_tags` array..."

### Rules

Preferences that influence purchasing decisions, each with a weight between 0 and 100.

Example: "I weigh 60 eating food certified to be organic"

### Trust

How much you trust another user's information and/or rules, scoped by context. Users are identified by their git repository URL.

Example: "I trust the information and rules at https://github.com/giacecco/bought-or-not-test-soil-association 90%"

## Key principles

- **Positive framing.** Statements should be expressed positively where possible. The app helps users rephrase negative statements into positive ones. When this is awkward (e.g. "Nutella is not certified organic, certainty 100%"), the app converts negatives to positive form internally.

- **Transitive trust.** If A trusts B at 80% and B trusts C at 60%, then A trusts C at 48%. Trust chain traversal stops when trust or certainty drops below a configurable threshold (default 1%).

- **Ordering matters.** Statements listed earlier take priority over later ones. This applies to information, rules, and trust. Combined with trust hops (fewer hops = higher priority), this resolves conflicts without extra syntax.

- **Trust is context-scoped.** The same user can be trusted at different levels for different topics. Publishers define the context of their statements. The consumer's LLM validates consistency between a context and its contents, warning if mismatched.

- **Any source is valid.** Product data can come from authoritative organisations, crowdsourced databases, or individuals — each assigned a suitable trust percentage.

## Scoring formula

When you query a product, the system:

1. Collects all relevant rules from your repo and trusted sources. Trust context scoping ensures that rules are only collected from a trusted repo when their context matches the trust edge's context (e.g., trusting someone for "Organic food" only collects their organic-related rules). The LLM determines context matches.
2. For each rule, finds all relevant information from trusted sources (also context-scoped).
3. For each source, the LLM determines how much the information satisfies the rule (satisfaction). Scales by trust: `effective_certainty = trust × satisfaction`.
4. Sources are split into "for" (satisfaction > 50%) and "against" (satisfaction ≤ 50%). Each group is combined using "at least one is right": `combined = 1 - Π(1 - effective_certainty_i)`. For the "against" group, satisfaction is inverted to get anti-certainty. The net result is `combined_for - combined_against`, clamped to [0, 100]. This means contradictory evidence reduces the score rather than being silently ignored.
5. Rules with no matching information are excluded from the score (reported as "no data available" rather than dragging the score toward zero).
6. Computes the weighted average: `score = Σ(weight × combined_certainty) / Σ(weight)`. If all rules lack data, the verdict is "Insufficient data".
7. When multiple trust paths reach the same repo (diamond topology), the highest-trust path is used.

A high score means buying is the right choice. A low score means it isn't.

## Repository structure

Each user's repository contains:

```
trust.md              — who you trust, scoped by context
rules.md              — what you care about, with weights
information.md        — facts you know (or information/ directory for large publishers)
```

Best practice: include an about-us section or file describing who the publisher is.

### Nicknames

Users are identified by their git repository URL, but URLs are hard to read. Any file can declare nicknames at the top using Markdown reference link syntax:

```
[the Soil Association]: https://github.com/giacecco/bought-or-not-test-soil-association
```

The nickname can then be used naturally throughout the file in any statement. Each file declares its own nicknames.

All files include the comment: `<!-- Statements listed earlier take priority over later ones -->`

For a complete worked example with five users (including an API-backed source), see the test repos listed in CLAUDE.md.

### API-backed information

Instead of writing static statements, an information publisher can describe how to fetch data from an external API. Each context section contains instructions: which URL to call (with `{barcode}` as a placeholder), which fields to inspect, and how to interpret the response.

At query time, the system calls the API for the specific barcode being evaluated, then uses the LLM to interpret the response according to the instructions and produce concrete statements. This allows large databases like Open Food Facts to participate as information sources without mirroring their entire dataset into Markdown.

## Role of the LLM

The LLM is used at both ingestion time (parsing natural language Markdown into computable data) and query time (reasoning over statements to produce a score, and interpreting API responses for API-backed information sources). The LLM does not browse the web or contribute its own information — it only works with what is in the repositories and what is returned by API calls described in those repositories.

## CLI prototype

A working prototype is available as a Bun/TypeScript CLI.

### Usage

```bash
bun install
bun run index.ts --user <repo-url> --barcode <barcode>
```

### Options

- `--user` — GitHub repo URL of the user
- `--barcode` — Product barcode to evaluate
- `--threshold` — Trust/certainty cutoff % (default: 1)
- `--test` — Use Claude Code CLI instead of the Anthropic API (no API key needed, uses your Claude subscription)
- `--no-cache` — Clear cache and fetch fresh repos
- `--buy-threshold` — Score threshold for Buy verdict (default: 50)

### Caching

Three layers of caching in `.cache/`, all with 24-hour TTL:

1. **Repo clones + parsed results** — skip git clone and LLM parsing on repeat runs
2. **API responses** — skip external API calls (e.g. Open Food Facts) for the same barcode
3. **Full assessments** — skip everything: instant results with full breakdown from cache

Use `--no-cache` to clear all caches and force a fresh run.

### Examples

```bash
# Nutella — not organic, contains palm oil, questionable tax practices → Don't buy (0.0%)
bun run index.ts --test --user https://github.com/giacecco/bought-or-not-test-giacecco --barcode 3017620422003

# Nocciolata — organic, palm-oil-free, no tax data available → Buy (100.0%)
bun run index.ts --test --user https://github.com/giacecco/bought-or-not-test-giacecco --barcode 8052575090254
```

### LLM backends

- **API** (default): requires an `ANTHROPIC_API_KEY` in `.env`
- **CLI** (`--test`): shells out to `claude -p`, using your Claude Code / Max subscription

## The app (future)

- Scan a product barcode to get a score in real time.
- A simple breakdown of contributing rules and sources is available but not forced on the user.
- Users can set a personal buy/don't-buy threshold.
- Offline caching is on by default (can be toggled off to save storage).
- Applies to any purchasable good or service.
