/**
 * WebMCP: the node's operations as tools an AI agent in the browser can call.
 *
 * Every tool comes from `NODE_ACTIONS` — the same list the CLI and the MCP
 * server are generated from — so an agent in this tab sees exactly the
 * operations it would see on the desktop, under the same names.
 *
 * `@mcp-b/global` provides `document.modelContext`: the browser's own when it
 * has one (Chrome's WebMCP), otherwise a polyfill that browser agents and the
 * MCP-B extension can reach.
 *
 * The agent acts as you, with this tab's session key — it is your agent, not
 * a separate identity. Anything that hands out a space's key asks you first.
 */
import '@mcp-b/global';
import { NODE_ACTIONS, checkActionInput, type P2PNode } from '@p2p-web/protocol';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/**
 * Registers the node's operations as WebMCP tools.
 * @returns A function that unregisters them — call it when the session ends
 */
export function exposeToAgents(node: P2PNode): () => void {
  const modelContext = (document as Document & { modelContext?: ModelContextLike }).modelContext;
  if (!modelContext) return () => {};
  const registration = new AbortController();

  for (const action of NODE_ACTIONS) {
    void modelContext
      .registerTool(
        {
          name: action.name,
          description: action.description,
          inputSchema: action.input,
          annotations: { readOnlyHint: action.readOnly },
          async execute(input: unknown): Promise<ToolResult> {
            const args = input ?? {};
            const problem = checkActionInput(action, args);
            if (problem) return text(`${action.name}: ${problem}`, true);
            if (action.sensitive && !globalThis.confirm(`An agent wants to run "${action.name}", which hands out access to a space. Allow it?`)) {
              return text('The person declined.', true);
            }
            try {
              return text(await action.run(node, args as Record<string, unknown>));
            } catch (error) {
              return text(error instanceof Error ? error.message : String(error), true);
            }
          },
        },
        { signal: registration.signal },
      )
      .catch((error: unknown) => console.warn(`WebMCP: could not register ${action.name}`, error));
  }

  return () => registration.abort();
}

/** The part of `document.modelContext` used here */
interface ModelContextLike {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: unknown;
      annotations?: { readOnlyHint?: boolean };
      execute: (input: unknown) => Promise<ToolResult>;
    },
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}
