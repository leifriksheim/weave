/**
 * The node as an MCP server, so an agent on the desktop — Claude Desktop,
 * Claude Code, anything that speaks MCP — can read and write your spaces.
 *
 * The tools are `NODE_ACTIONS`, unchanged: the same names, descriptions and
 * input schemas the CLI and WebMCP use. What an agent may do is therefore
 * exactly what the account may do, through the same gates.
 *
 * Only the stdio transport and the tools capability are implemented — a few
 * JSON-RPC methods over newline-delimited JSON. stdout carries protocol
 * messages only; anything human-readable goes to stderr.
 */
import { createInterface } from 'node:readline';
import { NODE_ACTIONS, runAction, type P2PNode } from '../../src/index.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

/** Actions that remove something; clients use the hint to ask before running them. */
const DESTRUCTIVE = new Set(['spaces_leave', 'records_delete', 'records_update']);

export function mcpTools() {
  return NODE_ACTIONS.map((action) => ({
    name: action.name,
    description: action.sensitive ? `${action.description} Confirm with the user before sharing the result.` : action.description,
    inputSchema: action.input,
    annotations: {
      readOnlyHint: action.readOnly,
      destructiveHint: DESTRUCTIVE.has(action.name),
      idempotentHint: action.readOnly,
      openWorldHint: false,
    },
  }));
}

/**
 * Handles one JSON-RPC message.
 * @returns The response, or null for a notification
 */
export async function handleMcpMessage(
  node: P2PNode,
  message: JsonRpcRequest,
  serverInfo: { name: string; version: string },
): Promise<JsonRpcResponse | null> {
  const isNotification = message.id === undefined;
  const id = message.id ?? null;
  const reply = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code: number, text: string): JsonRpcResponse | null =>
    isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: text } };

  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions:
          `You are acting for the identity ${node.did}. Spaces hold signed records in named collections ` +
          '(e.g. "app.todo.item"); start with spaces_list. Writes are signed and synced to every member of the space.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: mcpTools() });
    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string') return fail(-32602, 'tools/call needs a tool name');
      try {
        const result = await runAction(node, name, message.params?.arguments ?? {});
        const structured = result !== null && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : { result };
        return reply({
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: structured,
          isError: false,
        });
      } catch (error) {
        // A failed tool is a result the model should read, not a protocol error.
        return reply({
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${message.method}`);
  }
}

/** Serves MCP over stdin/stdout until stdin closes. */
export async function runMcpStdio(node: P2PNode, serverInfo: { name: string; version: string }): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (response: JsonRpcResponse) => process.stdout.write(`${JSON.stringify(response)}\n`);

  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(line) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    // Handled concurrently, answered as each finishes — ids tie them together.
    void handleMcpMessage(node, message, serverInfo).then((response) => {
      if (response) write(response);
    });
  }
}
