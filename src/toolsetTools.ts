import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  formatOptimizedResponse, formatError, getToolAnnotations, getSessionContext,
  makeRegistrar, persistEnabledCategories, ToolCategory
} from './security.js';

// Categories that are enabled for every session by default (see
// getSessionContext's `initial` array in security.ts). Everything else
// starts disabled and must be brought in on demand via load_toolset.
const DEFAULT_LOADED_CATEGORIES: ToolCategory[] = ['core', 'sandbox'];

// Categories that load_toolset is actually allowed to enable. Kept as a
// readonly tuple (not derived from the ToolCategory union) so z.enum has a
// concrete literal list to validate against.
const LOADABLE_TOOLSETS = ['github_issues_prs', 'github_admin', 'render'] as const;
type LoadableToolset = typeof LOADABLE_TOOLSETS[number];

/**
 * Registers the two "meta-tools" that make lazy tool loading actually work:
 *
 *  - list_toolsets: a lightweight index (toolset name + tool count + member
 *    tool names) so the caller can see what exists without paying the full
 *    schema cost of every tool up front.
 *  - load_toolset: enables one or more toolsets for the current session.
 *    Enabling a tool's registration handle (handle.enable()) causes the MCP
 *    TypeScript SDK to automatically emit notifications/tools/list_changed,
 *    so clients pick up the newly-available tools without a reconnect.
 *
 * Both tools must be registered AFTER every other registerXTools() call so
 * that `registry` and `categoryOf` are fully populated before load_toolset's
 * handler closes over them — otherwise it would have nothing to enable.
 */
export function registerToolsetTools(
  server: McpServer,
  sessionId: string,
  registry: Record<string, any>,
  categoryOf: Record<string, ToolCategory>
) {
  const reg = makeRegistrar(server, registry);

  reg('list_toolsets', {
    description: 'List every toolset on this server (a toolset is a named group of related tools), how many tools each contains, and whether it is already loaded for this session. Call this when you are not sure which toolset a tool you need lives in, before calling load_toolset.',
    inputSchema: {},
    annotations: getToolAnnotations('list_toolsets')
  }, async () => {
    const ctx = getSessionContext(sessionId);
    const byCategory: Record<string, string[]> = {};
    for (const [name, cat] of Object.entries(categoryOf)) {
      (byCategory[cat] ||= []).push(name);
    }

    const toolsets = Object.entries(byCategory)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([toolset, tools]) => ({
        toolset,
        loaded: ctx.enabledCategories.has(toolset as ToolCategory),
        tool_count: tools.length,
        tools: tools.sort()
      }));

    return formatOptimizedResponse({
      toolsets,
      note: `'${DEFAULT_LOADED_CATEGORIES.join("', '")}' are loaded by default every session. Use load_toolset to bring in the rest.`
    });
  });

  reg('load_toolset', {
    description: `Load (enable) one or more toolsets for this session so their tools become callable and appear in the tool list. Loadable toolsets: ${LOADABLE_TOOLSETS.join(', ')}. '${DEFAULT_LOADED_CATEGORIES.join("' and '")}' are already loaded by default. Call list_toolsets first if you're unsure which toolset a tool lives in. Loading is additive and persists for the rest of this session.`,
    inputSchema: {
      toolsets: z.array(z.enum(LOADABLE_TOOLSETS))
        .min(1)
        .describe('Names of the toolsets to enable, e.g. ["github_admin"].')
    },
    annotations: getToolAnnotations('load_toolset')
  }, async (args: { toolsets: LoadableToolset[] }) => {
    const ctx = getSessionContext(sessionId);
    const requested = args?.toolsets ?? [];

    if (requested.length === 0) {
      return formatError(`No toolsets provided. Available: ${LOADABLE_TOOLSETS.join(', ')}.`);
    }

    const newlyLoaded: string[] = [];
    const alreadyLoaded: string[] = [];

    for (const toolset of requested) {
      if (ctx.enabledCategories.has(toolset)) {
        alreadyLoaded.push(toolset);
        continue;
      }
      ctx.enabledCategories.add(toolset);
      newlyLoaded.push(toolset);
    }

    // ctx.enabledCategories was mutated in place above, so it must be
    // explicitly persisted here — a subsequent call under a rotated
    // mcp-session-id would otherwise fall back to the bare session default
    // and silently re-lock the toolset that was just enabled.
    if (newlyLoaded.length > 0) {
      persistEnabledCategories(sessionId, ctx.enabledCategories);
    }

    // Flip on every registered tool handle whose category was just enabled.
    // handle.enable() triggers the SDK's own notifications/tools/list_changed
    // push, so the caller sees the new tools without reconnecting.
    if (newlyLoaded.length > 0) {
      for (const [name, handle] of Object.entries(registry)) {
        if (newlyLoaded.includes(categoryOf[name])) {
          handle.enable();
        }
      }
    }

    const loadedNames = newlyLoaded.flatMap(cat =>
      Object.keys(categoryOf).filter(name => categoryOf[name] === cat).sort()
    );

    return formatOptimizedResponse({
      loaded_toolsets: newlyLoaded,
      newly_available_tools: loadedNames,
      already_loaded: alreadyLoaded.length ? alreadyLoaded : undefined
    });
  });
}
