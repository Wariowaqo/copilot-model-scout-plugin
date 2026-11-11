---
name: hardware-fit
description: Shows how much RAM or GPU memory an open-weight model needs and whether it runs on the user's machine, with a live model card that explains quantization. Use when the user asks "can I run X locally", "how much VRAM does X need", "will X fit on my laptop / 16 GB / RTX 4090 / Mac", "what does Q4_K_M mean", "which quantization should I use", or asks for a model's size, parameters, downloads, or license.
---

# Hardware Fit

Answer "will this model run on my machine?" with real Hugging Face metadata and a live widget,
using the **Model Scout** connector:

| Tool | Use it to | Inputs |
| --- | --- | --- |
| `show_model_card` | Show one model's live card: parameters, size on disk, downloads, likes, license, GGUF files, memory per quantization, and a "will it run" check | `model_id`, optional `quantization`, `context_length` |
| `compare_models` | Show 2–3 models side by side in the same widget | `model_ids`, optional `quantization`, `context_length` |
| `estimate_hardware` | Get a text-only estimate, optionally checked against the user's RAM and GPU memory | `model_id`, optional `quantization`, `context_length`, `ram_gb`, `vram_gb` |

## When to use this skill

- The user names a model and asks about its size, memory, hardware, or quantization.
- The user describes their machine ("16 GB MacBook", "RTX 4070 with 12 GB") and asks what fits.
- Another skill (such as `model-shortlist`) has produced candidates and the user wants to see them.

## How to do it

1. **Get an exact model id.** Tools need `owner/name` (for example `Qwen/Qwen3-8B`). If the user
   gave a nickname, find the id first with the Hugging Face connector's `hub_repo_search`, then
   confirm it in one line before continuing.
2. **Pick the tool.**
   - One model, user wants to explore → `show_model_card`.
   - Two or three models → `compare_models`.
   - Quick yes/no with known hardware → `estimate_hardware` with `ram_gb` and `vram_gb`.
   Pass `quantization` and `context_length` when the user mentioned them; otherwise leave the
   defaults (Q4_K_M, 8,192 tokens).
3. **Let the widget do the visual work.** In Copilot Chat the card renders inline. Don't repeat
   every number from it. Give a two- or three-sentence takeaway: the memory needed at the
   recommended quantization, whether it fits the user's machine, and one tip (for example
   "Q5_K_M fits too if you want a bit more quality").
4. **Without a widget** (for example in Cowork), summarize the tool's text output as a short table:
   quantization, memory needed, and fits / doesn't fit.
5. **Recommend a quantization** using this rule of thumb: Q4_K_M is the usual sweet spot; Q5_K_M
   or Q6_K when memory allows; Q8_0 or FP16 for evaluation or fine-tuning work; Q3_K_M or Q2_K
   only when nothing else fits.
6. **Offer the next step:** comparing alternatives, a license check (`license-and-risk-check`), or
   Azure deployment (`deploy-on-azure`).

## Explaining quantization (plain language)

- Weights are stored as numbers. FP16 uses 16 bits per weight; Q4 uses about 4–5 bits.
- Fewer bits means a smaller download, less memory, and usually faster responses, with some
  quality loss.
- "K" quants (Q4_K_M, Q5_K_M) mix precision inside each block, so they keep more quality than
  plain Q4_0 at a similar size. S/M/L means small/medium/large mix.
- Memory ≈ parameters × bits per weight ÷ 8, plus the KV cache (grows with context length), plus
  a little runtime overhead.

## What to watch for

- **Estimates, not guarantees.** Say so once. Real usage depends on the runtime (llama.cpp,
  Ollama, vLLM, MLX), batch size, and GPU/CPU split.
- **Apple silicon** uses unified memory: treat it as RAM with `vram_gb: 0`.
- **Gated or private models** can't be read anonymously; the tool says so. Suggest a public
  alternative or the GGUF conversion of the same model.
- **Guessed parameter counts.** If the card says the count was guessed from the name, mention it.
- If the tool errors with a rate limit, wait and retry once, then explain.
