import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// 1) 优先读环境变量，其次用 LocalAppData（Windows）/ tmp（跨平台兜底）
function getLockFilePath() {
  const fromEnv =
    process.env.LOCK_FILE_PATH ||
    process.env.MCP_SSH_LOCK_PATH ||
    process.env.MCP_LOCK_FILE;

  if (fromEnv && fromEnv.trim()) return fromEnv;

  // Windows: C:\Users\<u>\AppData\Local\mcp-ssh-safeguard\.mcp-ssh.lock
  const base =
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "mcp-ssh-safeguard")
      : path.join(os.tmpdir(), "mcp-ssh-safeguard");

  return path.join(base, ".mcp-ssh.lock");
}

const LOCK_FILE = getLockFilePath();

export class ProcessManager {
  private instanceId: string;

  constructor() {
    this.instanceId = Date.now().toString();
    this.registerCleanup();
  }

  private registerCleanup(): void {
    process.on("SIGINT", () => this.cleanup());
    process.on("SIGTERM", () => this.cleanup());
    process.on("exit", () => this.cleanup());
  }

  private cleanup(): void {
    try {
      if (fs.existsSync(LOCK_FILE)) {
        const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        if (lockData.instanceId === this.instanceId) {
          fs.unlinkSync(LOCK_FILE);
        }
      }
    } catch (error) {
      console.error("Error cleaning up lock file:", error);
    }
  }

  private async waitForProcessExit(pid: number, maxWaitTime: number = 5000): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitTime) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        return true;
      }
    }
    return false;
  }

  public async checkAndCreateLock(): Promise<boolean> {
    try {
      // 2) 确保锁文件目录存在（避免 ENOENT）
      fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

      // 旧逻辑保持不变：存在则尝试终止旧进程并清理
      if (fs.existsSync(LOCK_FILE)) {
        const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
        try {
          process.kill(lockData.pid, 0);
          console.error("发现已存在的MCP-SSH实例，正在终止旧进程...");
          process.kill(lockData.pid, "SIGTERM");

          const exited = await this.waitForProcessExit(lockData.pid);
          if (!exited) {
            console.error("等待旧进程退出超时");
            return false;
          }
          fs.unlinkSync(LOCK_FILE);
        } catch {
          console.error("发现旧的锁文件但进程已不存在，正在清理...");
          fs.unlinkSync(LOCK_FILE);
        }
      }

      // 3) 原子创建：防止并发时互相覆盖（wx = 文件存在就失败）
      fs.writeFileSync(
        LOCK_FILE,
        JSON.stringify({ pid: process.pid, instanceId: this.instanceId, timestamp: Date.now() }),
        { flag: "wx" }
      );

      console.error("MCP-SSH进程锁创建成功:", LOCK_FILE);
      return true;
    } catch (error: any) {
      // 如果是并发导致已存在，可以给更友好的提示
      if (error?.code === "EEXIST") {
        console.error("锁文件已存在：可能已有实例正在运行。", LOCK_FILE);
      } else {
        console.error("处理锁文件时出错:", error);
      }
      return false;
    }
  }
}
