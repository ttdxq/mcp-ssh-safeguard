#!/usr/bin/env node

import { SshMCP } from './tools/ssh.js';
import { config } from 'dotenv';
import { ProcessManager } from './process-manager.js';

// 加载环境变量
config();

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

// 主函数
async function main() {
  // 初始化进程管理器
  const processManager = new ProcessManager();
  if (!await processManager.checkAndCreateLock()) {
    console.error('无法创建进程锁，程序退出');
    process.exit(1);
  }

  // 实例化SSH MCP
  const sshMCP = new SshMCP();

  // 处理进程退出 — 仅 SIGINT/SIGTERM 才真正关闭进程
  process.on('SIGINT', async () => {
    await gracefulShutdown(sshMCP, processManager, 0, '正在关闭SSH MCP服务...');
  });

  process.on('SIGTERM', async () => {
    await gracefulShutdown(sshMCP, processManager, 0, '正在关闭SSH MCP服务...');
  });

  // uncaughtException / unhandledRejection 只记录日志，不杀进程
  // 之前直接 process.exit(1) 会导致多轮使用后 MCP 服务端进程意外死亡
  process.on('uncaughtException', (err) => {
    console.error('未捕获的异常（不退出）:', err);
    if (isShuttingDown) {
      gracefulShutdown(sshMCP, processManager, 1, '关闭过程中发生异常').catch(() => process.exit(1));
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('未处理的Promise拒绝（不退出）:', reason);
    if (isShuttingDown) {
      gracefulShutdown(sshMCP, processManager, 1, '关闭过程中发生异常').catch(() => process.exit(1));
    }
  });

  // 监听 stdin 的结束事件
  process.stdin.on('end', () => {
    console.error('stdin closed, keeping process alive');
  });

  console.error('SSH MCP服务已启动');
}

// 启动应用
main().catch(error => {
  console.error('启动失败:', error);
  process.exit(1);
});
