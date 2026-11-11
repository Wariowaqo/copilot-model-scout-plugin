import { describe, expect, it } from "vitest";
import { checkFit, estimateMemory, findQuant, fmtGB, fmtParams, kvBytesPerToken, normalizeQuantId } from "../src/shared/estimate";

const KV_8B = { layers: 32, kvHeads: 8, headDim: 128 };

describe("estimateMemory", () => {
  it("computes weights from parameters and bits per weight", () => {
    const e = estimateMemory({ parameters: 8e9, quant: "F16", contextLength: 0, kv: KV_8B });
    expect(e.weightsGB).toBeCloseTo(16, 5);
    expect(e.kvCacheGB).toBe(0);
    expect(e.overheadGB).toBeCloseTo(0.5 + 16 * 0.05, 5);
  });

  it("makes Q4_K_M much smaller than FP16", () => {
    const f16 = estimateMemory({ parameters: 8e9, quant: "F16", contextLength: 8192, kv: KV_8B });
    const q4 = estimateMemory({ parameters: 8e9, quant: "Q4_K_M", contextLength: 8192, kv: KV_8B });
    expect(q4.weightsGB).toBeCloseTo((8e9 * 4.85) / 8 / 1e9, 5);
    expect(q4.totalGB).toBeLessThan(f16.totalGB / 2.5);
  });

  it("computes an exact KV cache from config", () => {
    // 2 (K and V) × 32 layers × 8 heads × 128 dims × 2 bytes = 131,072 bytes per token
    expect(kvBytesPerToken(8e9, KV_8B)).toEqual({ bytes: 131072, rough: false });
    const e = estimateMemory({ parameters: 8e9, quant: "Q4_K_M", contextLength: 8192, kv: KV_8B });
    expect(e.kvCacheGB).toBeCloseTo((131072 * 8192) / 1e9, 6);
    expect(e.kvIsRough).toBe(false);
  });

  it("falls back to a scaled KV estimate without config", () => {
    const r = kvBytesPerToken(16e9, null);
    expect(r.rough).toBe(true);
    expect(r.bytes).toBeCloseTo(262144, 0);
  });

  it("grows with context length", () => {
    const a = estimateMemory({ parameters: 8e9, quant: "Q4_K_M", contextLength: 4096, kv: KV_8B });
    const b = estimateMemory({ parameters: 8e9, quant: "Q4_K_M", contextLength: 131072, kv: KV_8B });
    expect(b.totalGB - a.totalGB).toBeCloseTo((131072 - 4096) * 131072 / 1e9, 5);
  });

  it("clamps negative input", () => {
    const e = estimateMemory({ parameters: -1, quant: "Q4_K_M", contextLength: -5 });
    expect(e.weightsGB).toBe(0);
    expect(e.kvCacheGB).toBe(0);
  });
});

describe("quant ids", () => {
  it("normalizes common spellings", () => {
    expect(normalizeQuantId("bf16")).toBe("F16");
    expect(normalizeQuantId("fp16")).toBe("F16");
    expect(normalizeQuantId("q4")).toBe("Q4_K_M");
    expect(normalizeQuantId("Q5-K-M")).toBe("Q5_K_M");
    expect(normalizeQuantId("int8")).toBe("Q8_0");
  });
  it("falls back to Q4_K_M for unknown ids", () => {
    expect(findQuant("banana").id).toBe("Q4_K_M");
  });
});

describe("checkFit", () => {
  it("fits on the GPU when VRAM is enough", () => {
    expect(checkFit(6, 16, 8).status).toBe("fits-gpu");
  });
  it("splits across GPU and CPU when VRAM is short but RAM helps", () => {
    const r = checkFit(12, 16, 8);
    expect(r.status).toBe("tight");
    expect(r.headline).toMatch(/split/);
  });
  it("fits in RAM on a machine without a GPU", () => {
    expect(checkFit(10, 16, 0).status).toBe("fits-cpu");
  });
  it("keeps a system reserve", () => {
    expect(checkFit(15, 16, 0).status).toBe("no-fit");
  });
  it("reports no fit when nothing is enough", () => {
    expect(checkFit(40, 16, 8).status).toBe("no-fit");
  });
});

describe("formatting", () => {
  it("formats sizes and counts", () => {
    expect(fmtGB(0.5)).toBe("500 MB");
    expect(fmtGB(5.04)).toBe("5.0 GB");
    expect(fmtGB(48.6)).toBe("49 GB");
    expect(fmtParams(8.19e9)).toBe("8.2B");
    expect(fmtParams(70.6e9)).toBe("71B");
    expect(fmtParams(null)).toBe("unknown");
  });
});
