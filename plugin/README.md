# AI Model Scout

A Microsoft 365 Copilot plugin (Copilot Cowork and Copilot Chat) that helps you pick an open-weight
AI model, see what hardware it needs, check its license, and deploy it on Azure.

> *"Find an open-weight model for Dutch invoice extraction with a commercial license, compare the top 3,
> show me what hardware I need, and tell me how to deploy it on Azure."*

In Copilot Chat, model details render as a **live widget**. Change the quantization or context length
and the RAM/GPU numbers update while you watch. Enter your machine's memory and it tells you whether the
model fits.

## What's inside

| Part | Details |
| --- | --- |
| **Connectors (3)** | **Model Scout** (your own MCP server with the widget, see [`../server`](../server))<br>**Hugging Face** (`https://huggingface.co/mcp`, official, anonymous)<br>**Microsoft Learn** (`https://learn.microsoft.com/api/mcp`, official, anonymous) |
| **Skills (4)** | `model-shortlist`, `hardware-fit`, `license-and-risk-check` (with `references/license-checklist.md`), `deploy-on-azure` |
| **Declarative agent** | Instructions, six conversation starters, Code Interpreter |
| **Copilot Chat actions (3)** | The same three MCP servers as anonymous actions (`ai-plugin*.json`), with dynamic tool discovery, so Copilot reads each server's tools live |

Every tool on all three servers is annotated read-only, so Cowork runs them without confirmation prompts.

## Tool names the skills depend on

Re-check these before you publish or post a demo. Servers add and rename tools.

| Server | Tools |
| --- | --- |
| Model Scout | `show_model_card`, `compare_models`, `estimate_hardware` |
| Hugging Face (0.4.34 on 2026-11-10) | `hub_repo_search`, `hub_repo_details` (also exposes `hf_whoami`, `hf_fs`) |
| Microsoft Learn | `microsoft_docs_search`, `microsoft_docs_fetch`, `microsoft_code_sample_search` |

The `*-tools.json` files in `appPackage/` are the `tools/list` snapshots Cowork needs.

## Install

1. Deploy the Model Scout server (or use an existing deployment). See its README.
2. Set your values. `appPackage/manifest.json` and `ai-plugin.json` use placeholders that are filled
   in from the env file when you provision:

   | Variable | Example |
   | --- | --- |
   | `MODEL_SCOUT_MCP_URL` | `https://model-scout-mcp.<your-subdomain>.workers.dev/mcp` |
   | `DEVELOPER_NAME`, `DEVELOPER_WEBSITE_URL`, `DEVELOPER_PRIVACY_URL`, `DEVELOPER_TERMS_URL` | Your publisher details |

   `env/.env.dev` holds examples. For `--env local`, create `env/.env.local` with the same variables;
   it's git-ignored, and provisioning writes your app and tenant IDs into it. Also replace
   `publisher-email@example.com` in the three `ai-plugin*.json` files.
3. Validate, provision, and test:

   ```powershell
   wiqd plugin validate --mode source --path . --env dev
   wiqd plugin provision --env local
   ```

4. Open the install link that `provision` prints.

## Known limits

- **Widgets render in Copilot Chat, not Cowork.** Cowork gets the same data as text.
- **Memory numbers are estimates.** Real usage depends on the runtime and settings.
- **License notes aren't legal advice.**
- **Gated models** (for example Llama) can't be read anonymously, so some details are missing.
- **Third-party servers.** Hugging Face and Microsoft run their MCP servers; check their terms and
  rate limits before you promote a public plugin built on them.
