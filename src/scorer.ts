import { callLLM, parseJSON } from "./llm";
import type { ParsedRepo, ParsedInfo, ParsedRule } from "./parser";

export interface RuleScore {
  rule: ParsedRule;
  sources: {
    repoUrl: string;
    statement: string;
    certainty: number;
    trust: number;
    effectiveCertainty: number;
  }[];
  combinedCertainty: number;
  weightedContribution: number;
}

export interface ScoreResult {
  barcode: string;
  score: number;
  totalWeight: number;
  ruleScores: RuleScore[];
}

interface TrustEdge {
  repoUrl: string;
  context: string;
  trustInfo: boolean;
  trustRules: boolean;
  trustPercent: number;
}

export async function computeScore(
  barcode: string,
  repos: ParsedRepo[],
  userRepoUrl: string,
  trustThreshold: number = 1
): Promise<ScoreResult> {
  // Build trust graph
  const trustGraph = new Map<string, TrustEdge[]>();
  for (const repo of repos) {
    trustGraph.set(repo.repoUrl, repo.trust.map((t) => ({
      repoUrl: t.repoUrl,
      context: t.context,
      trustInfo: t.trustInfo,
      trustRules: t.trustRules,
      trustPercent: t.trustPercent,
    })));
  }

  // Collect all rules, respecting closeness (user's own rules first, then by hop distance)
  const allRules = collectRules(userRepoUrl, repos, trustGraph, trustThreshold);

  // Collect all information
  const allInfo = collectInformation(userRepoUrl, repos, trustGraph, trustThreshold);

  // Find information relevant to this barcode
  const relevantInfo = await findRelevantInfo(barcode, allInfo);

  // For each rule, find matching information and compute satisfaction
  const ruleScores: RuleScore[] = [];
  for (const { rule, effectiveTrust } of allRules) {
    const matchingInfo = await matchInfoToRule(rule, relevantInfo);

    const sources = matchingInfo.map((m) => ({
      repoUrl: m.repoUrl,
      statement: m.info.statement,
      certainty: m.satisfactionCertainty,
      trust: m.effectiveTrust,
      effectiveCertainty: (m.effectiveTrust / 100) * (m.satisfactionCertainty / 100) * 100,
    }));

    // Combined certainty: 1 - Π(1 - effective_certainty_i)
    const combinedCertainty =
      sources.length === 0
        ? 0
        : (1 -
            sources.reduce(
              (product, s) => product * (1 - s.effectiveCertainty / 100),
              1
            )) *
          100;

    ruleScores.push({
      rule,
      sources,
      combinedCertainty,
      weightedContribution: rule.weight * (combinedCertainty / 100),
    });
  }

  const totalWeight = ruleScores.reduce((sum, rs) => sum + rs.rule.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : ruleScores.reduce((sum, rs) => sum + rs.weightedContribution, 0) /
        totalWeight *
        100;

  return { barcode, score, totalWeight, ruleScores };
}

interface CollectedRule {
  rule: ParsedRule;
  repoUrl: string;
  hops: number;
  order: number;
  effectiveTrust: number;
}

function collectRules(
  startUrl: string,
  repos: ParsedRepo[],
  trustGraph: Map<string, TrustEdge[]>,
  threshold: number
): CollectedRule[] {
  const results: CollectedRule[] = [];
  const visited = new Set<string>();

  function walk(url: string, hops: number, cumulativeTrust: number) {
    if (visited.has(url)) return;
    if (cumulativeTrust < threshold && hops > 0) return;
    visited.add(url);

    const repo = repos.find((r) => r.repoUrl === url);
    if (!repo) return;

    // Add this repo's rules
    repo.rules.forEach((rule, order) => {
      results.push({
        rule,
        repoUrl: url,
        hops,
        order,
        effectiveTrust: cumulativeTrust,
      });
    });

    // Walk trust edges for rules
    const edges = trustGraph.get(url) || [];
    for (const edge of edges) {
      if (edge.trustRules) {
        walk(url === startUrl ? edge.repoUrl : edge.repoUrl, hops + 1, cumulativeTrust * (edge.trustPercent / 100));
      }
    }
  }

  walk(startUrl, 0, 100);

  // Sort by hops (closer first), then by order within same distance
  // Closer rules override more distant ones on the same topic
  return deduplicateRules(results);
}

function deduplicateRules(rules: CollectedRule[]): CollectedRule[] {
  // Sort: fewer hops first, then earlier order first
  rules.sort((a, b) => a.hops - b.hops || a.order - b.order);

  // Keep only the closest rule per context (closer overrides further)
  const seen = new Map<string, CollectedRule>();
  for (const r of rules) {
    const key = r.rule.context.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

interface CollectedInfo {
  info: ParsedInfo;
  repoUrl: string;
  effectiveTrust: number;
}

function collectInformation(
  startUrl: string,
  repos: ParsedRepo[],
  trustGraph: Map<string, TrustEdge[]>,
  threshold: number
): CollectedInfo[] {
  const results: CollectedInfo[] = [];
  const visited = new Set<string>();

  function walk(url: string, cumulativeTrust: number) {
    if (visited.has(url)) return;
    if (cumulativeTrust < threshold && url !== startUrl) return;
    visited.add(url);

    const repo = repos.find((r) => r.repoUrl === url);
    if (!repo) return;

    for (const info of repo.information) {
      results.push({ info, repoUrl: url, effectiveTrust: cumulativeTrust });
    }

    const edges = trustGraph.get(url) || [];
    for (const edge of edges) {
      if (edge.trustInfo) {
        walk(edge.repoUrl, cumulativeTrust * (edge.trustPercent / 100));
      }
    }
  }

  walk(startUrl, 100);
  return results;
}

async function findRelevantInfo(
  barcode: string,
  allInfo: CollectedInfo[]
): Promise<CollectedInfo[]> {
  if (allInfo.length === 0) return [];

  const statements = allInfo.map((i, idx) => `[${idx}] ${i.info.statement}`).join("\n");

  const prompt = `Given the barcode "${barcode}", which of the following information statements are relevant to a product with this barcode?

A statement is relevant if:
- It directly mentions this barcode, OR
- It mentions the product name associated with this barcode (look for it in other statements), OR
- It mentions the producer/company that makes this product (use product-to-producer links from other statements to determine this)

For example, if one statement says "Nutella (barcode 123) made by Ferrero..." and another says "Ferrero's tax practices are fair", BOTH are relevant to barcode 123 because Ferrero is the producer.

Statements:
${statements}

Return ONLY a JSON array of the indices (numbers) of relevant statements. If none are relevant, return [].`;

  const result = await callLLM(prompt, "claude-haiku-4-5-20251001");
  const indices: number[] = parseJSON(result);
  return indices.map((i) => allInfo[i]).filter(Boolean);
}

interface MatchedInfo extends CollectedInfo {
  satisfactionCertainty: number;
}

async function matchInfoToRule(
  rule: ParsedRule,
  relevantInfo: CollectedInfo[]
): Promise<MatchedInfo[]> {
  if (relevantInfo.length === 0) return [];

  const statements = relevantInfo
    .map((i, idx) => `[${idx}] ${i.info.statement} (certainty: ${i.info.certainty}%)`)
    .join("\n");

  const prompt = `Given this rule about what the user WANTS: "${rule.statement}" (context: ${rule.context}), evaluate each information statement below.

For each relevant statement, determine: does the product SATISFY this rule? Return the certainty (0-100) that the rule is satisfied.

Examples:
- Rule: "eating food certified to be organic". Info: "Product is certified organic, certainty 100%". → satisfactionCertainty: 100
- Rule: "eating food certified to be organic". Info: "Product is certified organic, certainty 0%". → satisfactionCertainty: 0
- Rule: "eating food that does not contain palm oil". Info: "Product contains palm oil, certainty 100%". → satisfactionCertainty: 0 (the product VIOLATES the rule)
- Rule: "eating food that does not contain palm oil". Info: "Product contains palm oil, certainty 50%". → satisfactionCertainty: 50 (50% chance it violates)
- Rule: "buying from companies with fair tax practices". Info: "Company's tax practices are fair, certainty 49%". → satisfactionCertainty: 49

Return a JSON array of objects with "index" and "satisfactionCertainty" for each relevant statement. Omit irrelevant statements. Return [] if none are relevant.

Statements:
${statements}`;

  const result = await callLLM(prompt, "claude-opus-4-6");
  const matches: { index: number; satisfactionCertainty: number }[] = parseJSON(result);
  return matches
    .map((m) => {
      const info = relevantInfo[m.index];
      if (!info) return null;
      return { ...info, satisfactionCertainty: m.satisfactionCertainty };
    })
    .filter(Boolean) as MatchedInfo[];
}

