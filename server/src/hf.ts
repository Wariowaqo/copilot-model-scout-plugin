// Reads public model metadata from the Hugging Face Hub API.
// Everything returned by the Hub is untrusted: it is only ever treated as data,
// and the widget renders it as text.

import type { KvConfig } from "./shared/estimate";
import type { ModelSummary } from "./shared/types";

const HUB = "https://huggingface.co";
const CACHE_TTL_SECONDS = 600;
const TIMEOUT_MS = 8000;
const USER_AGENT = "model-scout-mcp/0.1";

const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,94}[A-Za-z0-9_])?$/;

/** Accepts "owner/name" only. Rejects URLs, path traversal, and anything unusual. */
export function parseModelId(raw: string): string {
  let id = raw.trim();
  const urlPrefix = /^https?:\/\/(www\.)?huggingface\.co\//i;
  if (urlPrefix.test(id)) id = id.replace(urlPrefix, "").split(/[?#]/)[0].replace(/\/+$/, "");
  const parts = id.split("/");
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p)) || parts.some((p) => p.includes(".."))) {
    throw new UserError(`"${raw.slice(0, 80)}" isn't a Hugging Face model id. Use the form owner/name, for example Qwen/Qwen3-8B.`);
  }
  return parts.join("/");
}

export class UserError extends Error {}

async function hubJson<T>(path: string, { optional = false } = {}): Promise<T | null> {
  const url = `${HUB}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    } as RequestInit);
  } catch (err) {
    if (optional) return null;
    throw new UserError(`Hugging Face didn't answer in time (${(err as Error).name}). Try again in a moment.`);
  }
  if (res.status === 404) {
    if (optional) return null;
    throw new UserError("Model not found on Hugging Face. Check the owner/name spelling.");
  }
  if (res.status === 401 || res.status === 403) {
    if (optional) return null;
    throw new UserError("This model is private or gated, so its details can't be read anonymously.");
  }
  if (res.status === 429) {
    if (optional) return null;
    throw new UserError("Hugging Face is rate-limiting requests right now. Try again in a minute.");
  }
  if (!res.ok) {
    if (optional) return null;
    throw new UserError(`Hugging Face returned HTTP ${res.status}.`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    if (optional) return null;
    throw new UserError("Hugging Face returned a response that isn't JSON.");
  }
}

// Shapes below list only the fields this server reads. Every field is optional,
// because the Hub adds and drops fields and they vary by repo.
interface HubModelInfo {
  id?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  pipeline_tag?: string;
  library_name?: string;
  gated?: false | "auto" | "manual" | boolean;
  tags?: string[];
  cardData?: { license?: string | string[]; license_name?: string };
  safetensors?: { parameters?: Record<string, number>; total?: number };
  gguf?: { total?: number; architecture?: string; context_length?: number };
  config?: { architectures?: string[]; model_type?: string };
}

interface HubTreeEntry {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { size?: number };
}

interface HfConfig {
  num_hidden_layers?: number;
  n_layer?: number;
  num_attention_heads?: number;
  num_key_value_heads?: number;
  hidden_size?: number;
  head_dim?: number;
  max_position_embeddings?: number;
  text_config?: HfConfig;
}

const encodeId = (id: string) => id.split("/").map(encodeURIComponent).join("/");

