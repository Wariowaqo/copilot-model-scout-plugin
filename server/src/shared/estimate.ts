// Hardware estimates for running an LLM locally. Shared by the Worker and the widget,
// so the numbers in the chat text and in the live widget always match.
//
// All figures are estimates. Real usage depends on the runtime (llama.cpp, Ollama,
// vLLM, MLX, ...), batch size, and how the model is split between GPU and CPU.

export interface QuantLevel {
  id: string;
  label: string;
  /** Approximate effective bits per weight, including quantization scales. */
  bitsPerWeight: number;
  /** 1 (noticeable quality loss) to 5 (indistinguishable from the original). */
  quality: 1 | 2 | 3 | 4 | 5;
  explain: string;
}

// Effective bits per weight are approximate llama.cpp figures. K-quants and I-quants
// mix block sizes, so they don't map to a whole number of bits.
export const QUANT_LEVELS: QuantLevel[] = [
  { id: "F16", label: "FP16 / BF16", bitsPerWeight: 16, quality: 5,
    explain: "The original 16-bit weights. Best quality, biggest download, and the most memory." },
  { id: "Q8_0", label: "Q8_0", bitsPerWeight: 8.5, quality: 5,
    explain: "8-bit. Half the size of FP16 and practically the same answers." },
  { id: "Q6_K", label: "Q6_K", bitsPerWeight: 6.56, quality: 5,
    explain: "6-bit. Very close to the original. A good choice when memory allows." },
  { id: "Q5_K_M", label: "Q5_K_M", bitsPerWeight: 5.69, quality: 4,
    explain: "5-bit, medium mix. A small quality drop that's hard to notice in everyday use." },
  { id: "Q4_K_M", label: "Q4_K_M", bitsPerWeight: 4.85, quality: 4,
    explain: "4-bit, medium mix. The popular default: about a quarter of FP16 with modest quality loss." },
  { id: "Q4_0", label: "Q4_0", bitsPerWeight: 4.55, quality: 3,
    explain: "Basic 4-bit. Slightly smaller than Q4_K_M but loses a little more quality." },
  { id: "Q3_K_M", label: "Q3_K_M", bitsPerWeight: 3.91, quality: 2,
    explain: "3-bit. Fits tight machines, but answers get noticeably less precise." },
  { id: "Q2_K", label: "Q2_K", bitsPerWeight: 3.35, quality: 1,
    explain: "2-bit. Smallest option. Expect clear quality loss; use only if nothing else fits." },
];

export const DEFAULT_QUANT = "Q4_K_M";

/** Model shape needed for an exact KV-cache size. Comes from the repo's config.json. */
export interface KvConfig {
  layers: number;
  kvHeads: number;
  headDim: number;
}

export interface EstimateInput {
  parameters: number;
  quant: string;
  contextLength: number;
  kv?: KvConfig | null;
}

export interface Estimate {
  quant: QuantLevel;
  weightsGB: number;
  kvCacheGB: number;
  overheadGB: number;
  totalGB: number;
  /** True when the KV cache is a rough guess because config.json wasn't available. */
  kvIsRough: boolean;
}

const GB = 1e9;
/** Runtime buffers, CUDA/Metal context, and so on. */
const FIXED_OVERHEAD_GB = 0.5;
/** Extra working memory on top of the weights. */
const WEIGHT_OVERHEAD_RATIO = 0.05;
/** FP16 KV cache. */
const KV_BYTES_PER_VALUE = 2;
/** KV bytes per token for an 8B model with grouped-query attention (32 layers, 8 KV heads, 128 dims). */
const REFERENCE_KV_BYTES_PER_TOKEN_8B = 2 * 32 * 8 * 128 * KV_BYTES_PER_VALUE;

export function findQuant(id: string): QuantLevel {
  const normalized = normalizeQuantId(id);
  return QUANT_LEVELS.find((q) => q.id === normalized) ?? QUANT_LEVELS.find((q) => q.id === DEFAULT_QUANT)!;
}

