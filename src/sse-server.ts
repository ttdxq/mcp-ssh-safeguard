#!/usr/bin/env node

/**
 * SSE (Server-Sent Events) MCP 服务器
 *
 * 允许多个 MCP 客户端（agent）同时连接到同一个 MCP 服务进程，
 * 解决 stdio 模式下"新 agent 启动会杀死旧 agent 的 MCP 进程"的问题。
 *
 * 使用方式：
 *   MCP_SSE_PORT=3001 node dist/sse-server.js
 *
 * 客户端 MCP 配置（以 Cursor 为例）：
 *   {
 *     "mcpServers": {
 *       "ssh-mcp-safeguard": {
 *         "url": "http://localhost:3001/sse"
 *       }
 *     }
 *   }
 */

import * as http from 'http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { SshMCP } from './tools/ssh.js';
import { config } from 'dotenv';

config();

const PORT = parseInt(process.env.MCP_SSE_PORT || '3001', 10);
const HOST = process.env.MCP_SSE_HOST || '127.0.0.1';

// 活跃的 SSE 传输会话
const activeTransports = new Map<string, {
  transport: SSEServerTransport;
  sshMCP: SshMCP;
}>();

/**
 * 从请求中读取完整 body（JSON 字符串）
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 解析 URL 查询参数中的 sessionId
 */
function extractSessionId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/[?&]sessionId=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const server = http.createServer(async (req, res) => {
  // ── CORS 预检（方便调试） ──
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── GET /sse —— 建立 SSE 长连接 ──
  if (req.method === 'GET' && req.url?.startsWith('/sse')) {
    try {
      const sshMCP = new SshMCP();
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;

      activeTransports.set(sessionId, { transport, sshMCP });

      console.error(`[SSE] 新客户端连接 sessionId=${sessionId}，当前活跃连接: ${activeTransports.size}`);

      // 客户端断开时清理
      const originalOnClose = transport.onclose?.bind(transport);
      transport.onclose = () => {
        activeTransports.delete(sessionId);
        console.error(`[SSE] 客户端断开 sessionId=${sessionId}，剩余活跃连接: ${activeTransports.size}`);
        originalOnClose?.();
      };

      await sshMCP.connectTransport(transport);
    } catch (err) {
      console.error('[SSE] 建立连接失败:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('SSE connection failed');
      }
    }
    return;
  }

  // ── POST /messages —— 接收客户端请求并路由到对应 transport ──
  if (req.method === 'POST' && req.url?.startsWith('/messages')) {
    const sessionId = extractSessionId(req.url);
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing sessionId');
      return;
    }

    const entry = activeTransports.get(sessionId);
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Unknown session');
      return;
    }

    try {
      const body = await readBody(req);
      // 将解析后的 JSON 传入 handlePostMessage
      const parsed = JSON.parse(body);
      await entry.transport.handlePostMessage(req, res, parsed);
    } catch (err) {
      console.error('[SSE] 处理消息失败:', err);
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad request');
      }
    }
    return;
  }

  // ── 健康检查 ──
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      activeConnections: activeTransports.size,
      mode: 'sse',
    }));
    return;
  }

  // ── 404 ──
  res.writeHead(404);
  res.end('Not found');
});

// 优雅退出
let isShuttingDown = false;
function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`\n[SSE] 收到 ${signal}，正在关闭服务器...`);

  // 关闭所有活跃的 transport
  for (const [sessionId, entry] of activeTransports.entries()) {
    try {
      entry.transport.close();
    } catch {
      // 忽略关闭时的错误
    }
  }
  activeTransports.clear();

  server.close(() => {
    console.error('[SSE] 服务器已关闭');
    process.exit(0);
  });

  // 5 秒后强制退出
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[SSE] 未捕获的异常:', err);
  if (isShuttingDown) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[SSE] 未处理的 Promise 拒绝:', reason);
});

server.listen(PORT, HOST, () => {
  console.error(`[SSE] SSH MCP SSE 服务器已启动 → http://${HOST}:${PORT}`);
  console.error(`[SSE] SSE 端点: http://${HOST}:${PORT}/sse`);
  console.error(`[SSE] 健康检查: http://${HOST}:${PORT}/health`);
  console.error(`[SSE] 等待客户端连接...`);
});
