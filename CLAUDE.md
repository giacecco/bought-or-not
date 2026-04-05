# CLAUDE.md

## Project overview
Bought Or Not is a decentralised, trust-based decision engine for purchasing decisions. See README.md for the full concept and scoring formula.

## Tech stack
- **Runtime:** Bun (not Node.js)
- **Language:** TypeScript
- **LLM:** Claude via @anthropic-ai/sdk (API backend) or `claude -p` CLI (test backend)
- **Model selection:** Opus for natural language interpretation (parsing information, matching info to rules, reasoning about satisfaction). Haiku for structural tasks (parsing trust/rules, finding relevant info by barcode).

## Project structure
- `README.md` — concept, specification, and CLI usage docs
- `CLAUDE.md` — this file
- `index.ts` — CLI entry point, orchestrates fetch → parse → score → output
- `src/llm.ts` — shared LLM call layer with two backends: API and CLI (`claude -p`)
- `src/fetcher.ts` — clones repos, caches them in `.cache/` for 24 hours, caches parsed results
- `src/parser.ts` — sends Markdown files to LLM, returns structured data (ParsedInfo, ApiInfo, ParsedRule, ParsedTrust)
- `src/resolver.ts` — resolves API-backed information at query time: calls external APIs and uses LLM to interpret responses into ParsedInfo
- `src/scorer.ts` — trust graph traversal, rule collection, information matching, scoring formula
- `scripts/generate-off-repo.ts` — generates a Bought Or Not repo from Open Food Facts data (used for initial prototyping, superseded by API-backed approach)
- `.env` — Anthropic API key (gitignored)
- `.cache/` — cached repos, parsed results, API responses, and assessment results (all 24h TTL, gitignored)

## Test repos
Five public GitHub repos serve as test data:
- https://github.com/giacecco/bought-or-not-test-giacecco
- https://github.com/giacecco/bought-or-not-test-paola
- https://github.com/giacecco/bought-or-not-test-soil-association
- https://github.com/giacecco/bought-or-not-test-robert-leach
- https://github.com/giacecco/bought-or-not-test-open-food-facts (API-backed information source)

## Key design decisions
- All statements (information, rules, trust) are Markdown in git repos
- Users are identified by their git repository URL
- Nicknames for repo URLs use Markdown reference link syntax, declared per file
- Scoring uses the "at least one is right" formula for combining certainties: `1 - Π(1 - effective_certainty_i)`
- Statement ordering in Markdown determines priority (earlier = higher priority), both within a file and across trust hops
- Trust is transitive, context-scoped, and stops propagating below a configurable threshold (default 1%)
- Negative statements are allowed in Markdown when positive framing is awkward; the LLM converts them internally
- The LLM parses and reasons over statements but never contributes its own information
- Product-to-producer links are embedded inline in information statements
- Information can be API-backed: instead of static statements, a repo's information.md can describe how to fetch data from an external API (with a URL template using `{barcode}` and instructions for interpreting the response). The system calls the API at query time and uses the LLM to produce concrete statements from the response.
- Three layers of caching (all 24h TTL, cleared by `--no-cache`): repo clones + parsed results, external API responses, and full assessment results (score + all sources)
- Output uses nicknames (from the user's trust.md reference links) instead of raw repo URLs
- Output distinguishes certainty (truth of the fact) from satisfaction (whether the rule is met)

## Workflow
- Before every commit, check if `README.md` and `CLAUDE.md` need updating and update them if there are relevant changes (new features, CLI flags, files, design decisions, expected output, etc.)

## Running
```bash
bun install
# With API key in .env:
bun run index.ts --user <repo-url> --barcode <barcode>
# With Claude Code CLI (no API key needed):
bun run index.ts --test --user <repo-url> --barcode <barcode>
# Force fresh fetch:
bun run index.ts --no-cache --user <repo-url> --barcode <barcode>
```

## Expected test output
Running with `--user https://github.com/giacecco/bought-or-not-test-giacecco --barcode 3017620422003` (Nutella) should produce a score of **4.6%** with verdict "Don't buy".