export function normalizeQuantId(id: string): string {
  const upper = id.trim().toUpperCase().replace(/[-\s]/g, "_");
  if (upper === "FP16" || upper === "BF16" || upper === "F16" || upper === "FP_16") return "F16";
  if (upper === "Q8" || upper === "INT8") return "Q8_0";
  if (upper === "Q6") return "Q6_K";
  if (upper === "Q5" || upper === "Q5_K") return "Q5_K_M";
  if (upper === "Q4" || upper === "Q4_K" || upper === "INT4") return "Q4_K_M";
  if (upper === "Q3" || upper === "Q3_K") return "Q3_K_M";
  if (upper === "Q2") return "Q2_K";
  return upper;
}

export function kvBytesPerToken(parameters: number, kv?: KvConfig | null): { bytes: number; rough: boolean } {
  if (kv && kv.layers > 0 && kv.kvHeads > 0 && kv.headDim > 0) {
    return { bytes: 2 * kv.layers * kv.kvHeads * kv.headDim * KV_BYTES_PER_VALUE, rough: false };
  }
  // Without config.json, scale from a typical 8B grouped-query-attention model.
  return { bytes: (parameters / 8e9) * REFERENCE_KV_BYTES_PER_TOKEN_8B, rough: true };
}

export function estimateMemory(input: EstimateInput): Estimate {
  const quant = findQuant(input.quant);
  const params = Math.max(0, input.parameters);
  const context = Math.max(0, Math.round(input.contextLength));
  const weightsGB = (params * quant.bitsPerWeight) / 8 / GB;
  const kv = kvBytesPerToken(params, input.kv);
  const kvCacheGB = (kv.bytes * context) / GB;
  const overheadGB = FIXED_OVERHEAD_GB + weightsGB * WEIGHT_OVERHEAD_RATIO;
  return {
    quant,
    weightsGB,
    kvCacheGB,
    overheadGB,
    totalGB: weightsGB + kvCacheGB + overheadGB,
    kvIsRough: kv.rough,
  };
}

export type FitStatus = "fits-gpu" | "fits-cpu" | "tight" | "no-fit";

export interface FitResult {
  status: FitStatus;
  headline: string;
  detail: string;
}

/** Memory the operating system and other apps keep for themselves. */
const SYSTEM_RESERVE_GB = 2;

export function checkFit(totalGB: number, ramGB: number, vramGB: number): FitResult {
  const ram = Math.max(0, ramGB);
  const vram = Math.max(0, vramGB);
  const freeRam = Math.max(0, ram - SYSTEM_RESERVE_GB);
  if (vram > 0 && totalGB <= vram * 0.95) {
    return { status: "fits-gpu", headline: "Fits on your GPU",
      detail: `Needs about ${fmtGB(totalGB)} of your ${fmtGB(vram)} GPU memory. Expect fast responses.` };
  }
  if (vram > 0 && totalGB <= vram + freeRam) {
    return { status: "tight", headline: "Runs, split across GPU and CPU",
      detail: `Needs about ${fmtGB(totalGB)}: more than your ${fmtGB(vram)} GPU memory, so part of it runs on the CPU. It works, but slower.` };
  }
  if (totalGB <= freeRam) {
    return { status: vram > 0 ? "tight" : "fits-cpu", headline: vram > 0 ? "Runs on CPU only" : "Fits in your RAM",
      detail: `Needs about ${fmtGB(totalGB)} of your ${fmtGB(ram)} RAM. Runs on the CPU (or unified memory on Apple silicon). Usable, but slower than a GPU.` };
  }
  return { status: "no-fit", headline: "Won't fit",
    detail: `Needs about ${fmtGB(totalGB)}, more than your ${fmtGB(ram)} RAM${vram > 0 ? ` and ${fmtGB(vram)} GPU memory` : ""}. Try a smaller quantization, a shorter context, or a smaller model.` };
}

export function fmtGB(gb: number): string {
  if (!Number.isFinite(gb)) return "unknown";
  if (gb < 1) return `${Math.round(gb * 1000)} MB`;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function fmtParams(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n)) return "unknown";
  if (n >= 1e12) return `${(n / 1e12).toFixed(n >= 1e13 ? 0 : 1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  return `${Math.round(n / 1e3)}K`;
}

export function fmtCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "unknown";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "unknown";
  return fmtGB(bytes / GB);
}

/** The formula shown in the widget and returned to the agent. */
export const FORMULA_TEXT =
  "memory ≈ parameters × bits per weight ÷ 8  +  KV cache (2 × layers × KV heads × head size × 2 bytes × context)  +  ~5% + 0.5 GB runtime overhead";
