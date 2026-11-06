export interface ConnectClient {
  id: string;
  name: string;
  copy: string;
  snippet: string | null;
}

export const CONNECT_CLIENTS: readonly ConnectClient[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    copy: 'Register distill as an MCP server from your terminal.',
    snippet: 'claude mcp add distill -- npx -y distillmd mcp',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    copy: 'Add this to claude_desktop_config.json, then restart the app.',
    snippet: '{\n  "mcpServers": {\n    "distill": {\n      "command": "npx",\n      "args": ["-y", "distillmd", "mcp"]\n    }\n  }\n}',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    copy: 'Add this to the mcp section of opencode.json.',
    snippet: '{\n  "mcp": {\n    "distill": {\n      "type": "local",\n      "command": ["npx", "-y", "distillmd", "mcp"]\n    }\n  }\n}',
  },
  {
    id: 'codex',
    name: 'Codex',
    copy: 'Add this to ~/.codex/config.toml.',
    snippet: '[mcp_servers.distill]\ncommand = "npx"\nargs = ["-y", "distillmd", "mcp"]',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    copy: 'Add a remote MCP connector pointing at your distill HTTP MCP endpoint (coming in v0.2)',
    snippet: null,
  },
];
