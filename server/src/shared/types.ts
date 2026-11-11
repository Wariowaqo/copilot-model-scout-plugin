import type { KvConfig } from "./estimate";

/** Summary of one Hugging Face model, sent to the agent and the widget as structuredContent. */
export interface ModelSummary {
  id: string;
  author: string | null;
  url: string;
  task: string | null;
  library: string | null;
  license: string | null;
  gated: boolean;
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  parameters: number | null;
  /** Where the parameter count came from. "name" means it was parsed from the model id and is a guess. */
  parametersSource: "safetensors" | "gguf" | "name" | null;
  /** Storage dtype of the original weights, for example "BF16". */
  nativeDtype: string | null;
  architecture: string | null;
  maxContext: number | null;
  kv: KvConfig | null;
  /** Total size of the weight files in the repo. */
  weightsSizeBytes: number | null;
  /** Prequantized GGUF files in the repo, if any. */
  ggufFiles: { quant: string; file: string; sizeBytes: number }[];
  /** Non-fatal problems while loading, shown in the widget. */
  warnings: string[];
}

export interface WidgetPayload {
  view: "card" | "compare";
  models: ModelSummary[];
  /** Selected quantization and context length when the tool was called. */
  quant: string;
  contextLength: number;
  fetchedAt: string;
}
