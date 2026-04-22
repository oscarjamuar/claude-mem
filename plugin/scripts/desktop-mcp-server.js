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

// ── Worker port resolution (same logic as hook-runner.js) ────────────────────
function resolvePort() {
  try {
    const info = os.userInfo();
    const uid = typeof info.uid === 'number' && info.uid >= 0
      ? info.uid
      : usernameHash(info.username);
    return 37700 + (uid % 100);
  } catch {
    return 37777;
  }
}

function usernameHash(username) {
  let h = 0;
  for (let i = 0; i < (username || '').length; i++) {
    h = (Math.imul(31, h) + username.charCodeAt(i)) >>> 0;
  }
  return h % 100;
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
      const qs = new URLSearchParams({ q: args.query, limit: String(args.limit || 10) });
      if (args.project) qs.set('project', args.project);
      const res = await workerRequest('GET', `/api/search?${qs}`);
      if (res.status !== 200) throw new Error(`Search failed: ${JSON.stringify(res.body)}`);
      const items = res.body.items || res.body.results || res.body || [];
      if (!items.length) return 'No results found.';
      return items.map(r =>
        `[ID:${r.id}] ${r.type || 'note'} | ${r.project || '—'} | ${r.created_at?.slice(0, 10) || ''}\n${r.summary || r.content || ''}`
      ).join('\n\n');
    }

    case 'get_observations': {
      const res = await workerRequest('POST', '/api/observations/batch', { ids: args.ids });
      if (res.status !== 200) throw new Error(`Fetch failed: ${JSON.stringify(res.body)}`);
      const items = res.body.items || res.body || [];
      if (!items.length) return 'No observations found for those IDs.';
      return items.map(r =>
        `[ID:${r.id}] ${r.type} | ${r.project || '—'} | ${r.created_at?.slice(0, 16) || ''}\n${r.content}`
      ).join('\n\n---\n\n');
    }

    case 'timeline': {
      const qs = new URLSearchParams({ q: args.query, limit: String(args.limit || 10) });
      const res = await workerRequest('GET', `/api/search/timeline?${qs}`);
      if (res.status !== 200) {
        // Fallback to regular search if timeline endpoint not available
        const fallback = await workerRequest('GET', `/api/search?${qs}`);
        const items = fallback.body.items || fallback.body || [];
        return items.map(r =>
          `[ID:${r.id}] ${r.created_at?.slice(0, 16) || ''} | ${r.type} | ${r.summary || r.content || ''}`
        ).join('\n');
      }
      const items = res.body.items || res.body || [];
      return items.map(r =>
        `[ID:${r.id}] ${r.created_at?.slice(0, 16) || ''} | ${r.type} | ${r.summary || r.content || ''}`
      ).join('\n');
    }

    case 'store_observation': {
      // Use the session observations endpoint — create an ad-hoc desktop session ID
      const sessionId = `desktop-${Date.now()}`;
      const res = await workerRequest('POST', '/api/sessions/observations', {
        contentSessionId: sessionId,
        tool_name: 'desktop_note',
        tool_input: { note: args.content, type: args.type || 'note' },
        tool_response: args.content,
        cwd: args.project || os.homedir(),
        platformSource: 'claude-desktop',
      });
      if (res.status >= 400) throw new Error(`Store failed: ${JSON.stringify(res.body)}`);
      return `✅ Observation saved to claude-mem memory (type: ${args.type || 'note'})`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

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
      capabilities: { tools: {} },
      serverInfo: { name: 'claude-mem', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') return; // no response needed

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
