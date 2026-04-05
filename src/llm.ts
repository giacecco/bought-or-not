import Anthropic from "@anthropic-ai/sdk";

type Backend = "api" | "cli";
let backend: Backend = "api";

export function setBackend(b: Backend) {
  backend = b;
}

const getClient = (() => {
  let client: Anthropic | null = null;
  return () => {
    if (!client) client = new Anthropic();
    return client;
  };
})();

export async function callLLM(prompt: string, model: string): Promise<string> {
  const raw = backend === "cli" ? await callCLI(prompt, model) : await callAPI(prompt, model);
  return raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();
}

async function callAPI(prompt: string, model: string): Promise<string> {
  const response = await getClient().messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  if (block.type !== "text") throw new Error("Unexpected response type");
  return block.text;
}

async function callCLI(prompt: string, model: string): Promise<string> {
  const modelFlag = model.includes("haiku") ? "haiku" : model.includes("opus") ? "opus" : "sonnet";
  const proc = Bun.spawn(["claude", "-p", "--model", modelFlag, "--output-format", "json", prompt], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`claude CLI failed: ${stderr}`);
  }
  const parsed = JSON.parse(output);
  if (parsed.is_error) {
    throw new Error(`claude CLI error: ${parsed.result}`);
  }
  return parsed.result;
}

export function parseJSON<T>(text: string): T {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\[.*?\]/s);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse JSON from LLM response: ${text}`);
  }
}
