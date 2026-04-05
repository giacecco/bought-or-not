import { mkdtemp, readdir, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export interface RepoFiles {
  repoUrl: string;
  files: { path: string; content: string }[];
}

export async function fetchRepo(repoUrl: string): Promise<RepoFiles> {
  const dir = await mkdtemp(join(tmpdir(), "bon-"));
  const proc = Bun.spawn(["git", "clone", "--depth", "1", repoUrl, dir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to clone ${repoUrl}: ${stderr}`);
  }
  const files = await readMarkdownFiles(dir);
  return { repoUrl, files };
}

async function readMarkdownFiles(
  dir: string,
  prefix = ""
): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: { path: string; content: string }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await readMarkdownFiles(fullPath, relativePath)));
    } else if (entry.name.endsWith(".md")) {
      const content = await readFile(fullPath, "utf-8");
      results.push({ path: relativePath, content });
    }
  }
  return results;
}
