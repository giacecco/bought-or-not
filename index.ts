import { parseArgs } from "util";
import { fetchRepo, clearCache, getCachedParsed, saveParsedCache, getCachedAssessment, saveAssessmentCache, type CachedAssessment } from "./src/fetcher";
import { parseRepoFiles, type ParsedRepo } from "./src/parser";
import { resolveApiInfo } from "./src/resolver";
import { computeScore, type ScoreResult } from "./src/scorer";
import { setBackend } from "./src/llm";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    user: { type: "string" },
    barcode: { type: "string" },
    threshold: { type: "string", default: "1" },
    test: { type: "boolean", default: false },
    "no-cache": { type: "boolean", default: false },
    "buy-threshold": { type: "string", default: "50" },
    "hop-decay": { type: "string", default: "5" },
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
  console.error("  --buy-threshold  Score threshold for Buy verdict (default: 50)");
  console.error("  --hop-decay  Trust reduction % per hop after the first (default: 5)");
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
const buyThreshold = parseFloat(values["buy-threshold"]!);
const hopDecay = parseFloat(values["hop-decay"]!) / 100;

function displayResult(result: ScoreResult, nicknames: Record<string, string>, cached: boolean, buyThreshold: number) {
  const name = (url: string) => nicknames[url] || url;

  console.log(`═══════════════════════════════════════════`);
  if (result.score < 0) {
    console.log(`  Bought Or Not — Insufficient data${cached ? " (cached)" : ""}`);
  } else {
    console.log(`  Bought Or Not — Score: ${result.score.toFixed(1)}%${cached ? " (cached)" : ""}`);
  }
  console.log(`═══════════════════════════════════════════\n`);

  if (result.ruleScores.length === 0) {
    console.log("  No rules found relevant to this product.\n");
  } else {
    for (const rs of result.ruleScores) {
      console.log(`  Rule: "${rs.rule.statement}" (weight: ${rs.rule.weight})`);
      console.log(`  Context: ${rs.rule.context}`);
      if (!rs.hasData) {
        console.log(`  Satisfaction: no data available`);
      } else if (rs.combinedFor > 0 && rs.combinedAgainst > 0) {
        console.log(`  Satisfaction: ${rs.combinedCertainty.toFixed(1)}% (for: ${rs.combinedFor.toFixed(1)}%, against: ${rs.combinedAgainst.toFixed(1)}%)`);
      } else {
        console.log(`  Satisfaction: ${rs.combinedCertainty.toFixed(1)}%`);
      }
      if (rs.hasData) {
        for (const s of rs.sources) {
          console.log(
            `    - ${name(s.repoUrl)}: "${s.statement}" (certainty ${s.certainty.toFixed(0)}%, satisfaction ${s.satisfaction.toFixed(0)}%, trust ${s.trust.toFixed(0)}%, effective ${s.effectiveCertainty.toFixed(1)}%)`
          );
        }
      }
      console.log();
    }
  }

  if (result.score < 0) {
    console.log(`  Verdict: Insufficient data — no rules had matching information\n`);
  } else {
    console.log(`  Total weight: ${result.totalWeight}`);
    console.log(
      `  Verdict: ${result.score >= buyThreshold ? "Buy" : "Don't buy"} (${result.score.toFixed(1)}%)\n`
    );
  }
}

// Check for cached assessment
const cached = await getCachedAssessment(values.user, values.barcode, threshold);
if (cached) {
  const expiresAt = new Date(cached.expiresAt);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const expiresStr = `${expiresAt.getDate()} ${months[expiresAt.getMonth()]} ${expiresAt.getFullYear()}, ${expiresAt.getHours().toString().padStart(2, "0")}:${expiresAt.getMinutes().toString().padStart(2, "0")}`;
  console.log(`Using cached assessment for barcode ${values.barcode} (valid until ${expiresStr})\n`);
  displayResult(cached.result, cached.nicknames, true, buyThreshold);
  process.exit(0);
}

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
    const nextUrls = (cachedParsed.trust || [])
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

// Resolve API-backed information for the queried barcode
for (const [repoUrl, parsed] of parsedRepos) {
  const apiInfos = parsed.apiInfo || [];
  if (apiInfos.length > 0) {
    console.log(`  Resolving API info from ${repoUrl}...`);
    const resolved = await resolveApiInfo(values.barcode, apiInfos);
    parsed.information.push(...resolved);
    console.log(`    Resolved ${resolved.length} statements`);
  }
}

console.log(`\nLoaded ${parsedRepos.size} repos. Computing score...\n`);

const result = await computeScore(
  values.barcode,
  Array.from(parsedRepos.values()),
  values.user,
  threshold,
  hopDecay
);

const userNicknames = parsedRepos.get(values.user)?.nicknames || {};

await saveAssessmentCache(values.user, values.barcode, threshold, result, userNicknames);

displayResult(result, userNicknames, false, buyThreshold);
