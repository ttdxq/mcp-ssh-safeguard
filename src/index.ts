#!/usr/bin/env node

import { SshMCP } from './tools/ssh.js';
import { config } from 'dotenv';
import { ProcessManager } from './process-manager.js';

// 加载环境变量
config();

// 确保 stdin 保持活跃状态
process.stdin.resume();

let shutdownPromise: Promise<void> | null = null;

async function shutdown(sshMCP: SshMCP, processManager: ProcessManager, exitCode: number, reason: string): Promise<void> {
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

  // 处理进程退出
  process.on('SIGINT', async () => {
    await shutdown(sshMCP, processManager, 0, '正在关闭SSH MCP服务...');
  });

  process.on('SIGTERM', async () => {
    await shutdown(sshMCP, processManager, 0, '正在关闭SSH MCP服务...');
  });

  process.on('uncaughtException', async (err) => {
    console.error('未捕获的异常:', err);
    await shutdown(sshMCP, processManager, 1, '检测到致命异常，正在安全关闭SSH MCP服务...');
  });

  process.on('unhandledRejection', async (reason) => {
    console.error('未处理的Promise拒绝:', reason);
    await shutdown(sshMCP, processManager, 1, '检测到未处理的Promise拒绝，正在安全关闭SSH MCP服务...');
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
