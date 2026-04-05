#!/usr/bin/env bun
/**
 * Generates a Bought Or Not repository from Open Food Facts data.
 *
 * Usage:
 *   # Fetch specific products by barcode:
 *   bun run scripts/generate-off-repo.ts --output /path/to/repo --barcodes 3017620422003,5000112637922
 *
 *   # Fetch via API search (when available):
 *   bun run scripts/generate-off-repo.ts --output /path/to/repo --limit 500
 *
 *   # Full mirror from JSONL dump:
 *   bun run scripts/generate-off-repo.ts --output /path/to/repo --dump
 */

import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { parseArgs } from "util";

const DUMP_URL =
  "https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz";
const PRODUCT_API_URL = "https://world.openfoodfacts.org/api/v2/product";
const SEARCH_API_URL = "https://world.openfoodfacts.org/api/v2/search";
const API_FIELDS =
  "code,product_name,product_name_en,brands,labels_tags,ingredients_analysis_tags,nutrition_grades,nova_group";
const API_PAGE_SIZE = 20;
const USER_AGENT =
  "BoughtOrNot/1.0 (https://github.com/giacecco/bought-or-not)";

// --- CLI ---

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    output: { type: "string", short: "o" },
    limit: { type: "string", short: "l" },
    dump: { type: "boolean", default: false },
    barcodes: { type: "string", short: "b" },
  },
});

const outputDir = values.output;
const limit = values.limit ? parseInt(values.limit) : undefined;
const barcodes = values.barcodes
  ? values.barcodes.split(",").map((b) => b.trim())
  : undefined;

if (!outputDir) {
  console.error(
    "Usage: bun run scripts/generate-off-repo.ts --output <dir> [--barcodes <codes>] [--limit <n>] [--dump]"
  );
  process.exit(1);
}

// Determine mode
const mode: "barcodes" | "api" | "dump" = barcodes
  ? "barcodes"
  : values.dump
    ? "dump"
    : limit
      ? "api"
      : "dump";

// --- Product extraction ---

interface ProductStatements {
  barcode: string;
  name: string;
  maker: string;
  organic: "yes" | "no" | null;
  palmOil: "yes" | "no" | null;
  nutriScore: string | null;
  novaGroup: number | null;
}

const ORGANIC_LABELS = new Set([
  "en:organic",
  "en:eu-organic",
  "en:ab-agriculture-biologique",
  "en:usda-organic",
  "en:bio",
]);

function extractProduct(raw: any): ProductStatements | null {
  const barcode = raw.code?.trim();
  const name = (raw.product_name || raw.product_name_en || "").trim();
  const brand = (raw.brands || "").trim();

  if (!barcode || !name || barcode.length < 8) return null;

  const labelsTags: string[] = raw.labels_tags || [];
  const ingredientsTags: string[] = raw.ingredients_analysis_tags || [];

  // Organic: only claim "not organic" when labels have been filled in
  const isOrganic = labelsTags.some((l) => ORGANIC_LABELS.has(l));
  const organic: "yes" | "no" | null = isOrganic
    ? "yes"
    : labelsTags.length > 0
      ? "no"
      : null;

  // Palm oil: use explicit analysis tags
  const palmOil: "yes" | "no" | null = ingredientsTags.includes("en:palm-oil")
    ? "yes"
    : ingredientsTags.includes("en:palm-oil-free")
      ? "no"
      : null;

  const nutriScore: string | null = raw.nutrition_grades || null;
  const novaGroup: number | null = raw.nova_group
    ? Number(raw.nova_group)
    : null;

  // Skip products with no useful information at all
  if (organic === null && palmOil === null && !nutriScore && !novaGroup)
    return null;

  return {
    barcode,
    name,
    maker: brand || "unknown manufacturer",
    organic,
    palmOil,
    nutriScore,
    novaGroup,
  };
}

// --- Markdown generation ---

const NOVA_DESCRIPTIONS: Record<number, string> = {
  1: "unprocessed or minimally processed",
  2: "processed culinary ingredients",
  3: "processed food",
  4: "ultra-processed food",
};

function productToSections(p: ProductStatements): Map<string, string> {
  const sections = new Map<string, string>();
  const prefix = `${p.name} (barcode ${p.barcode}) made by ${p.maker}`;

  if (p.organic === "yes") {
    sections.set(
      "Organic food",
      `- ${prefix} is certified organic, certainty 100%`
    );
  } else if (p.organic === "no") {
    sections.set(
      "Organic food",
      `- ${prefix} is not certified organic, certainty 100%`
    );
  }

  if (p.palmOil === "yes") {
    sections.set(
      "Ingredients",
      `- ${prefix} contains palm oil, certainty 100%`
    );
  } else if (p.palmOil === "no") {
    sections.set(
      "Ingredients",
      `- ${prefix} does not contain palm oil, certainty 100%`
    );
  }

  if (p.nutriScore) {
    sections.set(
      "Nutrition",
      `- ${prefix} has Nutri-Score ${p.nutriScore.toUpperCase()}, certainty 100%`
    );
  }

  if (p.novaGroup) {
    const desc =
      NOVA_DESCRIPTIONS[p.novaGroup] || `NOVA group ${p.novaGroup}`;
    sections.set(
      "Processing",
      `- ${prefix} is classified as ${desc} (NOVA group ${p.novaGroup}), certainty 100%`
    );
  }

  return sections;
}

