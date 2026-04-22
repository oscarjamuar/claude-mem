#!/usr/bin/env node
/**
 * claude-mem Desktop MCP Server
 *
 * Registers claude-mem tools into the Claude Desktop App via MCP.
 * Since the Desktop App has no hooks system, this server provides:
 *   - search / timeline / get_observations  → retrieval from past sessions
 *   - store_observation                     → save memories from desktop conversations
 *
 * Registered in: %APPDATA%\Claude\claude_desktop_config.json
 * Worker must be running on localhost:37777 (auto-started on login via Task Scheduler).
 */

'use strict';

const http = require('http');
const path = require('path');
const os = require('os');

// ── Worker port resolution ───────────────────────────────────────────────────
// Priority: env var → settings file → default 37777
function resolvePort() {
  // 1. Explicit env var (set by user or Task Scheduler)
  if (process.env.CLAUDE_MEM_WORKER_PORT) {
    return parseInt(process.env.CLAUDE_MEM_WORKER_PORT, 10);
  }
  // 2. Read from ~/.claude-mem/settings.json if present
  try {
    const settingsPath = path.join(os.homedir(), '.claude-mem', 'settings.json');
    if (require('fs').existsSync(settingsPath)) {
      const s = JSON.parse(require('fs').readFileSync(settingsPath, 'utf8'));
      if (s.CLAUDE_MEM_WORKER_PORT) return parseInt(s.CLAUDE_MEM_WORKER_PORT, 10);
    }
  } catch { /* ignore */ }
  // 3. Default — matches worker-service.cjs default
  return 37777;
}

const PORT = resolvePort();
const BASE_URL = `http://localhost:${PORT}`;

// ── Simple HTTP helper (no external deps) ───────────────────────────────────
function workerRequest(method, path_, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE_URL}${path_}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Worker request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── MCP wire protocol (JSON-RPC over stdio) ──────────────────────────────────
// The Desktop app communicates via stdin/stdout JSON-RPC — no SDK needed.

