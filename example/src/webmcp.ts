/**
 * WebMCP: the node's operations as tools an AI agent can call.
 *
 * Every tool comes from `NODE_ACTIONS` — the same list the CLI and the MCP
 * server are generated from — so an agent sees exactly the operations it would
 * see on the desktop, under the same names.
 *
 * The tools are registered once, when the page loads, and stay: extensions
 * and the local relay read the list early, and a list that appears only after
 * sign-in is one they miss. Until someone signs in, each tool says so.
 *
 * `document.modelContext` is the browser's own when it has one (Chrome's
 * WebMCP); otherwise the polyfill installs it. Desktop MCP clients reach it
 * through the relay embed loaded in `index.html`.
 *
 * The agent acts as you, with this tab's session key — it is your agent, not
 * a separate identity. Anything that hands out a space's key asks you first.
 */
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { NODE_ACTIONS, checkActionInput } from '@p2p-web/protocol';
import { getSession } from './protocol';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

let registered = false;

/** Registers the node's operations as WebMCP tools. Safe to call more than once. */
export function exposeToAgents(): void {
  if (registered) return;
  registered = true;
  initializeWebMCPPolyfill();

  for (const action of NODE_ACTIONS) {
    void document.modelContext
      .registerTool({
        name: action.name,
        description: action.description,
        inputSchema: action.input as never,
        annotations: { readOnlyHint: action.readOnly },
        async execute(input: Record<string, unknown>) {
          // Whoever is signed in right now — the tools outlive any one session.
          const session = getSession();
          if (!session) return text('Nobody is signed in to this tab. Ask the person to sign in, then try again.', true);
          const args = input ?? {};
          const problem = checkActionInput(action, args);
          if (problem) return text(`${action.name}: ${problem}`, true);
          if (action.sensitive && !globalThis.confirm(`An agent wants to run "${action.name}", which hands out access to a space. Allow it?`)) {
            return text('The person declined.', true);
          }
          try {
            return text(await action.run(session.node, args));
          } catch (error) {
            return text(error instanceof Error ? error.message : String(error), true);
          }
        },
      })
      .catch((error: unknown) => console.warn(`WebMCP: could not register ${action.name}`, error));
  }
}
