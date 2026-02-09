import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

type RootCfg = {
  id: string;
  path: string;
  kind?: string;
  exclude?: string[];
};

type PluginCfg = {
  roots: RootCfg[];
  maxFileBytes?: number;
  maxHits?: number;
  followSymlinks?: boolean;
  exclude?: string[];
  includeExtensions?: string[];
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function json(details: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

function normalizePathForMatch(p: string): string {
  return p.replaceAll("\\\\", "/");
}

function isWithinRoot(rootDir: string, candidatePath: string): boolean {
  const rel = path.relative(rootDir, candidatePath);
  if (rel === "") {
    return true;
  }
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) {
    return false;
  }
  return !path.isAbsolute(rel);
}

function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function toAbsPath(inputPath: string, baseDir?: string): string {
  const expanded = expandHome(inputPath.trim());
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  const base = baseDir ? expandHome(baseDir) : process.cwd();
  return path.normalize(path.resolve(base, expanded));
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function getPluginCfg(api: OpenClawPluginApi): Required<PluginCfg> {
  const raw = (api.pluginConfig ?? {}) as Partial<PluginCfg>;
  const roots = Array.isArray(raw.roots) ? raw.roots.filter((r) => r && typeof r === "object") : [];
  if (roots.length === 0) {
    throw new Error("game-audio plugin misconfigured: roots is required and must be non-empty");
  }
  return {
    roots: roots as RootCfg[],
    maxFileBytes:
      typeof raw.maxFileBytes === "number" && raw.maxFileBytes > 0 ? raw.maxFileBytes : 2_000_000,
    maxHits: typeof raw.maxHits === "number" && raw.maxHits > 0 ? raw.maxHits : 200,
    followSymlinks: raw.followSymlinks === true,
    exclude: Array.isArray(raw.exclude) ? raw.exclude.filter((s) => typeof s === "string") : [],
    includeExtensions: Array.isArray(raw.includeExtensions)
      ? raw.includeExtensions.filter((s) => typeof s === "string" && s.trim())
      : [],
  };
}

async function resolveRoots(api: OpenClawPluginApi) {
  const cfg = getPluginCfg(api);
  const workspaceDir = api.config?.agents?.defaults?.workspace;
  const resolved = await Promise.all(
    cfg.roots.map(async (r) => {
      const abs = toAbsPath(r.path, workspaceDir);
      const exists = await pathExists(abs);
      return {
        id: String(r.id),
        kind: typeof r.kind === "string" ? r.kind : undefined,
        path: abs,
        exists,
        exclude: Array.isArray(r.exclude) ? r.exclude.filter((s) => typeof s === "string") : [],
      };
    }),
  );
  return { cfg, roots: resolved };
}

function shouldExclude(params: {
  filePath: string;
  globalExclude: string[];
  rootExclude: string[];
}): boolean {
  const norm = normalizePathForMatch(params.filePath);
  for (const pat of params.globalExclude) {
    if (pat && norm.includes(pat)) {
      return true;
    }
  }
  for (const pat of params.rootExclude) {
    if (pat && norm.includes(pat)) {
      return true;
    }
  }
  return false;
}

function extOk(filePath: string, includeExtensions: string[]): boolean {
  if (!includeExtensions || includeExtensions.length === 0) {
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  return includeExtensions.map((e) => e.toLowerCase()).includes(ext);
}

type SearchHit = {
  rootId: string;
  file: string;
  line: number;
  text: string;
};

async function* walkFiles(params: {
  rootDir: string;
  rootId: string;
  globalExclude: string[];
  rootExclude: string[];
  includeExtensions: string[];
  followSymlinks: boolean;
}): AsyncGenerator<string> {
  const rootReal = await fs.realpath(params.rootDir).catch(() => params.rootDir);
  const stack = [params.rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (
        shouldExclude({
          filePath: full,
          globalExclude: params.globalExclude,
          rootExclude: params.rootExclude,
        })
      ) {
        continue;
      }
      if (ent.isSymbolicLink()) {
        if (!params.followSymlinks) {
          continue;
        }
        const real = await fs.realpath(full).catch(() => null);
        if (!real || !isWithinRoot(rootReal, real)) {
          continue;
        }
        const st = await fs.stat(full).catch(() => null);
        if (!st) {
          continue;
        }
        if (st.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (st.isFile()) {
          if (!extOk(full, params.includeExtensions)) {
            continue;
          }
          yield full;
        }
        continue;
      }
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (ent.isFile()) {
        if (!extOk(full, params.includeExtensions)) {
          continue;
        }
        yield full;
      }
    }
  }
}

async function readTextFileLimited(filePath: string, maxBytes: number): Promise<string | null> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  if (stat.size > maxBytes) {
    return null;
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function makeMatcher(params: {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}): (s: string) => boolean {
  const q = params.caseSensitive ? params.query : params.query.toLowerCase();
  if (params.regex) {
    const re = new RegExp(params.query, params.caseSensitive ? "g" : "gi");
    return (s) => re.test(s);
  }
  return (s) => {
    const hay = params.caseSensitive ? s : s.toLowerCase();
    return hay.includes(q);
  };
}

async function searchAcrossRoots(params: {
  api: OpenClawPluginApi;
  query: string;
  rootIds?: string[];
  regex?: boolean;
  caseSensitive?: boolean;
  maxHits?: number;
}): Promise<{ hits: SearchHit[]; scannedFiles: number; skippedLargeFiles: number }> {
  const { cfg, roots } = await resolveRoots(params.api);
  const selected =
    Array.isArray(params.rootIds) && params.rootIds.length > 0
      ? roots.filter((r) => params.rootIds?.includes(r.id))
      : roots;

  const matcher = makeMatcher({
    query: params.query,
    regex: params.regex === true,
    caseSensitive: params.caseSensitive === true,
  });

  const maxHits =
    typeof params.maxHits === "number" && params.maxHits > 0 ? params.maxHits : cfg.maxHits;

  const hits: SearchHit[] = [];
  let scannedFiles = 0;
  let skippedLargeFiles = 0;

  for (const root of selected) {
    if (!root.exists) {
      continue;
    }
    for await (const filePath of walkFiles({
      rootDir: root.path,
      rootId: root.id,
      globalExclude: cfg.exclude,
      rootExclude: root.exclude,
      includeExtensions: cfg.includeExtensions,
      followSymlinks: cfg.followSymlinks,
    })) {
      if (hits.length >= maxHits) {
        return { hits, scannedFiles, skippedLargeFiles };
      }
      scannedFiles += 1;
      const text = await readTextFileLimited(filePath, cfg.maxFileBytes);
      if (text === null) {
        skippedLargeFiles += 1;
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        if (!matcher(line)) {
          continue;
        }
        hits.push({
          rootId: root.id,
          file: path.relative(root.path, filePath) || entitle(filePath),
          line: i + 1,
          text: line.slice(0, 400),
        });
        if (hits.length >= maxHits) {
          return { hits, scannedFiles, skippedLargeFiles };
        }
      }
    }
  }

  return { hits, scannedFiles, skippedLargeFiles };
}

function entitle(p: string): string {
  return normalizePathForMatch(p);
}

async function readFileFromRoot(params: {
  api: OpenClawPluginApi;
  rootId: string;
  relPath: string;
  maxBytes?: number;
}): Promise<{
  rootId: string;
  absPath: string;
  relPath: string;
  truncated: boolean;
  text: string;
}> {
  const { cfg, roots } = await resolveRoots(params.api);
  const root = roots.find((r) => r.id === params.rootId);
  if (!root) {
    throw new Error(`Unknown rootId: ${params.rootId}`);
  }
  if (!root.exists) {
    throw new Error(`Root does not exist: ${root.id} (${root.path})`);
  }

  const rel = params.relPath.trim();
  if (!rel || rel.startsWith("/") || rel.includes("..")) {
    throw new Error("relPath must be a safe, relative path (no absolute paths / ..)");
  }

  const abs = path.normalize(path.join(root.path, rel));
  if (!isWithinRoot(root.path, abs)) {
    throw new Error("Path escapes root");
  }

  // Prevent symlink escape. If followSymlinks=false, we require the resolved
  // path to match the expected canonical target under the resolved root.
  const relFromRoot = path.relative(root.path, abs);
  const rootReal = await fs.realpath(root.path).catch(() => root.path);
  const absReal = await fs.realpath(abs).catch(() => null);
  if (!absReal) {
    throw new Error("File not found");
  }
  if (!isWithinRoot(rootReal, absReal)) {
    throw new Error("Path escapes root (symlink)");
  }
  const expectedReal = path.normalize(path.join(rootReal, relFromRoot));
  if (!cfg.followSymlinks && absReal !== expectedReal) {
    throw new Error("Symlinks are not allowed by policy");
  }

  if (shouldExclude({ filePath: abs, globalExclude: cfg.exclude, rootExclude: root.exclude })) {
    throw new Error("Path is excluded by policy");
  }

  const maxBytes =
    typeof params.maxBytes === "number" && params.maxBytes > 0 ? params.maxBytes : cfg.maxFileBytes;

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error("File not found");
  }
  if (!stat.isFile()) {
    throw new Error("Not a file");
  }

  const truncated = stat.size > maxBytes;
  const buf = await fs.readFile(abs);
  const sliced = truncated ? buf.subarray(0, maxBytes) : buf;
  let text: string;
  try {
    text = sliced.toString("utf8");
  } catch {
    text = String(sliced);
  }

  return { rootId: root.id, absPath: abs, relPath: rel, truncated, text };
}

export function createAudioTools(api: OpenClawPluginApi) {
  const audio_roots = {
    name: "audio_roots",
    description: "List configured game-audio roots and whether they exist.",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      const { cfg, roots } = await resolveRoots(api);
      return json({
        roots,
        limits: {
          maxFileBytes: cfg.maxFileBytes,
          maxHits: cfg.maxHits,
          followSymlinks: cfg.followSymlinks,
        },
        exclude: cfg.exclude,
        includeExtensions: cfg.includeExtensions,
      });
    },
  };

  const audio_search = {
    name: "audio_search",
    description: "Search for a string (or regex) across the configured audio roots. Read-only.",
    parameters: Type.Object(
      {
        query: Type.String({ description: "Text (or regex pattern) to search for." }),
        rootIds: Type.Optional(
          Type.Array(Type.String({ description: "Optional root ids to restrict search." })),
        ),
        regex: Type.Optional(Type.Boolean({ description: "Treat query as regex." })),
        caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive match." })),
        maxHits: Type.Optional(Type.Number({ description: "Override max hits for this search." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const query = typeof params.query === "string" ? params.query : "";
      if (!query.trim()) {
        throw new Error("query required");
      }
      const rootIds = Array.isArray(params.rootIds)
        ? params.rootIds.filter((s) => typeof s === "string")
        : undefined;
      const result = await searchAcrossRoots({
        api,
        query,
        rootIds,
        regex: params.regex === true,
        caseSensitive: params.caseSensitive === true,
        maxHits: typeof params.maxHits === "number" ? params.maxHits : undefined,
      });
      return json({ query, rootIds: rootIds ?? null, ...result });
    },
  };

  const audio_read = {
    name: "audio_read",
    description: "Read a file within a configured root (rootId + relPath). Read-only.",
    parameters: Type.Object(
      {
        rootId: Type.String({ description: "Root id." }),
        relPath: Type.String({ description: "File path relative to the root." }),
        maxBytes: Type.Optional(Type.Number({ description: "Max bytes to read." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const rootId = typeof params.rootId === "string" ? params.rootId : "";
      const relPath = typeof params.relPath === "string" ? params.relPath : "";
      if (!rootId.trim() || !relPath.trim()) {
        throw new Error("rootId and relPath required");
      }
      const result = await readFileFromRoot({
        api,
        rootId,
        relPath,
        maxBytes: typeof params.maxBytes === "number" ? params.maxBytes : undefined,
      });
      return json(result);
    },
  };

  const audio_check_event = {
    name: "audio_check_event",
    description:
      "Heuristic check for a Wwise event name across requirements + Wwise + Unity roots. Read-only.",
    parameters: Type.Object(
      {
        eventName: Type.String({
          description: "Wwise event name (e.g. UI_Activity_Event410Lottery_Draw).",
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const eventName = typeof params.eventName === "string" ? params.eventName : "";
      if (!eventName.trim()) {
        throw new Error("eventName required");
      }

      const [req, wwise, unity] = await Promise.all([
        searchAcrossRoots({ api, query: eventName, rootIds: ["requirements"] }).catch(() => null),
        searchAcrossRoots({ api, query: `Name=\"${eventName}\"`, rootIds: ["wwise"] }).catch(
          () => null,
        ),
        searchAcrossRoots({ api, query: eventName, rootIds: ["unity"] }).catch(() => null),
      ]);

      // Fallback searches if roots aren't named exactly
      const fallback = await searchAcrossRoots({ api, query: eventName }).catch(() => null);

      const details = {
        eventName,
        checks: {
          requirements: req,
          wwiseNameAttr: wwise,
          unityRefs: unity,
          fallback: fallback,
        },
        interpretation: {
          requirementsMentioned: (req?.hits?.length ?? 0) > 0,
          wwiseProbablyDefined: (wwise?.hits?.length ?? 0) > 0,
          unityReferenced: (unity?.hits?.length ?? 0) > 0,
          notes:
            'This tool is heuristic. For Wwise, it looks for Name="<event>" in XML/WWU. If your event is generated or stored differently, use audio_search to locate it.',
        },
      };

      return json(details);
    },
  };

  return [audio_roots, audio_search, audio_read, audio_check_event];
}
