---
name: deploy-on-azure
description: Explains how to deploy an open-weight Hugging Face model on Azure, choosing between Azure AI Foundry and self-hosting on Azure Container Apps or AKS with GPUs, with steps cited from Microsoft Learn. Use when the user asks "how do I deploy X on Azure", "host this model in Azure", "run X in Foundry", "serverless GPU for X", or selects Deploy on Azure in the Model Scout widget.
---

# Deploy on Azure

Turn a chosen model into a cited Azure deployment plan, using the **Microsoft Learn**
connector's tools:

| Tool | Use it to |
| --- | --- |
| `microsoft_docs_search` | Find current deployment docs (Foundry model catalog, Hugging Face models in Foundry, Container Apps serverless GPUs, AKS GPU node pools) |
| `microsoft_docs_fetch` | Read the one to three most relevant pages in full for steps, prerequisites, quotas, and region limits |
| `microsoft_code_sample_search` | Get official CLI, Bicep, or SDK snippets |

## When to use this skill

- The user picked a model and asks how to run it on Azure.
- The Model Scout widget sends "How do I deploy … on Azure?" after the user selects **Deploy on Azure**.

## How to do it

1. **Collect the inputs** from the conversation or the widget message: model id, quantization,
   context length, and the memory estimate. If the memory estimate is missing, call the
   **Model Scout** connector's `estimate_hardware` for the chosen quantization.
2. **Search Learn** for both paths, with specific queries:
   - "deploy Hugging Face model Azure AI Foundry managed compute"
   - "Azure Container Apps serverless GPU deploy open source model"
   Then fetch the best page for each path.
3. **Recommend a path** with a short comparison table (setup effort, scaling, cost model, GPU
   choice, best for):
   - **Azure AI Foundry**: when the model is in the Foundry catalog and the user wants a managed
     endpoint.
   - **Azure Container Apps (serverless GPU)**: when the user wants their own container (for
     example vLLM, Ollama, or llama.cpp server) with scale to zero.
   - **AKS with GPU node pools**: for large or high-throughput deployments.
4. **Size the GPU** from the memory estimate. Pick a GPU whose memory exceeds the estimate with
   headroom. Only name GPU types and SKUs that appear in the fetched docs.
5. **Give numbered steps** for the recommended path, with commands from
   `microsoft_code_sample_search` or the fetched page.
6. **Cite** every page used (title and URL) at the end.

## What to watch for

- **Don't invent** SKUs, regions, quotas, or prices. If the docs don't say, tell the user where to check.
- **GPU quota** often blocks a first deployment. Mention requesting quota early.
- **License** still applies on Azure. If it hasn't been checked, suggest `license-and-risk-check`.
- **Gated models** need a Hugging Face token at deployment time. Tell the user to store it in Azure
  Key Vault, never in code or chat.
