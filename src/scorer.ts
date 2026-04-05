import { callLLM, parseJSON, buildPrompt } from "./llm";
import type { ParsedRepo, ParsedInfo, ParsedRule } from "./parser";

export interface RuleScore {
  rule: ParsedRule;
  sources: {
    repoUrl: string;
    statement: string;
    certainty: number;
    satisfaction: number;
    trust: number;
    effectiveCertainty: number;
  }[];
  combinedFor: number;
  combinedAgainst: number;
  combinedCertainty: number;
  weightedContribution: number;
  hasData: boolean;
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

// Cache for LLM context match results: "trustCtx|contentCtx" -> boolean
const contextMatchCache = new Map<string, boolean>();

async function matchContexts(
  trustContext: string,
  contentContexts: string[]
): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const uncached: string[] = [];

  for (const cc of contentContexts) {
    const key = `${trustContext}|${cc}`;
    const cached = contextMatchCache.get(key);
    if (cached !== undefined) {
      results.set(cc, cached);
    } else {
      uncached.push(cc);
    }
  }

  if (uncached.length === 0) return results;

  const pairs = uncached.map((cc, i) => `[${i}] "${cc}"`).join("\n");
  const prompt = buildPrompt(
    `Does the trust context "${trustContext}" cover each of the following content contexts? ` +
    `Two contexts match if they refer to the same broad topic area (e.g., "Organic food" matches "Organic certification", but "Organic food" does NOT match "Tax practices").\n\n` +
    `Content contexts:\n${pairs}\n\n` +
    `Return a JSON array of objects with "index" (number) and "matches" (boolean). Include ALL indices.`
  );

  const result = await callLLM(prompt, "claude-haiku-4-5-20251001");
  const parsed: { index: number; matches: boolean }[] = parseJSON(result);

  for (const entry of parsed) {
    const cc = uncached[entry.index];
    if (cc === undefined) continue;
    const key = `${trustContext}|${cc}`;
    contextMatchCache.set(key, entry.matches);
    results.set(cc, entry.matches);
  }

  // Default uncached contexts not in the LLM response to false
  for (const cc of uncached) {
    if (!results.has(cc)) {
      const key = `${trustContext}|${cc}`;
      contextMatchCache.set(key, false);
      results.set(cc, false);
    }
  }

  return results;
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
  const allRules = await collectRules(userRepoUrl, repos, trustGraph, trustThreshold);

  // Collect all information
  const allInfo = await collectInformation(userRepoUrl, repos, trustGraph, trustThreshold);

  // Find information relevant to this barcode
  const relevantInfo = await findRelevantInfo(barcode, allInfo);

  // For each rule, find matching information and compute satisfaction
  const ruleScores: RuleScore[] = [];
  for (const { rule, effectiveTrust } of allRules) {
    const matchingInfo = await matchInfoToRule(rule, relevantInfo);

    const sources = matchingInfo.map((m) => ({
      repoUrl: m.repoUrl,
      statement: m.info.statement,
      certainty: m.info.certainty,
      satisfaction: m.satisfactionCertainty,
      trust: m.effectiveTrust,
      effectiveCertainty: (m.effectiveTrust / 100) * (m.satisfactionCertainty / 100) * 100,
    }));

    // Split sources into "for" (satisfaction > 50) and "against" (satisfaction <= 50)
    const forSources = sources.filter((s) => s.satisfaction > 50);
    const againstSources = sources.filter((s) => s.satisfaction <= 50);

    // Combine "for" group: at least one is right
    const combinedFor =
      forSources.length === 0
        ? 0
        : (1 -
            forSources.reduce(
              (product, s) => product * (1 - s.effectiveCertainty / 100),
              1
            )) *
          100;

    // Combine "against" group: invert satisfaction to get anti-certainty
    const combinedAgainst =
      againstSources.length === 0
        ? 0
        : (1 -
            againstSources.reduce(
              (product, s) =>
                product *
                (1 - (s.trust / 100) * ((100 - s.satisfaction) / 100)),
              1
            )) *
          100;

    // Net: 50% = deadlock, 100% = full agreement for, 0% = full agreement against
    const combinedCertainty =
      sources.length === 0
        ? 0
        : Math.max(0, Math.min(100, 50 + (combinedFor - combinedAgainst) / 2));

    const hasData = sources.length > 0;

    ruleScores.push({
      rule,
      sources,
      combinedFor,
      combinedAgainst,
      combinedCertainty,
      weightedContribution: rule.weight * (combinedCertainty / 100),
      hasData,
    });
  }

