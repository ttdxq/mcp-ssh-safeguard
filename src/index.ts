#!/usr/bin/env node

import { SshMCP } from './tools/ssh.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { ProcessManager } from './process-manager.js';

// 加载环境变量
config();

// 如果设置了 MCP_SSE_PORT，则走 SSE 模式（由 sse-server.ts 处理）
// 否则走 stdio 模式（当前文件的默认行为）
const SSE_MODE = !!process.env.MCP_SSE_PORT;

if (SSE_MODE) {
  // SSE 模式：动态导入 sse-server.ts，由其自行启动 HTTP 服务器
  import('./sse-server.js');
} else {
  // ── stdio 模式（原始行为） ──
  startStdioMode();
}

async function startStdioMode() {
  // 确保 stdin 保持活跃状态
  process.stdin.resume();

  let shutdownPromise: Promise<void> | null = null;
  let isShuttingDown = false;

  async function gracefulShutdown(sshMCP: SshMCP, processManager: ProcessManager, exitCode: number, reason: string): Promise<void> {
    isShuttingDown = true;
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        console.error(reason);
        try {
          await sshMCP.close();
        } catch (error) {
          console.error('关闭SSH MCP服务时出错:', error);
        }
        processManager.cleanup();
      })();
    }

    await shutdownPromise;
    process.exit(exitCode);
  }

  function shutdownOnFatalError(reason: string, error: unknown): void {
    console.error(reason, error);
    gracefulShutdown(sshMCP, processManager, 1, '发生致命错误，正在关闭SSH MCP服务...').catch(() => process.exit(1));
  }

  // 初始化进程管理器
  const processManager = new ProcessManager();
  if (!await processManager.checkAndCreateLock()) {
    console.error('无法创建进程锁，程序退出');
    process.exit(1);
  }

  // 实例化SSH MCP
  const sshMCP = new SshMCP();

  // 连接 stdio 传输层
  const transport = new StdioServerTransport();
  await sshMCP.connectTransport(transport).catch(err => {
    console.error('连接MCP传输错误:', err);
  });

  // 处理进程退出 — 仅 SIGINT/SIGTERM 才真正关闭进程
  process.on('SIGINT', async () => {
    await gracefulShutdown(sshMCP, processManager, 0, '正在关闭SSH MCP服务...');
  });

  process.on('SIGTERM', async () => {
    await gracefulShutdown(sshMCP, processManager, 0, '正在关闭SSH MCP服务...');
  });

  // uncaughtException / unhandledRejection 只记录日志，不杀进程
  process.on('uncaughtException', (err) => {
    if (isShuttingDown) {
      shutdownOnFatalError('关闭过程中发生未捕获的异常:', err);
      return;
    }

    shutdownOnFatalError('未捕获的异常，准备退出:', err);
  });

  process.on('unhandledRejection', (reason) => {
    if (isShuttingDown) {
      shutdownOnFatalError('关闭过程中发生未处理的Promise拒绝:', reason);
      return;
    }

    shutdownOnFatalError('未处理的Promise拒绝，准备退出:', reason);
  });

  // 监听 stdin 的结束事件
  process.stdin.on('end', () => {
    console.error('stdin closed, keeping process alive');
  });

  console.error('SSH MCP服务已启动（stdio模式）');
}
