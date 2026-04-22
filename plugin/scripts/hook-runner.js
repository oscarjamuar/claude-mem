#!/usr/bin/env node
'use strict';

/**
 * Cross-platform hook dispatcher for claude-mem.
 * Replaces inline Bash commands in hooks.json with pure Node.js logic.
 * Works on Windows (cmd.exe), macOS, and Linux.
 */

const path = require('path');
const os = require('os');
const http = require('http');
const { spawnSync, spawn } = require('child_process');

const action = process.argv[2] || process.env.CLAUDE_MEM_HOOK_ACTION;

// --- Plugin root resolution (no ls/glob needed) ---
function resolvePluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin');
}

// --- Port resolution (replaces `id -u` Unix-only command) ---
function resolvePort() {
  try {
    const info = os.userInfo();
    // On Unix uid is a number; on Windows it's -1 or unavailable
    const uid = typeof info.uid === 'number' && info.uid >= 0 ? info.uid : usernameHash(info.username);
    return 37700 + (uid % 100);
  } catch {
    return 37777; // same fallback as original Bash (id -u fallback echo 77)
  }
}

function usernameHash(username) {
  // Simple stable hash of username string → integer
  let h = 0;
  for (let i = 0; i < (username || '').length; i++) {
    h = (Math.imul(31, h) + username.charCodeAt(i)) >>> 0;
  }
  return h % 100; // produces 0-99, added to 37700
}

// --- Health check via native http (replaces curl) ---
function healthCheck(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

async function waitForWorker(port, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (await healthCheck(port)) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// --- Spawn a node script (reuses existing bun-runner.js) ---
function runScript(pluginRoot, ...args) {
  const bunRunner = path.join(pluginRoot, 'scripts', 'bun-runner.js');
  const workerService = path.join(pluginRoot, 'scripts', 'worker-service.cjs');
  const IS_WINDOWS = process.platform === 'win32';
  const result = spawnSync(process.execPath, [bunRunner, workerService, ...args], {
    stdio: 'inherit',
    shell: IS_WINDOWS,
    env: { ...process.env },
  });
  return result.status || 0;
}

function runSmartInstall(pluginRoot) {
  const smartInstall = path.join(pluginRoot, 'scripts', 'smart-install.js');
  const IS_WINDOWS = process.platform === 'win32';
  const result = spawnSync(process.execPath, [smartInstall], {
    stdio: 'inherit',
    shell: IS_WINDOWS,
    env: { ...process.env },
  });
  return result.status || 0;
}

// --- Main ---
async function main() {
  const pluginRoot = resolvePluginRoot();
  const port = resolvePort();

  switch (action) {
    case 'setup':
      runSmartInstall(pluginRoot);
      break;

    case 'start-worker': {
      runScript(pluginRoot, 'start');
      await waitForWorker(port);
      const alive = await healthCheck(port);
      if (!alive) process.stderr.write(`[claude-mem] worker did not start on port ${port}\n`);
      process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n');
      break;
    }

    case 'context': {
      const alive = await waitForWorker(port);
      if (alive) runScript(pluginRoot, 'hook', 'claude-code', 'context');
      break;
    }

    case 'session-init': {
      let alive = await healthCheck(port);
      if (!alive) {
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (await healthCheck(port)) { alive = true; break; }
        }
      }
      if (alive) runScript(pluginRoot, 'hook', 'claude-code', 'session-init');
      break;
    }

    case 'observation':
      runScript(pluginRoot, 'hook', 'claude-code', 'observation');
      break;

    case 'file-context':
      runScript(pluginRoot, 'hook', 'claude-code', 'file-context');
      break;

    case 'summarize':
      runScript(pluginRoot, 'hook', 'claude-code', 'summarize');
      break;

    case 'session-complete':
      runScript(pluginRoot, 'hook', 'claude-code', 'session-complete');
      break;

    case 'register-autostart': {
      if (process.platform !== 'win32') {
        process.stderr.write('[claude-mem] register-autostart is Windows-only\n');
        break;
      }
      const TASK_NAME = 'claude-mem-worker';
      const hookRunner = path.join(pluginRoot, 'scripts', 'hook-runner.js');
      const psScript = [
        `$action = New-ScheduledTaskAction -Execute '${process.execPath.replace(/'/g, "''")}' -Argument '"${hookRunner.replace(/'/g, "''")}\" start-worker'`,
        `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
        `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -RunLevel Limited -Force`,
      ].join('; ');
      const result = spawnSync('powershell', ['-NoProfile', '-Command', psScript], {
        stdio: 'pipe', shell: false,
      });
      if (result.status === 0) {
        process.stderr.write('[claude-mem] Auto-start registered: worker will start on next Windows login\n');
      } else {
        process.stderr.write(`[claude-mem] Failed to register auto-start: ${(result.stderr || '').toString().trim()}\n`);
        process.exit(1);
      }
      break;
    }

    case 'unregister-autostart': {
      if (process.platform !== 'win32') {
        process.stderr.write('[claude-mem] unregister-autostart is Windows-only\n');
        break;
      }
      const TASK_NAME = 'claude-mem-worker';
      const markerPath = path.join(pluginRoot, '.autostart-registered');
      spawnSync('powershell', ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`], { stdio: 'pipe', shell: false });
      try { require('fs').unlinkSync(markerPath); } catch { /* already gone */ }
      process.stderr.write('[claude-mem] Auto-start unregistered\n');
      break;
    }

    default:
      process.stderr.write(`[claude-mem] hook-runner: unknown action "${action}"\n`);
      process.exit(1);
  }
}

main().catch(err => {
  process.stderr.write(`[claude-mem] hook-runner error: ${err.message}\n`);
  process.exit(1);
});
