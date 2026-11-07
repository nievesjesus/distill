export interface ConnectClient {
  id: string;
  name: string;
  copy: string;
  snippet: string;
  group: 'mcp' | 'hooks';
}

export const CONNECT_CLIENTS: readonly ConnectClient[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    copy: 'Register distill as an MCP server from your terminal.',
    snippet: 'claude mcp add distill -- npx -y distill-llm mcp',
    group: 'mcp',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    copy: 'Add this to claude_desktop_config.json, then restart the app.',
    snippet: '{\n  "mcpServers": {\n    "distill": {\n      "command": "npx",\n      "args": ["-y", "distill-llm", "mcp"]\n    }\n  }\n}',
    group: 'mcp',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    copy: 'Add this to the mcp section of opencode.json.',
    snippet: '{\n  "mcp": {\n    "distill": {\n      "type": "local",\n      "command": ["npx", "-y", "distill-llm", "mcp"],\n      "enabled": true\n    }\n  }\n}',
    group: 'mcp',
  },
  {
    id: 'codex',
    name: 'Codex',
    copy: 'Add this to ~/.codex/config.toml.',
    snippet: '[mcp_servers.distill]\ncommand = "npx"\nargs = ["-y", "distill-llm", "mcp"]',
    group: 'mcp',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    copy: 'Serve MCP over HTTP and put it behind an HTTPS tunnel with authentication; the server itself has no auth.',
    snippet: 'npx -y distill-llm mcp --http --root ~/shared-docs --allowed-hosts <your-tunnel-host>',
    group: 'mcp',
  },
  {
    id: 'claude-code-hook',
    name: 'Claude Code hook',
    copy: 'Make Claude Code read the distilled Markdown instead of the PDF or Office file. Install distill globally first.',
    snippet: 'npm i -g distill-llm && distillmd hooks install --claude',
    group: 'hooks',
  },
  {
    id: 'opencode-plugin',
    name: 'OpenCode plugin',
    copy: 'Make OpenCode read the distilled Markdown instead of the PDF or Office file (experimental). Install distill globally first.',
    snippet: 'npm i -g distill-llm && distillmd hooks install --opencode',
    group: 'hooks',
  },
];
