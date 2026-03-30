#!/usr/bin/env node

/**
 * Patch MCP SDK default request timeout from 60s to 10 minutes.
 *
 * The MCP TypeScript SDK hard-codes DEFAULT_REQUEST_TIMEOUT_MSEC = 60000 (60s)
 * in protocol.js. Any MCP tool call that takes longer than 60s will be killed
 * by the client-side timeout, even if the tool's own timeout is set higher.
 *
 * This script patches both ESM and CJS builds after `npm install`.
 * It runs automatically via the `postinstall` hook in package.json.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OLD_VALUE = 60000;
const NEW_VALUE = 600000;

const files = [
  path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'shared', 'protocol.js'),
  path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'shared', 'protocol.js'),
];

let patched = 0;

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.warn(`[patch-mcp-timeout] File not found, skipping: ${file}`);
    continue;
  }

  let content = fs.readFileSync(file, 'utf8');

  // ESM format: export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;
  // CJS format: exports.DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;
  const esmPattern = `export const DEFAULT_REQUEST_TIMEOUT_MSEC = ${OLD_VALUE};`;
  const cjsPattern = `exports.DEFAULT_REQUEST_TIMEOUT_MSEC = ${OLD_VALUE};`;

  if (content.includes(esmPattern)) {
    content = content.replace(esmPattern, `export const DEFAULT_REQUEST_TIMEOUT_MSEC = ${NEW_VALUE};`);
    fs.writeFileSync(file, content, 'utf8');
    console.log(`[patch-mcp-timeout] Patched ESM: ${file} (${OLD_VALUE}ms -> ${NEW_VALUE}ms)`);
    patched++;
  } else if (content.includes(cjsPattern)) {
    content = content.replace(cjsPattern, `exports.DEFAULT_REQUEST_TIMEOUT_MSEC = ${NEW_VALUE};`);
    fs.writeFileSync(file, content, 'utf8');
    console.log(`[patch-mcp-timeout] Patched CJS: ${file} (${OLD_VALUE}ms -> ${NEW_VALUE}ms)`);
    patched++;
  } else if (content.includes(`DEFAULT_REQUEST_TIMEOUT_MSEC = ${NEW_VALUE}`)) {
    console.log(`[patch-mcp-timeout] Already patched: ${file}`);
    patched++;
  } else {
    console.warn(`[patch-mcp-timeout] Could not find timeout pattern in: ${file}`);
  }
}

if (patched === 0) {
  console.error('[patch-mcp-timeout] ERROR: No files were patched!');
  process.exit(1);
} else {
  console.log(`[patch-mcp-timeout] Done. ${patched}/${files.length} files patched.`);
}
