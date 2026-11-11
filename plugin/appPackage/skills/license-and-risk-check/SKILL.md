---
name: license-and-risk-check
description: Reviews an open-weight model's license and model card against a checklist before someone uses it in a product. Use when the user asks "can I use X commercially", "what license is X", "is X safe to use at work", "is this model gated", or wants a risk review of a Hugging Face model before adopting it.
---

# License and Risk Check

Review a Hugging Face model against [the license checklist](references/license-checklist.md)
and give a clear, cautious summary. This is not legal advice.

## When to use this skill

- The user asks whether a model can be used commercially, in a product, or at work.
- `model-shortlist` asks for a commercial-license filter.
- The user wants a risk review of a model before adopting it.

## How to do it

1. **Get the facts from the tools, not from memory.**
   - Call the **Model Scout** connector's `show_model_card` (or `compare_models` for several) to get
     the license id, the gated flag, last update, downloads, and task.
   - Call the **Hugging Face** connector's `hub_repo_details` (`repo_ids`, `repo_type: "model"`) to
     read the card metadata when the license is `other`, custom, or unclear, or when the card has
     usage restrictions. For a fine-tune or conversion, also check the base model it names.
2. **Walk the checklist** in `references/license-checklist.md`, one line per item, marking each as
   ✅ OK, ⚠️ check, or ❌ blocker, with a short reason.
3. **Summarize** in this order:
   - One-line verdict: "Looks usable commercially", "Needs review", or "Not for commercial use".
   - The license name and a link to the model page.
   - The ⚠️ and ❌ items only.
   - "This isn't legal advice. Confirm with your legal team before shipping."
4. **Offer alternatives** if there's a blocker: suggest running `model-shortlist` with a
   permissive-license filter.

## What to watch for

- **Never state a license from memory.** If the tools don't return one, say it's unknown.
- **Custom licenses** (`other`, Llama-style community licenses, research-only) always get ⚠️ check,
  even if they seem permissive. Point to the license file in the repo.
- **Derived models** (fine-tunes, merges, GGUF conversions) inherit the base model's license.
  Check the base model too.
- **Gated** means the user must accept terms on Hugging Face before downloading.
- Don't judge the model's output quality or safety benchmarks here. Stay on license and provenance.
