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
import { SshMCP } from './tools/ssh.js';
import { config } from 'dotenv';
import { ReliableSSEServerTransport, type ReliableSseLogEvent } from './reliable-sse-server-transport.js';

config();

const PORT = parseInt(process.env.MCP_SSE_PORT || '3001', 10);
const HOST = process.env.MCP_SSE_HOST || '127.0.0.1';
const SSE_HEARTBEAT_INTERVAL_MS = parseInt(process.env.MCP_SSE_HEARTBEAT_INTERVAL || '15000', 10);
const SSE_WRITE_TIMEOUT_MS = parseInt(process.env.MCP_SSE_WRITE_TIMEOUT || '5000', 10);

type SseLogLanguage = 'zh' | 'en';
type SseLogLanguageMode = SseLogLanguage | 'auto';
type SseLogEvent =
  | 'session-open'
  | 'session-cleanup'
  | 'heartbeat-sent'
  | 'http-message-post'
  | ReliableSseLogEvent;

const SSE_LOG_LANGUAGE_MODE = normalizeSseLogLanguageMode(process.env.MCP_SSE_LOG_LANGUAGE);

const SSE_LOG_EVENT_LABELS: Record<SseLogEvent, Record<SseLogLanguage, string>> = {
  'session-open': { zh: '会话已建立', en: 'session-open' },
  'session-cleanup': { zh: '会话清理', en: 'session-cleanup' },
  'heartbeat-sent': { zh: '心跳已发送', en: 'heartbeat-sent' },
  'http-message-post': { zh: '收到消息请求', en: 'http-message-post' },
  'transport-started': { zh: '传输已启动', en: 'transport-started' },
  'message-received': { zh: '已接收消息', en: 'message-received' },
  'message-accepted': { zh: '消息已接受', en: 'message-accepted' },
  'message-sent': { zh: '消息已发送', en: 'message-sent' },
  'message-send-failed': { zh: '消息发送失败', en: 'message-send-failed' },
};

// 活跃的 SSE 传输会话
const activeTransports = new Map<string, {
  transport: ReliableSSEServerTransport;
  sshMCP: SshMCP;
  language: SseLogLanguage;
}>();

