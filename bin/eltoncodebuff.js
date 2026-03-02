#!/usr/bin/env node

/**
 * ⚡ EltonCodeBuff CLI
 * Run from any project folder to start the AI coding assistant.
 * Usage: eltoncodebuff [project-path]
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const projectPath = process.argv[2] || process.cwd();

console.log('');
console.log('  ⚡ EltonCodeBuff — Free AI Coding Assistant');
console.log('  ────────────────────────────────────────────');
console.log(`  📂 Project: ${projectPath}`);
console.log('');

// Check if server is already running
async function isServerRunning() {
    try {
        const resp = await fetch('http://localhost:3777/api/config', { signal: AbortSignal.timeout(2000) });
        return resp.ok;
    } catch {
        return false;
    }
}

async function main() {
    const running = await isServerRunning();

    if (running) {
        console.log('  ✅ Server already running at http://localhost:3777');
        console.log('  🔀 Proxy available at http://localhost:3777/v1');
        console.log('');
        console.log('  Opening browser...');
        openBrowser(`http://localhost:3777`);
    } else {
        console.log('  🚀 Starting EltonCodeBuff server...');
        console.log('');

        const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
            cwd: ROOT,
            stdio: 'inherit',
            env: { ...process.env, ELTONCODEBUFF_PROJECT: projectPath },
        });

        server.on('error', (err) => {
            console.error('  ❌ Failed to start server:', err.message);
            process.exit(1);
        });

        // Wait for server to be ready, then open browser
        let attempts = 0;
        const check = setInterval(async () => {
            attempts++;
            if (await isServerRunning()) {
                clearInterval(check);
                console.log('');
                console.log('  Opening browser...');
                openBrowser('http://localhost:3777');
            }
            if (attempts > 30) {
                clearInterval(check);
            }
        }, 1000);

        // Handle shutdown
        process.on('SIGINT', () => {
            server.kill();
            process.exit(0);
        });
    }
}

function openBrowser(url) {
    const start = process.platform === 'win32' ? 'start'
        : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(start, [url], { shell: true, detached: true, stdio: 'ignore' });
}

main();
