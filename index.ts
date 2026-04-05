import { parseArgs } from "util";
import { fetchRepo, clearCache, getCachedParsed, saveParsedCache } from "./src/fetcher";
import { parseRepoFiles, type ParsedRepo } from "./src/parser";
import { computeScore } from "./src/scorer";
import { setBackend } from "./src/llm";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    user: { type: "string" },
    barcode: { type: "string" },
    threshold: { type: "string", default: "1" },
    test: { type: "boolean", default: false },
    "no-cache": { type: "boolean", default: false },
  },
  strict: true,
});

if (!values.user || !values.barcode) {
  console.error("Usage: bun run index.ts --user <repo-url> --barcode <barcode>");
  console.error("       bun run index.ts --test --user <repo-url> --barcode <barcode>");
  console.error("  --user       GitHub repo URL of the user");
  console.error("  --barcode    Product barcode to evaluate");
  console.error("  --threshold  Trust/certainty cutoff % (default: 1)");
  console.error("  --test       Use Claude Code CLI instead of API (no API key needed)");
  console.error("  --no-cache   Clear cache and fetch fresh repos");
  process.exit(1);
}

if (values.test) {
  setBackend("cli");
  console.log("\nUsing Claude Code CLI backend (no API key needed).\n");
}

if (values["no-cache"]) {
  await clearCache();
  console.log("  Cache cleared.\n");
}

const threshold = parseFloat(values.threshold!);

console.log(`Fetching repos and walking trust chain...\n`);

const parsedRepos = new Map<string, ParsedRepo>();
const inFlight = new Set<string>();

async function fetchAndParse(repoUrl: string): Promise<void> {
  if (parsedRepos.has(repoUrl) || inFlight.has(repoUrl)) return;
  inFlight.add(repoUrl);

  // Check for cached parsed result first
  const cachedParsed = await getCachedParsed(repoUrl);
  if (cachedParsed) {
    console.log(`  Using cached + parsed ${repoUrl}`);
    parsedRepos.set(repoUrl, cachedParsed);
    // Walk trust edges in parallel
    const nextUrls = cachedParsed.trust
      .filter((t) => t.trustPercent >= threshold)
      .map((t) => t.repoUrl);
    await Promise.all(nextUrls.map(fetchAndParse));
    return;
  }

  // Fetch and parse
  const repoFiles = await fetchRepo(repoUrl);
  console.log(`  Parsing ${repoUrl}...`);
  const parsed = await parseRepoFiles(repoUrl, repoFiles.files);
  parsedRepos.set(repoUrl, parsed);
  await saveParsedCache(repoUrl, parsed);

  // Walk trust edges in parallel
  const nextUrls = parsed.trust
    .filter((t) => t.trustPercent >= threshold)
    .map((t) => t.repoUrl);
  await Promise.all(nextUrls.map(fetchAndParse));
}

await fetchAndParse(values.user);

console.log(`\nLoaded ${parsedRepos.size} repos. Computing score...\n`);

const result = await computeScore(
  values.barcode,
  Array.from(parsedRepos.values()),
  values.user,
  threshold
);

// Display results
console.log(`═══════════════════════════════════════════`);
console.log(`  Bought Or Not — Score: ${result.score.toFixed(1)}%`);
console.log(`═══════════════════════════════════════════\n`);

if (result.ruleScores.length === 0) {
  console.log("  No rules found relevant to this product.\n");
} else {
  for (const rs of result.ruleScores) {
    console.log(`  Rule: "${rs.rule.statement}" (weight: ${rs.rule.weight})`);
    console.log(`  Context: ${rs.rule.context}`);
    console.log(`  Satisfaction: ${rs.combinedCertainty.toFixed(1)}%`);
    if (rs.sources.length === 0) {
      console.log(`  Sources: none found`);
    } else {
      for (const s of rs.sources) {
        console.log(
          `    - ${s.repoUrl}: "${s.statement}" (certainty ${s.certainty.toFixed(0)}%, trust ${s.trust.toFixed(0)}%, effective ${s.effectiveCertainty.toFixed(1)}%)`
        );
      }
    }
    console.log();
  }
}

console.log(`  Total weight: ${result.totalWeight}`);
console.log(
  `  Verdict: ${result.score >= 50 ? "Buy" : "Don't buy"} (${result.score.toFixed(1)}%)\n`
);
