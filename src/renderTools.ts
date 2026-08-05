import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatOptimizedResponse, formatError, getToolAnnotations } from './security.js';

interface RenderSessionEntry { sessionId: string; lastActive: number; }
const renderSessions = new Map<string, RenderSessionEntry>();

async function getRenderSession(renderToken: string): Promise<string> {
  const cached = renderSessions.get(renderToken);
  if (cached) { cached.lastActive = Date.now(); return cached.sessionId; }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://mcp.render.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${renderToken}` },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'unified-mcp-server', version: '2.5.0' } }
      })
    });
    clearTimeout(timeoutId);
    const sessionId = response.headers.get('mcp-session-id');
    if (!sessionId) throw new Error('Render MCP missing session header.');
    renderSessions.set(renderToken, { sessionId, lastActive: Date.now() });
    return sessionId;
  } catch (err) { clearTimeout(timeoutId); throw err; }
}

async function callRenderTool(toolName: string, args: any, renderToken: string | undefined) {
  if (!renderToken) return formatError(new Error('Render API key missing.'));
  try {
    const sessionId = await getRenderSession(renderToken);
    const res = await fetch('https://mcp.render.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${renderToken}`, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: toolName, arguments: args }, id: `r-${Date.now()}` })
    });
    const data: any = await res.json();
    if (data?.error) return formatError(new Error(data.error.message || JSON.stringify(data.error)));
    return formatOptimizedResponse(data?.result || data);
  } catch (err: any) {
    renderSessions.delete(renderToken);
    return formatError(err);
  }
}

export function registerRenderTools(server: McpServer, renderTokenGetter: () => string | undefined) {
  server.registerTool('list_workspaces', { description: 'List workspaces.', inputSchema: {}, annotations: getToolAnnotations('list_workspaces') },
    async () => callRenderTool('list_workspaces', {}, renderTokenGetter()));

  server.registerTool('select_workspace', { description: 'Select active workspace.', inputSchema: { ownerID: z.string() }, annotations: getToolAnnotations('select_workspace') },
    async (args: any) => callRenderTool('select_workspace', args, renderTokenGetter()));

  server.registerTool('get_selected_workspace', { description: 'Get selected workspace info.', inputSchema: {}, annotations: getToolAnnotations('get_selected_workspace') },
    async () => callRenderTool('get_selected_workspace', {}, renderTokenGetter()));

  server.registerTool('list_services', { description: 'List services.', inputSchema: { includePreviews: z.boolean().optional().default(false) }, annotations: getToolAnnotations('list_services') },
    async (args: any) => callRenderTool('list_services', args, renderTokenGetter()));

  server.registerTool('get_service', { description: 'Get service info.', inputSchema: { serviceId: z.string() }, annotations: getToolAnnotations('get_service') },
    async (args: any) => callRenderTool('get_service', args, renderTokenGetter()));

  server.registerTool('create_web_service', {
    description: 'Create web service.',
    inputSchema: { name: z.string(), runtime: z.enum(['node', 'python', 'go', 'rust', 'docker']), buildCommand: z.string(), startCommand: z.string(), repo: z.string() },
    annotations: getToolAnnotations('create_web_service')
  }, async (args: any) => callRenderTool('create_web_service', args, renderTokenGetter()));

  server.registerTool('create_static_site', {
    description: 'Create static site.',
    inputSchema: { name: z.string(), repo: z.string(), buildCommand: z.string(), publishPath: z.string().default('public') },
    annotations: getToolAnnotations('create_static_site')
  }, async (args: any) => callRenderTool('create_static_site', args, renderTokenGetter()));

  server.registerTool('create_cron_job', {
    description: 'Create cron job.',
    inputSchema: { name: z.string(), schedule: z.string(), command: z.string(), repo: z.string() },
    annotations: getToolAnnotations('create_cron_job')
  }, async (args: any) => callRenderTool('create_cron_job', args, renderTokenGetter()));

  server.registerTool('restart_service', { description: 'Restart service.', inputSchema: { serviceId: z.string() }, annotations: getToolAnnotations('restart_service') },
    async (args: any) => callRenderTool('restart_service', args, renderTokenGetter()));

  server.registerTool('delete_service', { description: 'Delete service.', inputSchema: { serviceId: z.string() }, annotations: getToolAnnotations('delete_service') },
    async (args: any) => callRenderTool('delete_service', args, renderTokenGetter()));

  server.registerTool('list_deploys', { description: 'List deploys.', inputSchema: { serviceId: z.string(), limit: z.number().optional().default(5) }, annotations: getToolAnnotations('list_deploys') },
    async (args: any) => callRenderTool('list_deploys', args, renderTokenGetter()));

  server.registerTool('get_deploy', { description: 'Get deploy status.', inputSchema: { serviceId: z.string(), deployId: z.string() }, annotations: getToolAnnotations('get_deploy') },
    async (args: any) => callRenderTool('get_deploy', args, renderTokenGetter()));

  server.registerTool('trigger_deploy', { description: 'Trigger deploy.', inputSchema: { serviceId: z.string(), clearCache: z.enum(['clear', 'do_not_clear']).default('do_not_clear') }, annotations: getToolAnnotations('trigger_deploy') },
    async (args: any) => callRenderTool('trigger_deploy', args, renderTokenGetter()));

  server.registerTool('cancel_deploy', { description: 'Cancel deploy.', inputSchema: { serviceId: z.string(), deployId: z.string() }, annotations: getToolAnnotations('cancel_deploy') },
    async (args: any) => callRenderTool('cancel_deploy', args, renderTokenGetter()));

  server.registerTool('list_logs', { description: 'Fetch service logs.', inputSchema: { resource: z.array(z.string()), limit: z.number().optional().default(15) }, annotations: getToolAnnotations('list_logs') },
    async (args: any) => callRenderTool('list_logs', args, renderTokenGetter()));

  server.registerTool('get_metrics', { description: 'Get CPU/Mem metrics.', inputSchema: { serviceId: z.string() }, annotations: getToolAnnotations('get_metrics') },
    async (args: any) => callRenderTool('get_metrics', args, renderTokenGetter()));

  server.registerTool('list_env_vars', { description: 'List env vars.', inputSchema: { serviceId: z.string() }, annotations: getToolAnnotations('list_env_vars') },
    async (args: any) => callRenderTool('list_env_vars', args, renderTokenGetter()));

  server.registerTool('update_env_vars', { description: 'Set env vars.', inputSchema: { serviceId: z.string(), envVars: z.array(z.object({ key: z.string(), value: z.string() })) }, annotations: getToolAnnotations('update_env_vars') },
    async (args: any) => callRenderTool('update_env_vars', args, renderTokenGetter()));

  server.registerTool('delete_env_var', { description: 'Delete env var.', inputSchema: { serviceId: z.string(), key: z.string() }, annotations: getToolAnnotations('delete_env_var') },
    async (args: any) => callRenderTool('delete_env_var', args, renderTokenGetter()));

  server.registerTool('query_render_postgres', { description: 'Run SQL query.', inputSchema: { postgresId: z.string(), query: z.string() }, annotations: getToolAnnotations('query_render_postgres') },
    async (args: any) => callRenderTool('query_render_postgres', args, renderTokenGetter()));
}