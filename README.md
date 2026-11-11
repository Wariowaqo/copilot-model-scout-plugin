# AI Model Scout for Microsoft 365 Copilot

A Microsoft 365 Copilot plugin that helps you pick an open-weight AI model from Hugging Face, see what
hardware it needs, check its license, and deploy it on Azure. In Copilot Chat, model details render as a
live **MCP App** widget: change the quantization or context length and the RAM/GPU estimate updates
while you watch.

| Folder | What it is |
| --- | --- |
| [`plugin/`](plugin) | The plugin package, built with [wiqd (Work IQ Dev Tools)](https://github.com/microsoft/wiqd): a declarative agent, four skills, and three MCP connectors (Model Scout, Hugging Face, Microsoft Learn) |
| [`server/`](server) | The Model Scout MCP server for Cloudflare Workers. It reads public Hugging Face Hub data and serves the interactive widget |

## Where it runs

- **Copilot Chat**: the declarative agent uses the skills and MCP servers, and the widget renders inline.
- **Copilot Cowork**: the skills and connectors work directly. Cowork shows the same answers as text.

## Quick start

1. Deploy the server: see [`server/README.md`](server/README.md).
2. Point the plugin at your server and provision it: see [`plugin/README.md`](plugin/README.md).

## Status

This is a demo and learning project, not a supported product. wiqd and the MCP Apps support in
Microsoft 365 Copilot are both in preview. The server uses anonymous auth, which Microsoft's docs
describe as a development option. Memory figures are estimates, and license notes aren't legal advice.

Not affiliated with Hugging Face or Microsoft.

## Learn more

- [What is a Microsoft 365 Copilot plugin?](https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugins-overview)
- [Build plugins for Copilot Cowork](https://learn.microsoft.com/microsoft-365/copilot/cowork/cowork-plugin-development)
- [Add MCP apps to declarative agents](https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugin-mcp-apps)
- [MCP Apps overview](https://modelcontextprotocol.github.io/ext-apps/api/documents/Overview.html)

## License

[MIT](LICENSE)