  // Exclude rules with no data from the weighted average
  const rulesWithData = ruleScores.filter((rs) => rs.hasData);
  const totalWeight = rulesWithData.reduce((sum, rs) => sum + rs.rule.weight, 0);
  const score =
    totalWeight === 0
      ? -1 // sentinel: insufficient data
      : rulesWithData.reduce((sum, rs) => sum + rs.weightedContribution, 0) /
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

async function collectRules(
  startUrl: string,
  repos: ParsedRepo[],
  trustGraph: Map<string, TrustEdge[]>,
  threshold: number
): Promise<CollectedRule[]> {
  const results: CollectedRule[] = [];
  const bestTrust = new Map<string, number>();
  const inStack = new Set<string>();

  async function walk(url: string, hops: number, cumulativeTrust: number, trustContext: string | null) {
    if (cumulativeTrust < threshold && hops > 0) return;
    if (inStack.has(url)) return;

    // For context-scoped best-trust tracking
    const trustKey = trustContext ? `${url}|${trustContext}` : url;
    const prev = bestTrust.get(trustKey);
    if (prev !== undefined && prev >= cumulativeTrust) return;
    bestTrust.set(trustKey, cumulativeTrust);

    inStack.add(url);

    const repo = repos.find((r) => r.repoUrl === url);
    if (!repo) { inStack.delete(url); return; }

    if (hops === 0) {
      // User's own repo: collect ALL rules unconditionally
      // Remove previously added (shouldn't happen at hop 0, but safe)
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].repoUrl === url) results.splice(i, 1);
      }
      repo.rules.forEach((rule, order) => {
        results.push({ rule, repoUrl: url, hops, order, effectiveTrust: cumulativeTrust });
      });
    } else {
      // Trusted repo: only collect rules whose context matches the trust edge context
      const ruleContexts = [...new Set(repo.rules.map((r) => r.context))];
      const matches = await matchContexts(trustContext!, ruleContexts);

      // Remove previously added rules from this repo for this trust context
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].repoUrl === url && matches.get(results[i].rule.context)) {
          results.splice(i, 1);
        }
      }

      repo.rules.forEach((rule, order) => {
        if (matches.get(rule.context)) {
          results.push({ rule, repoUrl: url, hops, order, effectiveTrust: cumulativeTrust });
        }
      });
    }

    const edges = trustGraph.get(url) || [];
    for (const edge of edges) {
      if (edge.trustRules) {
        await walk(edge.repoUrl, hops + 1, cumulativeTrust * (edge.trustPercent / 100), edge.context);
      }
    }

    inStack.delete(url);
  }

  await walk(startUrl, 0, 100, null);
  results.sort((a, b) => a.hops - b.hops || a.order - b.order);
  return results;
}

interface CollectedInfo {
  info: ParsedInfo;
  repoUrl: string;
  effectiveTrust: number;
}

