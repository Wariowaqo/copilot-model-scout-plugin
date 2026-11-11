import { McpServer } from "@modelcontextprotocol/server";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { loadModel, UserError } from "./hf";
import {
  checkFit,
  DEFAULT_QUANT,
  estimateMemory,
  findQuant,
  fmtBytes,
  fmtCount,
  fmtGB,
  fmtParams,
  FORMULA_TEXT,
  QUANT_LEVELS,
} from "./shared/estimate";
import type { ModelSummary, WidgetPayload } from "./shared/types";
import { WIDGET_HTML } from "./generated/widget-html";

export const SERVER_NAME = "model-scout";
export const SERVER_VERSION = "0.1.0";
export const WIDGET_URI = "ui://model-scout/model-card.html";

const DEFAULT_CONTEXT = 8192;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const modelIdSchema = z
  .string()
  .min(3)
  .max(200)
  .describe('Hugging Face model id in the form "owner/name", for example "Qwen/Qwen3-8B". A huggingface.co URL also works.');
const quantSchema = z
  .string()
  .max(20)
  .optional()
  .describe(`Quantization level to preselect: ${QUANT_LEVELS.map((q) => q.id).join(", ")}. Defaults to ${DEFAULT_QUANT}.`);
const contextSchema = z
  .number()
  .int()
  .min(256)
  .max(1_048_576)
  .optional()
  .describe(`Context length in tokens used for the KV-cache estimate. Defaults to ${DEFAULT_CONTEXT}.`);

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerAppResource(
    server,
    "Model Scout card",
    WIDGET_URI,
    { description: "Interactive model card: size, downloads, quantization, and the RAM/GPU needed to run the model." },
    async () => ({
      contents: [
        {
          uri: WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: WIDGET_HTML,
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "show_model_card",
    {
      title: "Show model card",
      description:
        "Shows a live model card for one open-weight Hugging Face model: parameter count, size on disk, downloads, likes, license, last update, available GGUF quantizations, and the RAM/GPU memory needed at each quantization level. The user can change quantization and context length in the card and check whether it runs on their machine. Use when the user asks about a specific model's size, hardware requirements, quantization, or whether it will run locally.",
      inputSchema: z.object({ model_id: modelIdSchema, quantization: quantSchema, context_length: contextSchema }),
      annotations: { title: "Show model card", ...READ_ONLY },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ model_id, quantization, context_length }) =>
      run(async () => {
        const model = await loadModel(model_id);
        const payload = makePayload("card", [model], quantization, context_length);
        return { text: modelText(model, payload), payload };
      }),
  );

  registerAppTool(
    server,
    "compare_models",
    {
      title: "Compare models",
      description:
        "Compares two or three Hugging Face models side by side in a live widget: parameters, size, downloads, likes, license, and the memory each needs at the selected quantization and context length. Use after shortlisting candidates, or when the user asks to compare specific models.",
      inputSchema: z.object({
        model_ids: z.array(modelIdSchema).min(2).max(3).describe("Two or three Hugging Face model ids."),
        quantization: quantSchema,
        context_length: contextSchema,
      }),
      annotations: { title: "Compare models", ...READ_ONLY },
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ model_ids, quantization, context_length }) =>
      run(async () => {
        const unique = [...new Set(model_ids.map((m) => m.trim()))];
        const results = await Promise.allSettled(unique.map((id) => loadModel(id)));
        const models: ModelSummary[] = [];
        const failures: string[] = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") models.push(r.value);
          else failures.push(`${unique[i].slice(0, 80)}: ${errorMessage(r.reason)}`);
        });
        if (models.length === 0) throw new UserError(`None of the models could be loaded. ${failures.join(" ")}`);
        if (failures.length) models[0].warnings.push(...failures.map((f) => `Skipped ${f}`));
        const payload = makePayload("compare", models, quantization, context_length);
        const text = [
          `Comparison at ${payload.quant}, ${payload.contextLength.toLocaleString("en-US")}-token context:`,
          "",
          "| Model | Parameters | Downloads | Likes | License | Memory needed |",
          "| --- | --- | --- | --- | --- | --- |",
          ...models.map((m) => {
            const est = m.parameters ? estimateMemory({ parameters: m.parameters, quant: payload.quant, contextLength: payload.contextLength, kv: m.kv }) : null;
            return `| ${m.id} | ${fmtParams(m.parameters)} | ${fmtCount(m.downloads)} | ${fmtCount(m.likes)} | ${m.license ?? "unknown"} | ${est ? fmtGB(est.totalGB) : "unknown"} |`;
          }),
          ...(failures.length ? ["", `Not loaded: ${failures.join("; ")}`] : []),
          "",
          "Memory figures are estimates. The user can change quantization and context length in the widget.",
        ].join("\n");
        return { text, payload };
      }),
  );

  server.registerTool(
    "estimate_hardware",
    {
      title: "Estimate hardware",
      description:
        "Estimates the RAM or GPU memory needed to run a Hugging Face model at a given quantization and context length, and optionally checks it against the user's machine. Returns text only. Use for a quick answer such as \"can I run X on 16 GB?\"; use show_model_card when the user wants to explore options.",
      inputSchema: z.object({
        model_id: modelIdSchema,
        quantization: quantSchema,
        context_length: contextSchema,
        ram_gb: z.number().min(0).max(4096).optional().describe("The user's system RAM in GB, if known."),
        vram_gb: z.number().min(0).max(4096).optional().describe("The user's GPU memory in GB, if known. Use 0 for no dedicated GPU."),
      }),
      annotations: { title: "Estimate hardware", ...READ_ONLY },
    },
    async ({ model_id, quantization, context_length, ram_gb, vram_gb }) =>
      run(async () => {
        const model = await loadModel(model_id);
        if (!model.parameters) throw new UserError(`The parameter count for ${model.id} is unknown, so memory can't be estimated.`);
        const quant = findQuant(quantization ?? DEFAULT_QUANT);
        const contextLength = context_length ?? DEFAULT_CONTEXT;
        const est = estimateMemory({ parameters: model.parameters, quant: quant.id, contextLength, kv: model.kv });
        const lines = [
          `${model.id} (${fmtParams(model.parameters)} parameters) at ${quant.label}, ${contextLength.toLocaleString("en-US")}-token context:`,
          `- Weights: ${fmtGB(est.weightsGB)}`,
          `- KV cache: ${fmtGB(est.kvCacheGB)}${est.kvIsRough ? " (rough, config.json unavailable)" : ""}`,
          `- Runtime overhead: ${fmtGB(est.overheadGB)}`,
          `- Total: about ${fmtGB(est.totalGB)}`,
          `- Quantization: ${quant.explain}`,
        ];
        if (ram_gb != null || vram_gb != null) {
          const fit = checkFit(est.totalGB, ram_gb ?? 0, vram_gb ?? 0);
          lines.push(`- On this machine: ${fit.headline}. ${fit.detail}`);
        }
        lines.push("", `Estimate only. Formula: ${FORMULA_TEXT}`);
        return {
          text: lines.join("\n"),
          structured: { model: model.id, parameters: model.parameters, quantization: quant.id, context_length: contextLength, ...roundAll(est) },
        };
      }),
  );

  return server;
}

