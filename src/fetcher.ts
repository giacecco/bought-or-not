import { mkdtemp, readdir, readFile, mkdir, writeFile, stat, rm } from "fs/promises";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { createHash } from "crypto";

const CACHE_DIR = join(homedir(), ".bought-or-not", "cache");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface RepoFiles {
  repoUrl: string;
  files: { path: string; content: string }[];
}

function repoCacheDir(repoUrl: string): string {
  const hash = createHash("sha256").update(repoUrl).digest("hex").slice(0, 12);
  const name = repoUrl.replace(/.*\//, "").replace(/\.git$/, "");
  return join(CACHE_DIR, `${name}-${hash}`);
}

function cacheMetaPath(dir: string): string {
  return join(dir, ".bon-cache-meta.json");
}

async function isCacheValid(dir: string): Promise<boolean> {
  try {
    const meta = JSON.parse(await readFile(cacheMetaPath(dir), "utf-8"));
    const age = Date.now() - meta.cachedAt;
    return age < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

export async function clearCache(): Promise<void> {
  try {
    await rm(CACHE_DIR, { recursive: true, force: true });
  } catch {}
}

export async function fetchRepo(repoUrl: string): Promise<RepoFiles> {
  const cacheDir = repoCacheDir(repoUrl);

  if (await isCacheValid(cacheDir)) {
    console.log(`  Using cached ${repoUrl}`);
    const files = await readMarkdownFiles(cacheDir);
    return { repoUrl, files };
  }

  // Remove stale cache if it exists
  try {
    await rm(cacheDir, { recursive: true, force: true });
  } catch {}

  await mkdir(CACHE_DIR, { recursive: true });

  console.log(`  Cloning ${repoUrl}...`);
  const proc = Bun.spawn(["git", "clone", "--depth", "1", repoUrl, cacheDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Failed to clone ${repoUrl}: ${stderr}`);
  }

  // Write cache metadata
  await writeFile(cacheMetaPath(cacheDir), JSON.stringify({ cachedAt: Date.now(), repoUrl }));

  const files = await readMarkdownFiles(cacheDir);
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
