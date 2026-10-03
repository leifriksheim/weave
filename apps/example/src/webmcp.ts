/**
 * WebMCP: the node's operations as tools an AI agent in this browser can call.
 *
 * Every tool comes from `NODE_ACTIONS` — the same list the CLI and the MCP
 * server are generated from — so an agent sees the operations it would see on
 * the desktop, under the same names.
 *
 * An agent that can call these — Claude in Chrome, an extension — can already
 * click through this page and read it, so it gets no key or note of its own:
 * it works as you, in your tab, like someone helping at your keyboard. Nothing
 * to switch on. An agent on your computer instead — Claude Code, Claude
 * Desktop — connects with "Connect an agent" (`ConnectAgent.tsx`) and runs a
 * node of its own, marked as an agent's.
 *
 * Two things stay, because the agent reads what other people wrote and any of
 * that may try to steer it: anything that removes, overwrites, joins, or
 * hands out a space's key asks you first; and it can't add collections —
 * it proposes an app (`apps_propose`) and you add it.
 *
 * The tools are registered once, when the page loads, and stay: agents read
 * the list early, and a list that appears only after sign-in is one they miss.
 * Until someone connects, each tool says so. `document.modelContext` is the
 * browser's own when it has one (Chrome's WebMCP); otherwise the polyfill
 * installs it.
 */
import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import type { InputSchema } from '@mcp-b/webmcp-types';
import { NODE_ACTIONS, callAction, checkActionInput } from '@weaveprotocol/core';
import { getNode } from './weave';

const text = (value: string, isError = false) => ({
  content: [{ type: 'text' as const, text: value }],
  ...(isError ? { isError: true } : {}),
});

/** Not offered: a new collection arrives as a proposal the person adds (`apps_propose`) */
const PROPOSE_INSTEAD = new Set(['collections_define', 'collections_delete']);

/** Changes to a space's people or membership — asked about with what they'd do */
const changesPeople = (name: string) => name.startsWith('spaces_');

let registered = false;

/** Registers the node's operations as WebMCP tools. Safe to call more than once. */
export function exposeToAgents(): void {
  if (registered) return;
  registered = true;
  initializeWebMCPPolyfill();

  for (const action of NODE_ACTIONS.filter((candidate) => !PROPOSE_INSTEAD.has(candidate.name))) {
    // Typed as a plain schema, so the arguments come in as a record rather than inferred from it.
    const inputSchema: InputSchema = { ...action.input };
    void document.modelContext
      .registerTool({
        name: action.name,
        description: action.description,
        inputSchema,
        annotations: { readOnlyHint: action.readOnly },
        async execute(input: Record<string, unknown>) {
          // Whoever is connected right now — the tools outlive any one connection.
          const node = getNode();
          if (!node)
            return text(
              'This tab is not connected to an account. Ask the person to connect, then try again.',
              true,
            );
          const args = input ?? {};
          const problem = checkActionInput(action, args);
          if (problem) return text(`${action.name}: ${problem}`, true);
          const people = changesPeople(action.name);
          const ask = action.readOnly
            ? null
            : action.sensitive && !people
              ? `An agent wants to run "${action.name}", which hands out access to a space. Allow it?`
              : people || action.destructive
                ? `An agent wants to run "${action.name}" with ${JSON.stringify(args)}. Allow it?`
                : null;
          if (ask && !globalThis.confirm(ask)) return text('The person declined.', true);
          const { text: said, isError } = await callAction(node, action.name, args);
          return text(said, isError);
        },
      })
      .catch((error: unknown) => console.warn(`WebMCP: could not register ${action.name}`, error));
  }
}