function makePayload(view: WidgetPayload["view"], models: ModelSummary[], quant: string | undefined, context: number | undefined): WidgetPayload {
  return {
    view,
    models,
    quant: findQuant(quant ?? DEFAULT_QUANT).id,
    contextLength: context ?? DEFAULT_CONTEXT,
    fetchedAt: new Date().toISOString(),
  };
}

function modelText(m: ModelSummary, p: WidgetPayload): string {
  const lines = [
    `**${m.id}** (${m.url})`,
    `- Parameters: ${fmtParams(m.parameters)}${m.parametersSource === "name" ? " (guessed from the name)" : ""}`,
    `- Weights on disk: ${fmtBytes(m.weightsSizeBytes)}${m.nativeDtype ? ` (${m.nativeDtype})` : ""}`,
    `- Downloads (last 30 days): ${fmtCount(m.downloads)} · Likes: ${fmtCount(m.likes)}`,
    `- License: ${m.license ?? "unknown"}${m.gated ? " · gated (accept terms on Hugging Face)" : ""}`,
    `- Task: ${m.task ?? "unknown"} · Library: ${m.library ?? "unknown"}`,
    `- Last updated: ${m.lastModified?.slice(0, 10) ?? "unknown"}`,
  ];
  if (m.ggufFiles.length) lines.push(`- GGUF files: ${m.ggufFiles.map((f) => `${f.quant} (${fmtBytes(f.sizeBytes)})`).join(", ")}`);
  if (m.parameters) {
    lines.push("", `Estimated memory at ${p.contextLength.toLocaleString("en-US")}-token context:`);
    for (const id of ["F16", "Q8_0", "Q4_K_M"]) {
      const est = estimateMemory({ parameters: m.parameters, quant: id, contextLength: p.contextLength, kv: m.kv });
      lines.push(`- ${est.quant.label}: about ${fmtGB(est.totalGB)}`);
    }
  }
  if (m.warnings.length) lines.push("", `Notes: ${m.warnings.join(" ")}`);
  lines.push("", "Estimates only. The widget lets the user change quantization and context length.");
  return lines.join("\n");
}

type ToolOutput = { text: string; payload?: WidgetPayload; structured?: Record<string, unknown> };

async function run(fn: () => Promise<ToolOutput>) {
  try {
    const out = await fn();
    const structuredContent = (out.payload ?? out.structured) as Record<string, unknown> | undefined;
    return {
      content: [{ type: "text" as const, text: out.text }],
      ...(structuredContent ? { structuredContent } : {}),
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: errorMessage(err) }] };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof UserError) return err.message;
  console.error("model-scout tool error", err);
  return "Something went wrong while reading Hugging Face. Try again in a moment.";
}

function roundAll(est: ReturnType<typeof estimateMemory>) {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    weights_gb: r(est.weightsGB),
    kv_cache_gb: r(est.kvCacheGB),
    overhead_gb: r(est.overheadGB),
    total_gb: r(est.totalGB),
    kv_is_rough: est.kvIsRough,
  };
}
