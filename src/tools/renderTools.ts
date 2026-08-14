import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { formatOptimizedResponse, formatError, getToolAnnotations, makeRegistrar } from '../core/security.js';

interface RenderSessionEntry {
  sessionId: string;
  lastActive: number;
}
const renderSessions = new Map<string, RenderSessionEntry>();

async function getRenderSession(renderToken: string): Promise<string> {
  const cached = renderSessions.get(renderToken);
  if (cached) {
    cached.lastActive = Date.now();
    return cached.sessionId;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://mcp.render.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${renderToken}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'krix-render-client', version: '2.0.0' }
        },
        id: 1
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Network error');
      throw new Error(`Render API returned HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const initData: any = await response.json();
    const sessionId = response.headers.get('mcp-session-id') || initData.result?.sessionId || 'default';
    renderSessions.set(renderToken, { sessionId, lastActive: Date.now() });
    return sessionId;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callRemoteRenderTool(renderToken: string, toolName: string, args: any): Promise<any> {
  const sessionId = await getRenderSession(renderToken);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch('https://mcp.render.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${renderToken}`,
        'mcp-session-id': sessionId
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args
        },
        id: Date.now()
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Network error');
      throw new Error(`Render API responded with HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data: any = await response.json();
    if (data.error) {
      throw new Error(data.error.message || `Render API error code ${data.error.code}`);
    }
    return data.result;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function registerRenderTools(
  server: McpServer,
  getRenderToken: () => string | undefined,
  registry: Record<string, any> = {}
) {
  const register = makeRegistrar(server, registry);

  const requireRenderToken = () => {
    const token = getRenderToken();
    if (!token) {
      throw new Error("Render API Key not configured. Please save a valid Render API Key in the Krix dashboard or provide 'x-render-token' header.");
    }
    return token;
  };

  register('list_workspaces', {
    description: 'List all Render workspaces accessible to the authenticated user.',
    inputSchema: { limit: z.number().optional().describe('Maximum number of workspaces to return') },
    annotations: getToolAnnotations('list_workspaces')
  }, async (args) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'list_workspaces', args);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('select_workspace', {
    description: 'Select an active Render workspace by ID for subsequent commands.',
    inputSchema: { workspaceId: z.string().describe('The ID of the Render workspace to select') },
    annotations: getToolAnnotations('select_workspace')
  }, async (args) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'select_workspace', args);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('get_selected_workspace', {
    description: 'Get details of the currently active Render workspace.',
    inputSchema: {},
    annotations: getToolAnnotations('get_selected_workspace')
  }, async (args) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'get_selected_workspace', args);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('list_services', {
    description: 'List all services (web services, static sites, background workers, cron jobs) in the workspace.',
    inputSchema: {
      type: z.string().optional().describe('Filter by service type: web_service, static_site, background_worker, cron_job, private_service'),
      limit: z.number().optional().describe('Maximum number of services to return')
    },
    annotations: getToolAnnotations('list_services')
  }, async (args) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'list_services', args);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('get_service', {
    description: 'Retrieve detailed configuration and status for a specific Render service.',
    inputSchema: { serviceId: z.string().describe('The ID of the service to inspect') },
    annotations: getToolAnnotations('get_service')
  }, async (args) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'get_service', args);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('create_web_service', {
    description: 'Create and deploy a new web service on Render from a GitHub repo.',
    inputSchema: {
      name: z.string().describe('Name of the service'),
      repo: z.string().describe('GitHub repository URL (e.g. https://github.com/owner/repo)'),
      branch: z.string().optional().describe('Branch to deploy from (defaults to main)'),
      runtime: z.string().describe('Runtime environment: node, python, go, rust, ruby, docker'),
      buildCommand: z.string().optional().describe('Build command to execute before start'),
      startCommand: z.string().optional().describe('Command to run the web application'),
      envVars: z.array(z.object({ key: z.string(), value: z.string() })).optional().describe('Initial environment variables')
    },
    annotations: getToolAnnotations('create_web_service')
  }, async (args) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'create_web_service', args);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('create_static_site', {
    description: 'Create a new static site on Render.',
    inputSchema: {
      name: z.string().describe('Name of the static site'),
      repo: z.string().describe('GitHub repository URL'),
      branch: z.string().optional().describe('Branch to deploy from'),
      buildCommand: z.string().optional().describe('Build command (e.g. npm run build)'),
      publishPath: z.string().optional().describe('Directory to publish (e.g. dist, build, public)')
    },
    annotations: getToolAnnotations('create_static_site')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'create_static_site', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('create_cron_job', {
    description: 'Create a scheduled cron job service on Render.',
    inputSchema: {
      name: z.string().describe('Name of the cron job'),
      repo: z.string().describe('GitHub repository URL'),
      schedule: z.string().describe('Cron schedule expression (e.g. "0 0 * * *")'),
      startCommand: z.string().describe('Command to execute on schedule')
    },
    annotations: getToolAnnotations('create_cron_job')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'create_cron_job', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('restart_service', {
    description: 'Trigger a zero-downtime restart of a running Render service.',
    inputSchema: { serviceId: z.string().describe('The ID of the service to restart') },
    annotations: getToolAnnotations('restart_service')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'restart_service', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('delete_service', {
    description: 'Permanently delete a Render service and its associated deployments.',
    inputSchema: { serviceId: z.string().describe('The ID of the service to delete') },
    annotations: getToolAnnotations('delete_service')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'delete_service', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('list_deploys', {
    description: 'List recent deployments for a Render service.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      limit: z.number().optional().describe('Maximum number of deploys to return')
    },
    annotations: getToolAnnotations('list_deploys')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'list_deploys', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('get_deploy', {
    description: 'Get details and build status of a specific deployment.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      deployId: z.string().describe('The ID of the deployment')
    },
    annotations: getToolAnnotations('get_deploy')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'get_deploy', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('trigger_deploy', {
    description: 'Trigger a new manual deployment for a service.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service to deploy'),
      clearCache: z.boolean().optional().describe('Whether to clear the build cache before deploying')
    },
    annotations: getToolAnnotations('trigger_deploy')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'trigger_deploy', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('cancel_deploy', {
    description: 'Cancel an in-progress deployment.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      deployId: z.string().describe('The ID of the deploy to cancel')
    },
    annotations: getToolAnnotations('cancel_deploy')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'cancel_deploy', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('list_logs', {
    description: 'Fetch and filter real-time runtime log streams from a Render service.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      limit: z.number().optional().describe('Number of log entries to retrieve (max 100)'),
      textFilter: z.string().optional().describe('Substring or keyword to filter logs by')
    },
    annotations: getToolAnnotations('list_logs')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'list_logs', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('list_log_label_values', {
    description: 'List possible log label values (e.g. host, instance) for filtering.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      label: z.string().describe('Label key to inspect')
    },
    annotations: getToolAnnotations('list_log_label_values')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'list_log_label_values', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('get_metrics', {
    description: 'Fetch real-time CPU, RAM, and network bandwidth metrics for a service.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      metricType: z.enum(['cpu', 'memory', 'bandwidth']).describe('Type of telemetry metric')
    },
    annotations: getToolAnnotations('get_metrics')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'get_metrics', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('list_env_vars', {
    description: 'List all environment variables configured for a Render service.',
    inputSchema: { serviceId: z.string().describe('The ID of the service') },
    annotations: getToolAnnotations('list_env_vars')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'list_env_vars', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('update_env_vars', {
    description: 'Update or set environment variables for a Render service.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      envVars: z.array(z.object({
        key: z.string().describe('Environment variable name'),
        value: z.string().describe('Environment variable value')
      })).describe('Array of key-value pairs to set or update')
    },
    annotations: getToolAnnotations('update_env_vars')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'update_env_vars', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('delete_env_var', {
    description: 'Delete an environment variable from a Render service.',
    inputSchema: {
      serviceId: z.string().describe('The ID of the service'),
      key: z.string().describe('The variable name to delete')
    },
    annotations: getToolAnnotations('delete_env_var')
  }, async (input) => {
    try {
      const res = await callRemoteRenderTool(requireRenderToken(), 'delete_env_var', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });

  register('query_render_postgres', {
    description: 'Execute a read-only SQL query against a managed Render PostgreSQL database.',
    inputSchema: {
      postgresId: z.string().describe('The ID of the Render PostgreSQL database'),
      query: z.string().describe('The read-only SQL query to execute (SELECT only)')
    },
    annotations: getToolAnnotations('query_render_postgres')
  }, async (input) => {
    try {
      const trimmed = input.query.trim();
      if (!/^\s*SELECT\b/i.test(trimmed)) {
        throw new Error("Only read-only SELECT queries are permitted on Render PostgreSQL databases.");
      }
      const dangerousPatterns = [
        /;/,
        /--/,
        /\/\*/,
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CREATE|REPLACE|INTO\s+OUTFILE)\b/i
      ];
      for (const pat of dangerousPatterns) {
        if (pat.test(trimmed)) {
          throw new Error("Dangerous SQL pattern or mutating operation blocked.");
        }
      }
      const res = await callRemoteRenderTool(requireRenderToken(), 'query_render_postgres', input);
      return formatOptimizedResponse(res);
    } catch (err: any) { return formatError(err); }
  });
}