// Group key: first 4 digits of barcode
function groupKey(barcode: string): string {
  return barcode.slice(0, 4).padEnd(4, "0");
}

// --- Data sources ---

async function* fetchByBarcodes(
  codes: string[]
): AsyncGenerator<any, void, undefined> {
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (i > 0) await new Promise((r) => setTimeout(r, 1000)); // rate limit
    console.log(`  Fetching barcode ${code}...`);
    const url = `${PRODUCT_API_URL}/${code}.json?fields=${API_FIELDS}`;
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      console.warn(`  Warning: ${code} returned ${response.status}, skipping`);
      continue;
    }
    const data = await response.json();
    if (data.status === 1 && data.product) {
      yield data.product;
    } else {
      console.warn(`  Warning: ${code} not found`);
    }
  }
}

async function* fetchFromApi(
  maxProducts?: number
): AsyncGenerator<any, void, undefined> {
  let page = 1;
  let yielded = 0;

  while (true) {
    const url = `${SEARCH_API_URL}?fields=${API_FIELDS}&page_size=${API_PAGE_SIZE}&page=${page}`;
    console.log(`  Fetching API page ${page}...`);

    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!response.ok)
      throw new Error(`API error: ${response.status} ${response.statusText}`);

    const data = await response.json();
    const products = data.products || [];

    if (products.length === 0) break;

    for (const product of products) {
      yield product;
      yielded++;
      if (maxProducts && yielded >= maxProducts) return;
    }

    page++;
  }
}

async function* fetchFromDump(
  maxProducts?: number
): AsyncGenerator<any, void, undefined> {
  console.log("Downloading Open Food Facts JSONL dump...");
  console.log(`  URL: ${DUMP_URL}`);

  const response = await fetch(DUMP_URL, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok || !response.body)
    throw new Error(`Failed to download dump: ${response.status}`);

  const decompressed = response.body.pipeThrough(
    new DecompressionStream("gzip")
  );
  const reader = decompressed.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let yielded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
        yielded++;
        if (maxProducts && yielded >= maxProducts) {
          reader.cancel();
          return;
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch {}
  }
}

// --- Main ---

async function main() {
  let source: AsyncGenerator<any, void, undefined>;

  switch (mode) {
    case "barcodes":
      console.log(`Fetching ${barcodes!.length} products by barcode...`);
      source = fetchByBarcodes(barcodes!);
      break;
    case "api":
      console.log(`Fetching products via API search (limit: ${limit})...`);
      source = fetchFromApi(limit);
      break;
    case "dump":
      console.log(
        `Processing full JSONL dump${limit ? ` (limit: ${limit})` : ""}...`
      );
      source = fetchFromDump(limit);
      break;
  }

  // Accumulate: Map<groupKey, Map<sectionName, string[]>>
  const groups = new Map<string, Map<string, string[]>>();
  let processed = 0;
  let included = 0;

  for await (const raw of source) {
    processed++;

    const product = extractProduct(raw);
    if (!product) continue;

    included++;
    const key = groupKey(product.barcode);

    if (!groups.has(key)) groups.set(key, new Map());
    const groupSections = groups.get(key)!;

    for (const [section, stmt] of productToSections(product)) {
      if (!groupSections.has(section)) groupSections.set(section, []);
      groupSections.get(section)!.push(stmt);
    }

    if (processed % 10000 === 0) {
      console.log(
        `  ${processed} scanned, ${included} with useful data, ${groups.size} file groups...`
      );
    }
  }

  console.log(
    `\nDone scanning: ${processed} products, ${included} with useful data, ${groups.size} file groups`
  );

  // --- Write output ---

  console.log(`\nWriting to ${outputDir}...`);
  await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(join(outputDir, "information"), { recursive: true });

  // about-us.md
  await writeFile(
    join(outputDir, "information", "about-us.md"),
    `# About us

Open Food Facts is a free, open, collaborative database of food products from around the world, with ingredients, allergens, nutrition facts, and all the information that can be found on product labels.

Data is crowd-sourced by contributors worldwide and often verified directly by producers. It is available under the Open Database License (ODbL).

Website: https://world.openfoodfacts.org
`
  );

  // Information files grouped by barcode prefix
  const sortedKeys = [...groups.keys()].sort();
  for (const key of sortedKeys) {
    const sections = groups.get(key)!;
    let content = `# Information\n\n<!-- Statements listed earlier take priority over later ones -->\n`;

    for (const sectionName of [
      "Organic food",
      "Ingredients",
      "Nutrition",
      "Processing",
    ]) {
      const stmts = sections.get(sectionName);
      if (!stmts || stmts.length === 0) continue;
      content += `\n## ${sectionName}\n`;
      for (const stmt of stmts) {
        content += `${stmt}\n`;
      }
    }

    await writeFile(
      join(outputDir, "information", `products-${key}.md`),
      content
    );
  }

  // rules.md
  await writeFile(
    join(outputDir, "rules.md"),
    `# Rules

<!-- Statements listed earlier take priority over later ones -->

(No rules — Open Food Facts is an information publisher only.)
`
  );

  // trust.md
  await writeFile(
    join(outputDir, "trust.md"),
    `# Trust

<!-- Statements listed earlier take priority over later ones -->

(No trust statements — Open Food Facts publishes its own data.)
`
  );

  console.log(`\nRepository written to: ${outputDir}`);
  console.log(`  ${sortedKeys.length} information files in information/`);
  console.log(`  ${included} products total`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
