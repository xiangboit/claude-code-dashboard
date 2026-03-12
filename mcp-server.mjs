#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// --- Configuration ---
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:3000';
const API_KEY = process.env.DASHBOARD_API_KEY;

if (!API_KEY) {
  console.error('DASHBOARD_API_KEY environment variable is required');
  process.exit(1);
}

// --- HTTP helper ---
async function apiCall(method, path, body) {
  const url = `${DASHBOARD_URL}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text }; }
  if (!res.ok) throw new Error(data.error || `API ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

// --- MCP Server ---
const server = new McpServer({
  name: 'claude-dashboard',
  version: '1.0.0',
});

// Tool 1: create_task
server.tool(
  'create_task',
  'Create a new scheduled task that runs a Claude Code prompt against a project',
  {
    name: z.string().describe('Task name'),
    project_id: z.string().describe('Project directory name (under ~/projects/)'),
    prompt: z.string().describe('The prompt/instruction for Claude Code to execute'),
    cron_expr: z.string().optional().describe('Cron expression (5-field, e.g. "0 */5 * * *"). Omit for manual-only'),
    execution_mode: z.enum(['new', 'resume']).default('new').describe('"new" starts fresh session, "resume" continues last conversation'),
    max_concurrency: z.number().int().min(0).max(10).default(1).describe('Max concurrent runs (0=unlimited, 1=serial)'),
    dangerously_skip_permissions: z.boolean().default(true).describe('Skip all confirmation prompts (--dangerously-skip-permissions). Default true for automated tasks'),
  },
  async (params) => {
    try {
      const result = await apiCall('POST', '/api/tasks', params);
      return { content: [{ type: 'text', text: `Task created. ID: ${result.id}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error creating task: ${e.message}` }], isError: true };
    }
  }
);

// Tool 2: trigger_task
server.tool(
  'trigger_task',
  'Manually trigger execution of a scheduled task right now',
  {
    task_id: z.string().describe('The task ID to trigger'),
  },
  async ({ task_id }) => {
    try {
      const result = await apiCall('POST', `/api/tasks/${encodeURIComponent(task_id)}/trigger`);
      return { content: [{ type: 'text', text: `Task triggered. Run ID: ${result.runId}, Session: ${result.sessionId}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error triggering task: ${e.message}` }], isError: true };
    }
  }
);

// Tool 3: list_tasks
server.tool(
  'list_tasks',
  'List all scheduled tasks with their latest run status and running count',
  {
    status: z.enum(['all', 'enabled', 'disabled']).default('all').optional()
      .describe('Filter tasks by enabled/disabled status'),
  },
  async ({ status } = {}) => {
    try {
      const tasks = await apiCall('GET', '/api/tasks');
      let filtered = tasks;
      if (status === 'enabled') filtered = tasks.filter(t => t.enabled);
      else if (status === 'disabled') filtered = tasks.filter(t => !t.enabled);

      if (filtered.length === 0) {
        return { content: [{ type: 'text', text: 'No tasks found.' }] };
      }

      const lines = filtered.map(t => {
        const run = t.latestRun;
        const runInfo = run
          ? `Last run: ${run.status} at ${new Date(run.started_at).toISOString()}${run.id ? ` (run_id: ${run.id})` : ''}`
          : 'No runs yet';
        const cronInfo = t.cron_expr || 'manual only';
        return [
          `[${t.id}] ${t.name}`,
          `  Project: ${t.project_id} | Mode: ${t.execution_mode} | ${t.enabled ? 'ENABLED' : 'DISABLED'} | Yolo: ${t.dangerously_skip_permissions ? 'ON' : 'OFF'}`,
          `  Cron: ${cronInfo} | Concurrency: ${t.max_concurrency} | Running: ${t.runningCount || 0}`,
          `  ${runInfo}`,
        ].join('\n');
      });

      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error listing tasks: ${e.message}` }], isError: true };
    }
  }
);

// Tool 4: cancel_task
server.tool(
  'cancel_task',
  'Cancel all running executions of a task (kills the PTY processes)',
  {
    task_id: z.string().describe('The task ID whose running executions to cancel'),
  },
  async ({ task_id }) => {
    try {
      await apiCall('POST', `/api/tasks/${encodeURIComponent(task_id)}/cancel`);
      return { content: [{ type: 'text', text: `Cancelled all running executions of task ${task_id}.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error cancelling task: ${e.message}` }], isError: true };
    }
  }
);

// Tool 5: delete_task
server.tool(
  'delete_task',
  'Delete a scheduled task permanently, including all its run history and logs',
  {
    task_id: z.string().describe('The task ID to delete'),
  },
  async ({ task_id }) => {
    try {
      await apiCall('DELETE', `/api/tasks/${encodeURIComponent(task_id)}`);
      return { content: [{ type: 'text', text: `Task ${task_id} deleted successfully.` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error deleting task: ${e.message}` }], isError: true };
    }
  }
);

// Tool 6: get_task_log
server.tool(
  'get_task_log',
  'Get the execution log of a specific task run',
  {
    run_id: z.string().describe('The run ID (from list_tasks latestRun or trigger_task response)'),
  },
  async ({ run_id }) => {
    try {
      const result = await apiCall('GET', `/api/tasks/runs/${encodeURIComponent(run_id)}/log`);
      const log = result.log || '(empty log)';
      const prefix = result.truncated ? '[Log truncated to last 100KB]\n\n' : '';
      return { content: [{ type: 'text', text: `${prefix}${log}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error fetching log: ${e.message}` }], isError: true };
    }
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Dashboard MCP server connected (${DASHBOARD_URL})`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
