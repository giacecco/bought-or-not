import { callLLM, parseJSON } from "./llm";

export interface ParsedInfo {
  context: string;
  statement: string;
  certainty: number;
  isNegative: boolean;
}

export interface ApiInfo {
  context: string;
  apiUrlTemplate: string;
  instructions: string;
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
  apiInfo: ApiInfo[];
  nicknames: Record<string, string>; // repoUrl → nickname
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
  const nicknames = trustFile ? extractNicknames(trustFile.content) : {};
  const rules = await parseRules(ruleFiles.map((f) => f.content).join("\n\n"));
  const allInfo = await parseInformation(
    infoFiles.map((f) => f.content).join("\n\n")
  );

  const information: ParsedInfo[] = [];
  const apiInfo: ApiInfo[] = [];

  for (const entry of allInfo) {
    if ((entry as any).type === "api" && (entry as any).apiUrlTemplate) {
      apiInfo.push({
        context: entry.context,
        apiUrlTemplate: (entry as any).apiUrlTemplate,
        instructions: (entry as any).instructions,
      });
    } else {
      information.push({
        context: entry.context,
        statement: (entry as any).statement,
        certainty: (entry as any).certainty,
        isNegative: (entry as any).isNegative,
      });
    }
  }

  return { repoUrl, information, rules, trust, apiInfo, nicknames };
}

function extractNicknames(content: string): Record<string, string> {
  const nicknames: Record<string, string> = {};
  const regex = /^\[([^\]]+)\]:\s*(https?:\/\/\S+)/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    nicknames[match[2]] = match[1];
  }
  return nicknames;
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

async function parseInformation(content: string): Promise<any[]> {
  if (!content.trim()) return [];

  const prompt = `Parse the following Markdown information file into structured JSON.

Ignore any "About us" sections.

There are two kinds of entries:

1. **Static factual statements** — direct claims about products, producers, or practices (e.g. "Nutella is not certified organic, certainty 100%").
   For each, return:
   - "type": "static"
   - "context": the section heading (e.g. "Organic food")
   - "statement": the factual claim, expressed positively (e.g. "Nutella is certified organic")
   - "certainty": 0-100. If the original statement is negative (e.g. "is NOT certified organic, certainty 100%"), convert: the positive certainty is 100 minus the stated certainty. So "not organic, certainty 100%" becomes certainty 0 for "is organic".
   - "isNegative": true if the original statement was expressed negatively and you converted it

2. **API-backed instructions** — descriptions of how to fetch information from an API, typically starting with "To check..." or "To find out..." (e.g. "To check if a food product is certified organic, call GET https://...").
   For each, return:
   - "type": "api"
   - "context": the section heading (e.g. "Organic food")
   - "apiUrlTemplate": the API URL exactly as written, preserving any {barcode} placeholder
   - "instructions": the full text describing how to call the API and interpret the response

Return ONLY a JSON array, no other text.

Content:
${content}`;

  const result = await callLLM(prompt, "claude-opus-4-6");
  return parseJSON(result);
}
