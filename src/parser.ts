import Anthropic from "@anthropic-ai/sdk";

export interface ParsedInfo {
  context: string;
  statement: string;
  certainty: number;
  isNegative: boolean;
}

export interface ParsedRule {
  context: string;
  statement: string;
  weight: number;
}

export interface ParsedTrust {
  context: string;
  repoUrl: string;
  trustInfo: boolean;
  trustRules: boolean;
  trustPercent: number;
}

export interface ParsedRepo {
  repoUrl: string;
  information: ParsedInfo[];
  rules: ParsedRule[];
  trust: ParsedTrust[];
}

const client = new Anthropic();

async function callLLM(
  prompt: string,
  model: string
): Promise<string> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  // Strip markdown code fences if the LLM wrapped the JSON
  return block.text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
}

function parseJSON<T>(text: string): T {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse JSON from LLM response: ${text}`);
  }
}

export async function parseRepoFiles(
  repoUrl: string,
  files: { path: string; content: string }[]
): Promise<ParsedRepo> {
  const trustFile = files.find(
    (f) => f.path === "trust.md" || f.path.endsWith("/trust.md")
  );
  const ruleFiles = files.filter(
    (f) => f.path === "rules.md" || f.path.endsWith("/rules.md")
  );
  const infoFiles = files.filter(
    (f) =>
      (f.path.includes("information") && f.path.endsWith(".md")) ||
      f.path === "information.md"
  );

  const trust = trustFile ? await parseTrust(trustFile.content) : [];
  const rules = await parseRules(ruleFiles.map((f) => f.content).join("\n\n"));
  const information = await parseInformation(
    infoFiles.map((f) => f.content).join("\n\n")
  );

  return { repoUrl, information, rules, trust };
}

async function parseTrust(content: string): Promise<ParsedTrust[]> {
  const prompt = `Parse the following Markdown trust file into structured JSON.

The file may contain Markdown reference link definitions like:
[nickname]: https://github.com/...
These define nicknames for repository URLs. When a nickname is used later in trust statements, resolve it to the full URL.

Return a JSON array where each element has:
- "context": the section heading (e.g. "Organic food")
- "repoUrl": the full GitHub repository URL of the trusted user
- "trustInfo": true if trusting their information
- "trustRules": true if trusting their rules
- "trustPercent": the trust percentage as a number 0-100

Return ONLY the JSON array, no other text.

Content:
${content}`;

  const result = await callLLM(prompt, "claude-haiku-4-5-20251001");
  return parseJSON(result);
}

async function parseRules(content: string): Promise<ParsedRule[]> {
  if (!content.trim()) return [];

  const prompt = `Parse the following Markdown rules into structured JSON.

Return a JSON array where each element has:
- "context": the section heading (e.g. "Organic food")
- "statement": the rule statement (e.g. "eating food certified to be organic")
- "weight": the weight as a number 0-100

Return ONLY the JSON array, no other text.

Content:
${content}`;

  const result = await callLLM(prompt, "claude-haiku-4-5-20251001");
  return parseJSON(result);
}

async function parseInformation(content: string): Promise<ParsedInfo[]> {
  if (!content.trim()) return [];

  const prompt = `Parse the following Markdown information statements into structured JSON.

Ignore any "About us" sections — only parse factual statements about products, producers, or practices.

Return a JSON array where each element has:
- "context": the section heading (e.g. "Organic food")
- "statement": the factual claim, expressed positively (e.g. "Nutella is certified organic")
- "certainty": the certainty as a number 0-100. If the original statement is negative (e.g. "is NOT certified organic, certainty 100%"), convert: the positive certainty is 100 minus the stated certainty. So "not organic, certainty 100%" becomes certainty 0 for "is organic".
- "isNegative": true if the original statement was expressed negatively and you converted it

Return ONLY the JSON array, no other text.

Content:
${content}`;

  const result = await callLLM(prompt, "claude-opus-4-6");
  return parseJSON(result);
}