export async function loadModel(rawId: string): Promise<ModelSummary> {
  const id = parseModelId(rawId);
  const warnings: string[] = [];

  const [info, tree, config] = await Promise.all([
    hubJson<HubModelInfo>(`/api/models/${encodeId(id)}`),
    hubJson<HubTreeEntry[]>(`/api/models/${encodeId(id)}/tree/main?recursive=true`, { optional: true }),
    hubJson<HfConfig>(`/${encodeId(id)}/resolve/main/config.json`, { optional: true }),
  ]);
  if (!info) throw new UserError("Model not found on Hugging Face.");

  const files = Array.isArray(tree) ? tree.filter((e) => e && e.type === "file" && typeof e.path === "string") : [];
  if (!Array.isArray(tree)) warnings.push("File list unavailable, so file sizes are missing.");

  const fileSize = (e: HubTreeEntry) => (typeof e.lfs?.size === "number" ? e.lfs.size : typeof e.size === "number" ? e.size : 0);
  const weightFiles = files.filter((e) => /\.(safetensors|bin|pt|pth)$/i.test(e.path!) && !/(^|\/)(optimizer|training_args)/i.test(e.path!));
  const weightsSize = weightFiles.reduce((sum, e) => sum + fileSize(e), 0);

  const ggufFiles = files
    .filter((e) => /\.gguf$/i.test(e.path!))
    .map((e) => ({ quant: quantFromFilename(e.path!), file: slug(e.path, 200) ?? "file.gguf", sizeBytes: fileSize(e) }))
    .filter((f) => f.sizeBytes > 0)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .slice(0, 24);

  let parameters: number | null = null;
  let parametersSource: ModelSummary["parametersSource"] = null;
  let nativeDtype: string | null = null;
  if (typeof info.safetensors?.total === "number" && info.safetensors.total > 0) {
    parameters = info.safetensors.total;
    parametersSource = "safetensors";
    const byDtype = Object.entries(info.safetensors.parameters ?? {}).sort((a, b) => b[1] - a[1]);
    nativeDtype = slug(byDtype[0]?.[0], 16);
  } else if (typeof info.gguf?.total === "number" && info.gguf.total > 0) {
    parameters = info.gguf.total;
    parametersSource = "gguf";
  } else {
    const guessed = paramsFromName(id);
    if (guessed) {
      parameters = guessed;
      parametersSource = "name";
      warnings.push("Parameter count is a guess from the model name.");
    } else {
      warnings.push("Parameter count unknown, so memory can't be estimated.");
    }
  }

  const cfg = config?.text_config ?? config ?? null;
  const kv = kvFromConfig(cfg);
  if (!kv) warnings.push("config.json unavailable, so the KV-cache size is a rough estimate.");

  const licenseTag = Array.isArray(info.tags) ? info.tags.find((t) => typeof t === "string" && t.startsWith("license:")) : undefined;
  const licenseRaw = info.cardData?.license ?? licenseTag?.slice("license:".length);
  const license = Array.isArray(licenseRaw) ? licenseRaw.map((l) => slug(l)).filter(Boolean).join(", ") || null : slug(licenseRaw);
  const licenseName = slug(info.cardData?.license_name);

  return {
    id,
    author: slug(info.author) ?? id.split("/")[0],
    url: `${HUB}/${id}`,
    task: slug(info.pipeline_tag),
    library: slug(info.library_name),
    license: license === "other" && licenseName ? `other (${licenseName})` : license,
    gated: Boolean(info.gated),
    downloads: num(info.downloads),
    likes: num(info.likes),
    lastModified: isoDate(info.lastModified),
    parameters,
    parametersSource,
    nativeDtype,
    architecture: slug(info.gguf?.architecture) ?? slug(info.config?.architectures?.[0]) ?? slug(info.config?.model_type),
    maxContext: num(info.gguf?.context_length) ?? num(cfg?.max_position_embeddings),
    kv,
    weightsSizeBytes: weightsSize > 0 ? weightsSize : null,
    ggufFiles,
    warnings,
  };
}

export function kvFromConfig(cfg: HfConfig | null | undefined): KvConfig | null {
  if (!cfg) return null;
  const layers = num(cfg.num_hidden_layers) ?? num(cfg.n_layer);
  const heads = num(cfg.num_attention_heads);
  const kvHeads = num(cfg.num_key_value_heads) ?? heads;
  const headDim = num(cfg.head_dim) ?? (cfg.hidden_size && heads ? cfg.hidden_size / heads : null);
  if (!layers || !kvHeads || !headDim) return null;
  return { layers, kvHeads, headDim };
}

export function quantFromFilename(file: string): string {
  const name = file.split("/").pop() ?? file;
  const m = name.match(/(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Z0-9]+){0,2}|BF16|F16|FP16|F32)(?=[-_.]|$)/i);
  return m ? m[1].toUpperCase() : "GGUF";
}

export function paramsFromName(id: string): number | null {
  // Matches "8B", "0.5B", "70b", "1.5B", "125M"; for mixtures like "8x7B" multiplies.
  const name = id.split("/")[1] ?? id;
  const moe = name.match(/(\d+)x(\d+(?:\.\d+)?)([BM])(?![a-z])/i);
  if (moe) return Number(moe[1]) * Number(moe[2]) * (moe[3].toUpperCase() === "B" ? 1e9 : 1e6);
  const m = name.match(/(?:^|[-_.])(\d+(?:\.\d+)?)([BM])(?![a-z])/i);
  if (!m) return null;
  return Number(m[1]) * (m[2].toUpperCase() === "B" ? 1e9 : 1e6);
}

/**
 * Hub metadata is written by model authors and reaches the agent as tool text. Keep only
 * the characters a license id, task, library, author, dtype or file name needs, so a repo
 * can't smuggle markdown, links, table pipes, line breaks or long instructions into it.
 */
export function slug(v: unknown, max = 64): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[^A-Za-z0-9._+\-/ ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return cleaned || null;
}

/** Accepts ISO 8601 dates and timestamps only. */
export function isoDate(v: unknown): string | null {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