const TOOLS = [
  {
    name: 'search',
    description: 'Search claude-mem memory for past work, decisions, bugs fixed, or discoveries. Returns compact results (ID + summary). Use get_observations for full details.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', description: 'Max results (default 10)', default: 10 },
        project: { type: 'string', description: 'Filter by project name (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_observations',
    description: 'Fetch full details for specific observation IDs returned by search or timeline.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Observation IDs to fetch',
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'timeline',
    description: 'Get chronological context around a search result — what happened before/after.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'store_observation',
    description: 'Save an important observation, decision, discovery, or note to claude-mem persistent memory so it can be recalled in future sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The observation text to store (be specific and detailed)',
        },
        type: {
          type: 'string',
          enum: ['note', 'decision', 'discovery', 'bugfix', 'feature', 'refactor', 'change'],
          description: 'Category of observation (default: note)',
          default: 'note',
        },
        project: {
          type: 'string',
          description: 'Project name to associate with (optional)',
        },
      },
      required: ['content'],
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  switch (name) {
    case 'search': {
      // Use observations text search (works without Chroma vector DB)
      const qs = new URLSearchParams({ limit: String(args.limit || 10) });
      if (args.query) qs.set('search', args.query);
      if (args.project) qs.set('project', args.project);
      const res = await workerRequest('GET', `/api/observations?${qs}`);
      if (res.status !== 200) throw new Error(`Search failed: ${JSON.stringify(res.body)}`);
      const items = Array.isArray(res.body) ? res.body : (res.body.items ? Object.values(res.body.items) : []);
      if (!items.length) return 'No results found in memory.';
      return items.map(r =>
        `[ID:${r.id}] ${r.type || 'note'} | ${r.project || '—'} | ${(r.created_at || '').slice(0, 10)}\n${r.text || r.title || ''}`
      ).join('\n\n');
    }

    case 'get_observations': {
      const res = await workerRequest('POST', '/api/observations/batch', { ids: args.ids });
      if (res.status !== 200) throw new Error(`Fetch failed: ${JSON.stringify(res.body)}`);
      const items = Array.isArray(res.body) ? res.body : (res.body.items ? Object.values(res.body.items) : []);
      if (!items.length) return 'No observations found for those IDs.';
      return items.map(r =>
        `[ID:${r.id}] ${r.type} | ${r.project || '—'} | ${(r.created_at || '').slice(0, 16)}\n${r.text || r.title || ''}`
      ).join('\n\n---\n\n');
    }

    case 'timeline': {
      // Fetch recent observations sorted by date as a timeline
      const qs = new URLSearchParams({ limit: String(args.limit || 10) });
      if (args.query) qs.set('search', args.query);
      const res = await workerRequest('GET', `/api/observations?${qs}`);
      const items = Array.isArray(res.body) ? res.body : (res.body.items ? Object.values(res.body.items) : []);
      if (!items.length) return 'No timeline results found.';
      return items.map(r =>
        `[ID:${r.id}] ${(r.created_at || '').slice(0, 16)} | ${r.type} | ${r.project || '—'}\n${r.text || r.title || ''}`
      ).join('\n\n');
    }

    case 'store_observation': {
      // Use /api/import to directly insert a session + observation into the DB.
      // The sessions/observations endpoint requires an active Claude Code session,
      // so we use the import endpoint which works standalone.
      const now = new Date().toISOString();
      const epoch = Date.now();
      const sid = `desktop-${epoch}`;
      const project = args.project || 'claude-desktop';

      const res = await workerRequest('POST', '/api/import', {
        sessions: [{
          content_session_id: sid,
          memory_session_id: sid,
          project,
          platform_source: 'claude-desktop',
          user_prompt: `Desktop note: ${(args.content || '').slice(0, 80)}`,
          started_at: now,
          started_at_epoch: epoch,
          completed_at: now,
          completed_at_epoch: epoch,
          status: 'completed',
        }],
        observations: [{
          memory_session_id: sid,
          project,
          text: args.content,
          type: args.type || 'note',
          title: (args.content || '').slice(0, 80),
          subtitle: 'Saved from Claude Desktop App',
          facts: null,
          narrative: null,
          concepts: null,
          files_read: null,
          files_modified: null,
          prompt_number: 1,
          discovery_tokens: 0,
          created_at: now,
          created_at_epoch: epoch,
        }],
      });
      if (res.status >= 400) throw new Error(`Store failed: ${JSON.stringify(res.body)}`);
      const imported = res.body?.stats?.observationsImported ?? '?';
      return `✅ Observation saved to claude-mem memory (type: ${args.type || 'note'}, imported: ${imported})`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Auto-save instructions injected into every conversation ──────────────────
const AUTO_SAVE_INSTRUCTIONS = `
You have access to claude-mem — a persistent memory system. Follow these rules automatically, without being asked:

1. **At the START of every conversation**: Call the \`search\` tool with keywords from the user's first message to check if there is relevant past context. Silently surface anything useful.

2. **During the conversation**: When the user makes an important decision, solves a problem, discovers something, or completes a meaningful task — call \`store_observation\` immediately to record it. Do NOT wait until the end.

3. **At the END of every conversation**: Before your final response, call \`store_observation\` once with a concise summary of:
   - What the user was working on (project name if known)
   - What was decided or accomplished
   - Any key facts, file names, or context that would be useful next time

Use type \`decision\` for choices made, \`discovery\` for things learned, \`bugfix\` for bugs fixed, \`feature\` for features built, \`note\` for general context.

Always set \`project\` to the project name if you know it (e.g. "shiftelio_webapp").

These rules apply to EVERY conversation automatically — never skip them.
`.trim();

const PROMPTS = [
  {
    name: 'save-session',
    description: 'Save a summary of this conversation to claude-mem memory',
    arguments: [
      { name: 'project', description: 'Project name (optional)', required: false },
    ],
  },
];

// ── JSON-RPC message handler ─────────────────────────────────────────────────
function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, prompts: {} },
      serverInfo: {
        name: 'claude-mem',
        version: '1.0.0',
        // Claude Desktop reads this and uses it as behavioral instructions
        instructions: AUTO_SAVE_INSTRUCTIONS,
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;
    try {
      const result = await handleTool(name, args || {});
      respond(id, { content: [{ type: 'text', text: String(result) }] });
    } catch (err) {
      respond(id, {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === 'prompts/list') {
    respond(id, { prompts: PROMPTS });
    return;
  }

  if (method === 'prompts/get') {
    const { name, arguments: args } = params;
    if (name === 'save-session') {
      const project = args?.project ? ` for project "${args.project}"` : '';
      respond(id, {
        description: 'Save a summary of this conversation to claude-mem memory',
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please summarise what we have accomplished in this conversation${project} and save it to claude-mem memory using the store_observation tool. Include: what we worked on, decisions made, problems solved, and any important context for next time.`,
            },
          },
        ],
      });
    } else {
      respondError(id, -32602, `Unknown prompt: ${name}`);
    }
    return;
  }

  // Unknown method
  if (id !== undefined) {
    respondError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Stdio loop ───────────────────────────────────────────────────────────────
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      handleMessage(msg).catch(err => {
        process.stderr.write(`[claude-mem MCP] Error: ${err.message}\n`);
      });
    } catch {
      process.stderr.write(`[claude-mem MCP] Invalid JSON: ${trimmed}\n`);
    }
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

process.stderr.write(`[claude-mem MCP] Desktop server started, worker at ${BASE_URL}\n`);
