import { readdir, readFile, mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
import type { ParsedRepo } from "./parser";
import type { ScoreResult } from "./scorer";

const CACHE_DIR = join(import.meta.dir, "..", ".cache");
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

function parsedCachePath(dir: string): string {
  return join(dir, ".bon-parsed.json");
}

interface CacheMeta {
  cachedAt: number;
  repoUrl: string;
}

async function readCacheMeta(dir: string): Promise<CacheMeta | null> {
  try {
    return JSON.parse(await readFile(cacheMetaPath(dir), "utf-8"));
  } catch {
    return null;
  }
}

async function isCacheValid(dir: string): Promise<boolean> {
  const meta = await readCacheMeta(dir);
  if (!meta) return false;
  return Date.now() - meta.cachedAt < CACHE_TTL_MS;
}

export async function clearCache(): Promise<void> {
  try {
    await rm(CACHE_DIR, { recursive: true, force: true });
  } catch {}
}

export async function getCachedParsed(repoUrl: string): Promise<ParsedRepo | null> {
  const cacheDir = repoCacheDir(repoUrl);
  if (!(await isCacheValid(cacheDir))) return null;
  try {
    return JSON.parse(await readFile(parsedCachePath(cacheDir), "utf-8"));
  } catch {
    return null;
  }
}

export async function saveParsedCache(repoUrl: string, parsed: ParsedRepo): Promise<void> {
  const cacheDir = repoCacheDir(repoUrl);
  await writeFile(parsedCachePath(cacheDir), JSON.stringify(parsed));
}

// --- Assessment cache ---

function assessmentCachePath(userRepoUrl: string, barcode: string, threshold: number): string {
  const key = `${userRepoUrl}|${barcode}|${threshold}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return join(CACHE_DIR, `assessment-${hash}.json`);
}

interface AssessmentCache {
  cachedAt: number;
  userRepoUrl: string;
  barcode: string;
  threshold: number;
  result: ScoreResult;
  nicknames: Record<string, string>;
}

export interface CachedAssessment {
  result: ScoreResult;
  nicknames: Record<string, string>;
  expiresAt: number;
}

export async function getCachedAssessment(
  userRepoUrl: string,
  barcode: string,
  threshold: number
): Promise<CachedAssessment | null> {
  const path = assessmentCachePath(userRepoUrl, barcode, threshold);
  try {
    const data: AssessmentCache = JSON.parse(await readFile(path, "utf-8"));
    if (Date.now() - data.cachedAt >= CACHE_TTL_MS) return null;
    return { result: data.result, nicknames: data.nicknames || {}, expiresAt: data.cachedAt + CACHE_TTL_MS };
  } catch {
    return null;
  }
}

export async function saveAssessmentCache(
  userRepoUrl: string,
  barcode: string,
  threshold: number,
  result: ScoreResult,
  nicknames: Record<string, string>
): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const path = assessmentCachePath(userRepoUrl, barcode, threshold);
  const data: AssessmentCache = {
    cachedAt: Date.now(),
    userRepoUrl,
    barcode,
    threshold,
    result,
    nicknames,
  };
  await writeFile(path, JSON.stringify(data));
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
