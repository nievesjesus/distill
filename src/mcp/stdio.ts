import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export async function connectStdio(server: McpServer, onClose: () => void): Promise<void> {
  const transport = new StdioServerTransport();
  transport.onclose = onClose;
  await server.connect(transport);
}