function formatLogDetails(details: Record<string, string | number | boolean | null | undefined>): string {
  const parts = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function normalizeSseLogLanguageMode(value: string | undefined): SseLogLanguageMode {
  const normalized = value?.trim().toLowerCase();

  if (!normalized || normalized === 'auto') {
    return 'auto';
  }

  if (normalized === 'zh' || normalized === 'en') {
    return normalized;
  }

  console.error(`[SSE] Invalid MCP_SSE_LOG_LANGUAGE=${JSON.stringify(value)}, falling back to auto`);
  return 'auto';
}

function detectSseLogLanguage(acceptLanguageHeader: string | string[] | undefined): SseLogLanguage {
  if (SSE_LOG_LANGUAGE_MODE === 'zh' || SSE_LOG_LANGUAGE_MODE === 'en') {
    return SSE_LOG_LANGUAGE_MODE;
  }

  const value = Array.isArray(acceptLanguageHeader)
    ? acceptLanguageHeader.join(',')
    : acceptLanguageHeader;

  if (!value) {
    return 'en';
  }

  return /(^|,|;)\s*zh(?:-|$)/i.test(value) ? 'zh' : 'en';
}

function logSse(
  event: SseLogEvent,
  language: SseLogLanguage,
  details: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const eventLabel = SSE_LOG_EVENT_LABELS[event][language];
  console.error(`[SSE] ${eventLabel}${formatLogDetails(details)}`);
}

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
    let pendingSessionId: string | null = null;
    const preferredLanguage = detectSseLogLanguage(req.headers['accept-language']);

    try {
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      res.socket?.setTimeout(0);
      res.socket?.setNoDelay(true);

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-cache, no-transform');

      const sshMCP = new SshMCP();
      const transport = new ReliableSSEServerTransport({
        endpoint: '/messages',
        response: res,
        writeTimeoutMs: SSE_WRITE_TIMEOUT_MS,
        onActivity: () => {
          lastActivityAt = Date.now();
        },
        onLog: (event, details) => {
          logSse(event, preferredLanguage, details);
        },
      });
      const sessionId = transport.sessionId;
      pendingSessionId = sessionId;
      const connectedAt = Date.now();
      let lastActivityAt = connectedAt;
      let cleanedUp = false;
      let heartbeatTimer: NodeJS.Timeout | null = null;

      const cleanupSession = (reason: string) => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        activeTransports.delete(sessionId);
        const connectionDurationMs = Date.now() - connectedAt;
        const idleForMs = Date.now() - lastActivityAt;
        logSse('session-cleanup', preferredLanguage, {
          sessionId,
          reason,
          connectionDurationMs,
          idleForMs,
          activeConnections: activeTransports.size,
        });
      };

      const writeHeartbeat = () => {
        if (cleanedUp || res.writableEnded || res.destroyed) {
          cleanupSession('heartbeat-detected-closed-socket');
          return;
        }

        try {
          res.write(`: ping ${Date.now()}\n\n`);
          lastActivityAt = Date.now();
          logSse('heartbeat-sent', preferredLanguage, {
            sessionId,
            activeConnections: activeTransports.size,
          });
        } catch (error) {
          console.error(`[SSE] heartbeat 写入失败 sessionId=${sessionId}:`, error);
          cleanupSession('heartbeat-write-failed');
        }
      };

      activeTransports.set(sessionId, { transport, sshMCP, language: preferredLanguage });

      logSse('session-open', preferredLanguage, {
        sessionId,
        activeConnections: activeTransports.size,
      });

      // 客户端断开时清理，避免覆盖 SDK 内部 onclose 行为
      req.once('aborted', () => cleanupSession('request-aborted'));
      res.once('close', () => cleanupSession('response-close'));
      res.once('finish', () => cleanupSession('response-finish'));
      res.once('error', (error) => {
        console.error(`[SSE] response error sessionId=${sessionId}:`, error);
        cleanupSession('response-error');
      });

      await sshMCP.connectTransport(transport);
      if (cleanedUp || res.writableEnded || res.destroyed) {
        cleanupSession('transport-connected-after-close');
        return;
      }

      heartbeatTimer = setInterval(writeHeartbeat, SSE_HEARTBEAT_INTERVAL_MS);
    } catch (err) {
      if (pendingSessionId) {
        activeTransports.delete(pendingSessionId);
      }
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
      const parsedMessage = parsed as { id?: string | number; method?: string; params?: { name?: string } };

      logSse('http-message-post', entry.language, {
        sessionId,
        messageId: parsedMessage.id !== undefined ? String(parsedMessage.id) : undefined,
        method: parsedMessage.method,
        toolName: parsedMessage.method === 'tools/call' ? parsedMessage.params?.name : undefined,
      });

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

function shutdownOnFatalError(reason: string, error: unknown): void {
  console.error(reason, error);
  if (isShuttingDown) {
    process.exit(1);
    return;
  }

  gracefulShutdown('fatal error');
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  shutdownOnFatalError('[SSE] 未捕获的异常，准备退出:', err);
});

process.on('unhandledRejection', (reason) => {
  shutdownOnFatalError('[SSE] 未处理的 Promise 拒绝，准备退出:', reason);
});

server.listen(PORT, HOST, () => {
  console.error(`[SSE] SSH MCP SSE 服务器已启动 → http://${HOST}:${PORT}`);
  console.error(`[SSE] SSE 端点: http://${HOST}:${PORT}/sse`);
  console.error(`[SSE] 健康检查: http://${HOST}:${PORT}/health`);
  console.error(`[SSE] 等待客户端连接...`);
});
