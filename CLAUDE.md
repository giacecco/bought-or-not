# CLAUDE.md

## Project overview
Bought Or Not is a decentralised, trust-based decision engine for purchasing decisions. See README.md for the full concept.

## Key design decisions
- All statements (information, rules, trust) are Markdown in git repos
- Scoring uses the "at least one is right" formula for combining certainties: `1 - Π(1 - effective_certainty_i)`
- Statement ordering in Markdown determines priority (earlier = higher priority)
- Trust is transitive, context-scoped, and stops propagating below a configurable threshold (default 1%)
- The LLM parses and reasons over statements but never contributes its own information

## Project structure
- `README.md` — concept and specification
- `examples/` — worked example with four users (giacecco, paola, soil-association, robert-leach) demonstrating the Nutella scenario