async function collectInformation(
  startUrl: string,
  repos: ParsedRepo[],
  trustGraph: Map<string, TrustEdge[]>,
  threshold: number
): Promise<CollectedInfo[]> {
  const results: CollectedInfo[] = [];
  const bestTrust = new Map<string, number>();
  const inStack = new Set<string>();

  async function walk(url: string, cumulativeTrust: number, trustContext: string | null) {
    if (cumulativeTrust < threshold && url !== startUrl) return;
    if (inStack.has(url)) return;

    const trustKey = trustContext ? `${url}|${trustContext}` : url;
    const prev = bestTrust.get(trustKey);
    if (prev !== undefined && prev >= cumulativeTrust) return;
    bestTrust.set(trustKey, cumulativeTrust);

    inStack.add(url);

    const repo = repos.find((r) => r.repoUrl === url);
    if (!repo) { inStack.delete(url); return; }

    if (url === startUrl && trustContext === null) {
      // User's own repo: collect ALL information unconditionally
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].repoUrl === url) results.splice(i, 1);
      }
      for (const info of repo.information) {
        results.push({ info, repoUrl: url, effectiveTrust: cumulativeTrust });
      }
    } else {
      // Trusted repo: only collect info whose context matches the trust edge context
      const infoContexts = [...new Set(repo.information.map((i) => i.context))];
      const matches = await matchContexts(trustContext!, infoContexts);

      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i].repoUrl === url && matches.get(results[i].info.context)) {
          results.splice(i, 1);
        }
      }

      for (const info of repo.information) {
        if (matches.get(info.context)) {
          results.push({ info, repoUrl: url, effectiveTrust: cumulativeTrust });
        }
      }
    }

    const edges = trustGraph.get(url) || [];
    for (const edge of edges) {
      if (edge.trustInfo) {
        await walk(edge.repoUrl, cumulativeTrust * (edge.trustPercent / 100), edge.context);
      }
    }

    inStack.delete(url);
  }

  await walk(startUrl, 100, null);
  return results;
}

async function findRelevantInfo(
  barcode: string,
  allInfo: CollectedInfo[]
): Promise<CollectedInfo[]> {
  if (allInfo.length === 0) return [];

  const statements = allInfo.map((i, idx) => `[${idx}] ${i.info.statement}`).join("\n");

  const prompt = buildPrompt(`Given the barcode "${barcode}", which of the following information statements are relevant to a product with this barcode?

A statement is relevant if:
- It directly mentions this barcode, OR
- It mentions the product name associated with this barcode (look for it in other statements), OR
- It mentions the producer/company that makes this product (use product-to-producer links from other statements to determine this)

For example, if one statement says "Nutella (barcode 123) made by Ferrero..." and another says "Ferrero's tax practices are fair", BOTH are relevant to barcode 123 because Ferrero is the producer.

Return ONLY a JSON array of the indices (numbers) of relevant statements. If none are relevant, return [].`, statements);

  const result = await callLLM(prompt, "claude-haiku-4-5-20251001");
  const indices: number[] = parseJSON(result);
  return indices.filter((i) => i >= 0 && i < allInfo.length).map((i) => allInfo[i]);
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

  const prompt = buildPrompt(`Given this rule about what the user WANTS: "${rule.statement}" (context: ${rule.context}), evaluate each information statement below.

For each relevant statement, determine: does the product SATISFY this rule? Return the certainty (0-100) that the rule is satisfied.

Examples:
- Rule: "eating food certified to be organic". Info: "Product is certified organic, certainty 100%". → satisfactionCertainty: 100
- Rule: "eating food certified to be organic". Info: "Product is certified organic, certainty 0%". → satisfactionCertainty: 0
- Rule: "eating food that does not contain palm oil". Info: "Product contains palm oil, certainty 100%". → satisfactionCertainty: 0 (the product VIOLATES the rule)
- Rule: "eating food that does not contain palm oil". Info: "Product contains palm oil, certainty 50%". → satisfactionCertainty: 50 (50% chance it violates)
- Rule: "buying from companies with fair tax practices". Info: "Company's tax practices are fair, certainty 49%". → satisfactionCertainty: 49

Return a JSON array of objects with "index" and "satisfactionCertainty" for each relevant statement. Omit irrelevant statements. Return [] if none are relevant.`, statements);

  const result = await callLLM(prompt, "claude-opus-4-6");
  const matches: { index: number; satisfactionCertainty: number }[] = parseJSON(result);
  return matches
    .map((m) => {
      const info = relevantInfo[m.index];
      if (!info) return null;
      return { ...info, satisfactionCertainty: Math.max(0, Math.min(100, m.satisfactionCertainty)) };
    })
    .filter(Boolean) as MatchedInfo[];
}

