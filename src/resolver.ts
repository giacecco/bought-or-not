import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import { callLLM, parseJSON } from "./llm";
import type { ApiInfo, ParsedInfo } from "./parser";

const USER_AGENT =
  "BoughtOrNot/1.0 (https://github.com/giacecco/bought-or-not)";
const CACHE_DIR = join(import.meta.dir, "..", ".cache", "api-responses");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface ApiResponseCache {
  cachedAt: number;
  url: string;
  body: string;
}

function apiCachePath(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `${hash}.json`);
}

async function fetchWithCache(url: string): Promise<string | null> {
  const path = apiCachePath(url);

  // Check cache
  try {
    const data: ApiResponseCache = JSON.parse(await readFile(path, "utf-8"));
    if (Date.now() - data.cachedAt < CACHE_TTL_MS) {
      console.log(`    Using cached API response`);
      return data.body;
    }
  } catch {}

  // Fetch fresh
  console.log(`    Fetching ${url}...`);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      console.warn(`    Warning: API returned ${response.status}, skipping`);
      return null;
    }
    const body = await response.text();

    // Save to cache
    await mkdir(CACHE_DIR, { recursive: true });
    const data: ApiResponseCache = { cachedAt: Date.now(), url, body };
    await writeFile(path, JSON.stringify(data));

    return body;
  } catch (err: any) {
    console.warn(`    Warning: API fetch failed: ${err.message}, skipping`);
    return null;
  }
}

export async function resolveApiInfo(
  barcode: string,
  apiInfos: ApiInfo[]
): Promise<ParsedInfo[]> {
  if (apiInfos.length === 0) return [];

  // Group by URL template to avoid duplicate fetches
  const byUrl = new Map<string, ApiInfo[]>();
  for (const info of apiInfos) {
    if (!byUrl.has(info.apiUrlTemplate)) byUrl.set(info.apiUrlTemplate, []);
    byUrl.get(info.apiUrlTemplate)!.push(info);
  }

  const results: ParsedInfo[] = [];

  for (const [urlTemplate, infos] of byUrl) {
    const url = urlTemplate.replace("{barcode}", barcode);
    const apiResponse = await fetchWithCache(url);
    if (!apiResponse) continue;

    // Batch all contexts for this URL into one LLM call
    const contextList = infos
      .map(
        (info, i) =>
          `[${i}] Context: "${info.context}"\nInstructions: ${info.instructions}`
      )
      .join("\n\n");

    const prompt = `You have the following API response for a product with barcode "${barcode}":

${apiResponse}

For each of the following contexts, follow the instructions to produce a factual statement about this product.

${contextList}

For each context, return a JSON object with:
- "index": the context index number
- "statement": the factual claim, expressed positively (e.g. "Nutella is certified organic")
- "certainty": 0-100. If the product satisfies the condition described in the instructions, use 100. If it clearly does not, use 0. If the data is ambiguous, use an intermediate value.
- "isNegative": true if the finding was negative and you expressed it positively (e.g. product is NOT organic → statement "is certified organic" with certainty 0)

If the API response lacks sufficient data for a context, omit that context from the results.

Return ONLY a JSON array of these objects, no other text.`;

    const result = await callLLM(prompt, "claude-opus-4-6");
    try {
      const parsed: { index: number; statement: string; certainty: number; isNegative: boolean }[] =
        parseJSON(result);
      for (const entry of parsed) {
        const info = infos[entry.index];
        if (!info) continue;
        results.push({
          context: info.context,
          statement: entry.statement,
          certainty: entry.certainty,
          isNegative: entry.isNegative || false,
        });
      }
    } catch {
      console.warn(`    Warning: failed to parse LLM response for API resolution`);
    }
  }

  return results;
}
