import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as crypto from 'crypto';
import Loki, { Collection } from 'lokijs';
import { NodeSSH } from 'node-ssh';
import * as path from 'path';

import type { SSHExecCommandResponse } from 'node-ssh';
import type { Client as SSHClient } from 'ssh2';

import { FileTransferService } from '../services/file-transfer-service.js';
import { isInsecureDockerCredentialPersistenceEnabled, loadConfig, resolveDataPath } from '../services/runtime-config.js';
import { type SSHCredentials, ConnectionStatus } from '../services/ssh-service-types.js';
import { TerminalService } from '../services/terminal-service.js';
import { TunnelService } from '../services/tunnel-service.js';

export { ConnectionStatus } from '../services/ssh-service-types.js';
export type {
  SSHConnectionConfig,
  SSHConnection,
  CommandResult,
  BackgroundTaskResult,
  TunnelConfig,
  FileTransferInfo,
  BatchTransferConfig,
  TerminalSessionConfig,
  TerminalSession,
  TerminalDataEvent,
  TerminalResizeEvent,
} from '../services/ssh-service-types.js';

import type {
  BackgroundTaskResult,
  BatchTransferConfig,
  CommandResult,
  FileTransferInfo,
  SSHConnection,
  SSHConnectionConfig,
  TerminalDataEvent,
  TerminalSession,
  TerminalSessionConfig,
  TerminalResizeEvent,
  TunnelConfig,
} from '../services/ssh-service-types.js';

interface BackgroundTask {
  client: NodeSSH;
  process: any;
  output: string;
  isRunning: boolean;
  exitCode?: number;
  error?: string;
  startTime: Date;
  endTime?: Date;
  interval?: NodeJS.Timeout;
}

export class SSHService {
  private static readonly HEALTH_CHECK_TIMEOUT = 10 * 1000;
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly RECONNECT_DELAY = 5 * 1000;

  private readonly connectionPools: Map<string, SSHConnection[]> = new Map();
  private readonly connections: Map<string, SSHConnection> = new Map();
  private db: Loki | null = null;
  private connectionCollection: Collection<any> | null = null;
  private credentialCollection: Collection<any> | null = null;
  private dataPath: string;
  private serviceReady: boolean = false;
  private serviceReadyPromise: Promise<void>;
  private isDocker: boolean = false;
  private allowInsecureDockerCredentialPersistence: boolean = false;
  private readonly backgroundTasks: Map<string, BackgroundTask> = new Map();
  private readonly eventEmitter: EventEmitter = new EventEmitter();
  private readonly fileTransferService: FileTransferService;
  private readonly tunnelService: TunnelService;
  private readonly terminalService: TerminalService;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly healthCheckInterval: number;
  private readonly MAX_POOL_SIZE = loadConfig().SSH_POOL_SIZE;

  constructor() {
    const cfg = loadConfig();
    const { dataPath, warning } = resolveDataPath(cfg);

    this.dataPath = dataPath;
    this.isDocker = cfg.IS_DOCKER;
    this.allowInsecureDockerCredentialPersistence = this.isDocker && isInsecureDockerCredentialPersistenceEnabled(cfg);
    this.healthCheckInterval = loadConfig().HEALTH_CHECK_INTERVAL;

    this.fileTransferService = new FileTransferService(this.getConnection.bind(this));
    this.tunnelService = new TunnelService(this.getConnection.bind(this));
    this.terminalService = new TerminalService(this.getConnection.bind(this), this.getCredentials.bind(this));

    if (warning) {
      console.warn(warning);
    }

    if (this.isDocker && !this.allowInsecureDockerCredentialPersistence) {
      console.warn('Docker mode disables remembered passwords by default; set ALLOW_INSECURE_DOCKER_CREDENTIALS=true to restore the old plaintext behavior.');
    }

    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }

    this.serviceReadyPromise = this.initDatabase();
    this.setupCleanupTasks();
  }

  private async initDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db = new Loki(path.join(this.dataPath, 'ssh-connections.db'), {
        autoload: true,
        autoloadCallback: () => {
          if (this.db) {
            this.connectionCollection = this.db.getCollection('connections');
            if (!this.connectionCollection) {
              this.connectionCollection = this.db.addCollection('connections', {
                indices: ['id', 'host', 'username']
              });
            }

            this.credentialCollection = this.db.getCollection('credentials');
            if (!this.credentialCollection) {
              this.credentialCollection = this.db.addCollection('credentials', {
                unique: ['id']
              });
            }

            this.loadSavedConnections();
            this.serviceReady = true;
            resolve();
          } else {
            reject(new Error('数据库初始化失败'));
          }
        },
        autosave: true,
        autosaveInterval: 5000
      });
    });
  }

  private async ensureReady(): Promise<void> {
    if (!this.serviceReady) {
      await this.serviceReadyPromise;
    }
  }

  private async loadSavedConnections(): Promise<void> {
    if (!this.connectionCollection) {
      return;
    }

    const savedConnections = this.connectionCollection.find();

    for (const conn of savedConnections) {
      const { id, name, config, lastUsed, tags } = conn;

      this.connections.set(id, {
        id,
        name,
        config: {
          host: config.host,
          port: config.port || loadConfig().DEFAULT_SSH_PORT,
          username: config.username,
          privateKey: config.privateKey,
          keepaliveInterval: 60000,
          readyTimeout: loadConfig().CONNECTION_TIMEOUT
        },
        status: ConnectionStatus.DISCONNECTED,
        lastUsed: lastUsed ? new Date(lastUsed) : undefined,
        tags
      });
    }
  }

  private generatePoolKey(config: SSHConnectionConfig): string {
    return `${config.username}@${config.host}:${config.port || 22}`;
  }

  private generateConnectionId(config: SSHConnectionConfig, name?: string, tags?: string[]): string {
    void name;
    void tags;
    return crypto
      .createHash('md5')
      .update(`${config.username}@${config.host}:${config.port || 22}:${Date.now()}:${crypto.randomBytes(4).toString('hex')}`)
      .digest('hex');
  }

  private async saveConnection(connection: SSHConnection): Promise<void> {
    await this.ensureReady();

    if (!this.connectionCollection) {
      return;
    }

    const existing = this.connectionCollection.findOne({ id: connection.id });
    const connData = {
      id: connection.id,
      name: connection.name,
      config: {
        host: connection.config.host,
        port: connection.config.port,
        username: connection.config.username,
        privateKey: connection.config.privateKey
      },
      lastUsed: connection.lastUsed ? connection.lastUsed.toISOString() : new Date().toISOString(),
      tags: connection.tags || []
    };

    if (existing) {
      this.connectionCollection.update({ ...existing, ...connData });
    } else {
      this.connectionCollection.insert(connData);
    }

    if (this.db) {
      this.db.saveDatabase();
    }
  }

  private async saveCredentials(id: string, password?: string, passphrase?: string): Promise<void> {
    if (this.isDocker) {
      if (!this.allowInsecureDockerCredentialPersistence) {
        return;
      }

      await this.ensureReady();
      if (!this.credentialCollection) {
        return;
      }

      const existing = this.credentialCollection.findOne({ id });
      if (existing) {
        existing.password = password;
        existing.passphrase = passphrase;
        this.credentialCollection.update(existing);
      } else {
        this.credentialCollection.insert({ id, password, passphrase });
      }
      return;
    }

    try {
      const keytar = (await import('keytar')).default;
      if (password) {
        await keytar.setPassword('mcp-ssh', id, password);
      }
      if (passphrase) {
        await keytar.setPassword('mcp-ssh-passphrase', id, passphrase);
      }
    } catch (error) {
      console.warn(`无法保存凭证: ${error}`);
    }
  }

  private async getCredentials(id: string): Promise<SSHCredentials> {
    if (this.isDocker) {
      if (!this.allowInsecureDockerCredentialPersistence) {
        return {};
      }

      await this.ensureReady();
      if (!this.credentialCollection) {
        return {};
      }

      const creds = this.credentialCollection.findOne({ id });
      return creds ? { password: creds.password, passphrase: creds.passphrase } : {};
    }

    try {
      const keytar = (await import('keytar')).default;
      const password = await keytar.getPassword('mcp-ssh', id);
      const passphrase = await keytar.getPassword('mcp-ssh-passphrase', id);
      return { password: password || undefined, passphrase: passphrase || undefined };
    } catch (error) {
      console.warn(`无法检索凭证: ${error}`);
      return {};
    }
  }

  public async connect(config: SSHConnectionConfig, name?: string, rememberPassword: boolean = false, tags?: string[]): Promise<SSHConnection> {
    await this.ensureReady();

    const poolKey = this.generatePoolKey(config);
    const connectionId = this.generateConnectionId(config, name, tags);

    let pool = this.connectionPools.get(poolKey);
    if (!pool) {
      pool = [];
      this.connectionPools.set(poolKey, pool);
    }

    const availableConnection = pool.find((conn) => conn.status === ConnectionStatus.CONNECTED && conn.client);
    if (availableConnection) {
      return availableConnection;
    }

    const connection: SSHConnection = {
      id: connectionId,
      name: name || `${config.username}@${config.host}`,
      config,
      status: ConnectionStatus.CONNECTING,
      tags,
      lastUsed: new Date(),
      poolKey,
      poolIndex: pool.length,
      createdAt: new Date()
    };

    try {
      if (!config.password && !config.privateKey) {
        const savedCredentials = await this.getCredentials(connectionId);
        if (savedCredentials.password) {
          config.password = savedCredentials.password;
        }
        if (savedCredentials.passphrase) {
          config.passphrase = savedCredentials.passphrase;
        }
      }

      const ssh = new NodeSSH();
      const connectOptions = {
        host: config.host,
        port: config.port || loadConfig().DEFAULT_SSH_PORT,
        username: config.username,
        password: config.password,
        privateKey: config.privateKey,
        passphrase: config.passphrase,
        keepaliveInterval: config.keepaliveInterval || 60000,
        readyTimeout: config.readyTimeout || loadConfig().CONNECTION_TIMEOUT
      };

      await ssh.connect(connectOptions);

      connection.client = ssh;
      connection.status = ConnectionStatus.CONNECTED;
      connection.lastUsed = new Date();
      connection.lastError = undefined;
      connection.currentDirectory = await this.getCurrentDirectory(connectionId);

      pool.push(connection);
      this.connections.set(connectionId, connection);

      if (rememberPassword) {
        await this.saveCredentials(connectionId, config.password, config.passphrase);
      }

      await this.saveConnection(connection);
      return connection;
    } catch (error) {
      connection.status = ConnectionStatus.ERROR;
      connection.lastError = error instanceof Error ? error.message : String(error);

      pool.push(connection);
      this.connections.set(connectionId, connection);

      if (config.reconnect && config.reconnectTries && config.reconnectTries > 0) {
        this.scheduleReconnect(connectionId, config);
      }

      throw error;
    }
  }

  private scheduleReconnect(connectionId: string, config: SSHConnectionConfig): void {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    connection.status = ConnectionStatus.RECONNECTING;

    const reconnectTries = config.reconnectTries || loadConfig().RECONNECT_ATTEMPTS;
    const reconnectDelay = config.reconnectDelay || 5000;

    let attempts = 0;

    const attemptReconnect = async () => {
      attempts++;

      try {
        await this.connect(config);
        console.error(`成功重新连接到 ${config.host}`);
      } catch (error) {
        console.error(`重连尝试 ${attempts}/${reconnectTries} 失败:`, error);

        if (attempts < reconnectTries) {
          setTimeout(attemptReconnect, reconnectDelay);
        } else {
          const failedConnection = this.connections.get(connectionId);
          if (failedConnection) {
            failedConnection.status = ConnectionStatus.ERROR;
          }
        }
      }
    };

    setTimeout(attemptReconnect, reconnectDelay);
  }

  public async disconnect(connectionId: string, disconnectAll: boolean = false): Promise<boolean> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client) {
      return false;
    }

    try {
      await connection.client.dispose();
      connection.status = ConnectionStatus.DISCONNECTED;
      connection.client = undefined;

      if (disconnectAll && connection.poolKey) {
        const pool = this.connectionPools.get(connection.poolKey);
        if (pool) {
          for (const conn of pool) {
            if (conn.id !== connectionId && conn.client && conn.status === ConnectionStatus.CONNECTED) {
              try {
                await conn.client.dispose();
                conn.status = ConnectionStatus.DISCONNECTED;
                conn.client = undefined;
              } catch (err) {
                console.error(`断开池中连接 ${conn.id} 时出错:`, err);
              }
            }
          }
        }
      }

      return true;
    } catch (error) {
      console.error(`断开连接 ${connectionId} 时出错:`, error);
      connection.status = ConnectionStatus.ERROR;
      connection.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  public async disconnectAllByPoolKey(poolKey: string): Promise<number> {
    const pool = this.connectionPools.get(poolKey);
    if (!pool) {
      return 0;
    }

    let disconnectedCount = 0;
    for (const connection of pool) {
      if (connection.client && connection.status === ConnectionStatus.CONNECTED) {
        try {
          await connection.client.dispose();
          connection.status = ConnectionStatus.DISCONNECTED;
          connection.client = undefined;
          disconnectedCount++;
        } catch (error) {
          console.error(`断开连接 ${connection.id} 时出错:`, error);
        }
      }
    }

    return disconnectedCount;
  }

  public async cleanupIdleConnections(poolKey?: string, idleTimeoutMs: number = 30 * 60 * 1000): Promise<number> {
    const now = new Date();
    let cleanedCount = 0;

    const poolsToClean = poolKey
      ? [[poolKey, this.connectionPools.get(poolKey)].filter(Boolean) as [string, SSHConnection[]]]
      : Array.from(this.connectionPools.entries());

    for (const [key, pool] of poolsToClean) {
      for (const connection of pool) {
        if (connection.status === ConnectionStatus.DISCONNECTED || connection.status === ConnectionStatus.ERROR) {
          if (connection.client) {
            try {
              await connection.client.dispose();
            } catch (error) {
              console.error(`清理连接 ${connection.id} 时出错:`, error);
            }
            connection.client = undefined;
          }
          cleanedCount++;
        } else if (
          connection.lastUsed
          && (now.getTime() - connection.lastUsed.getTime()) > idleTimeoutMs
          && connection.status === ConnectionStatus.CONNECTED
        ) {
          try {
            if (connection.client) {
              await connection.client.dispose();
              connection.client = undefined;
            }
            connection.status = ConnectionStatus.DISCONNECTED;
            cleanedCount++;
          } catch (error) {
            console.error(`清理空闲连接 ${connection.id} 时出错:`, error);
          }
        }
      }

      const activeConnections = pool.filter((connection) => connection.status === ConnectionStatus.CONNECTED || connection.status === ConnectionStatus.CONNECTING);
      if (activeConnections.length < pool.length) {
        this.connectionPools.set(key, activeConnections);
        activeConnections.forEach((connection, index) => {
          connection.poolIndex = index;
        });
      }
    }

    return cleanedCount;
  }

  public async getAllConnections(): Promise<SSHConnection[]> {
    await this.ensureReady();
    return Array.from(this.connections.values());
  }

  public getConnectionPools(): Map<string, SSHConnection[]> {
    return this.connectionPools;
  }

  public getPoolConnections(poolKey: string): SSHConnection[] {
    return this.connectionPools.get(poolKey) || [];
  }

  public getConnection(connectionId: string): SSHConnection | undefined {
    return this.connections.get(connectionId);
  }

  public async waitUntilReady(): Promise<void> {
    await this.ensureReady();
  }

  public async executeCommand(connectionId: string, command: string, options?: { cwd?: string; timeout?: number }): Promise<CommandResult> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    try {
      const execOptions: { cwd?: string } = {};

      if (options?.cwd) {
        execOptions.cwd = options.cwd;
      } else if (connection.currentDirectory) {
        execOptions.cwd = connection.currentDirectory;
      }

      const commandTimeout = options?.timeout ?? loadConfig().COMMAND_TIMEOUT;
      const sudoPassword = await this.getSudoPassword(connection, command);
      if (sudoPassword) {
        const result = await this.executeSudoCommand(connection, command, sudoPassword, options);

        if (this.commandMayChangeDirectory(command)) {
          connection.currentDirectory = await this.getCurrentDirectory(connectionId);
        }

        return result;
      }

      let timeoutHandle: NodeJS.Timeout | undefined;
      const resultPromise = connection.client.execCommand(command, execOptions);
      const result = await (commandTimeout
        ? Promise.race([
            resultPromise,
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(() => reject(new Error(`命令执行超时 (${commandTimeout}ms)`)), commandTimeout);
            })
          ]).finally(() => {
            if (timeoutHandle) {
              clearTimeout(timeoutHandle);
            }
          })
        : resultPromise);

      if (this.commandMayChangeDirectory(command)) {
        connection.currentDirectory = await this.getCurrentDirectory(connectionId);
      }

      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code as number
      };
    } catch (error) {
      console.error(`在连接 ${connectionId} 上执行命令时出错:`, error);
      return {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        code: 1
      };
    }
  }

  public async executeBackgroundCommand(connectionId: string, command: string, options?: { cwd?: string; interval?: number }): Promise<string> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    try {
      const execOptions: { cwd?: string } = {};

      if (options?.cwd) {
        execOptions.cwd = options.cwd;
      } else if (connection.currentDirectory) {
        execOptions.cwd = connection.currentDirectory;
      }

      const taskId = crypto
        .createHash('md5')
        .update(`${connectionId}:${command}:${Date.now()}`)
        .digest('hex');

      const sudoPassword = await this.getSudoPassword(connection, command);
      if (sudoPassword) {
        const process = await this.startSudoBackgroundCommand(connection, command, sudoPassword, execOptions.cwd, taskId);
        const task: BackgroundTask = {
          client: connection.client,
          process,
          output: '',
          isRunning: true,
          startTime: new Date()
        };

        this.backgroundTasks.set(taskId, task);
        this.attachBackgroundProcessHandlers(taskId, process, options?.interval);
        return taskId;
      }

      const process = await connection.client.exec(command, [], {
        cwd: execOptions.cwd,
        stream: 'both',
        onStdout: (chunk) => {
          const task = this.backgroundTasks.get(taskId);
          if (task) {
            task.output += chunk.toString('utf8');
            this.eventEmitter.emit('task-update', { id: taskId, output: task.output });
          }
        },
        onStderr: (chunk) => {
          const task = this.backgroundTasks.get(taskId);
          if (task) {
            task.output += chunk.toString('utf8');
            this.eventEmitter.emit('task-update', { id: taskId, output: task.output });
          }
        }
      });

      const task: BackgroundTask = {
        client: connection.client,
        process,
        output: '',
        isRunning: true,
        startTime: new Date()
      };

      this.backgroundTasks.set(taskId, task);
      this.attachBackgroundProcessHandlers(taskId, process, options?.interval);

      return taskId;
    } catch (error) {
      console.error(`在连接 ${connectionId} 上启动后台命令时出错:`, error);
      throw error;
    }
  }

  public canPersistCredentials(): boolean {
    return !this.isDocker || this.allowInsecureDockerCredentialPersistence;
  }

  private async getSudoPassword(connection: SSHConnection, command: string): Promise<string | undefined> {
    if (!this.isSudoCommand(command)) {
      return undefined;
    }

    let password = connection.config.password;
    if (!password) {
      const savedCredentials = await this.getCredentials(connection.id);
      password = savedCredentials.password;
    }

    return password;
  }

  private isSudoCommand(command: string): boolean {
    const sudoPrefixPattern = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*sudo(?=\s|$)/;
    return this.getTopLevelCommandSegments(command).some(({ text }) => sudoPrefixPattern.test(text));
  }

  private getRawSshClient(connection: SSHConnection): SSHClient {
    const sshClient = (connection.client as NodeSSH & { connection?: SSHClient }).connection;
    if (!sshClient) {
      throw new Error('无法获取底层SSH连接');
    }

    return sshClient;
  }

  private wrapCommandWithCwd(command: string, cwd?: string): string {
    if (!cwd) {
      return command;
    }

    const escapedCwd = cwd.replace(/'/g, `"'"'`);
    return `cd -- '${escapedCwd}' && ${command}`;
  }

  private normalizeSudoCommand(command: string): string {
    const sudoPrefixPattern = /^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*)sudo(?=\s|$)/;
    const segments = this.getTopLevelCommandSegments(command);

    if (segments.length === 0) {
      return command;
    }

    let normalized = '';
    let lastIndex = 0;

    for (const segment of segments) {
      normalized += command.slice(lastIndex, segment.start);
      normalized += segment.text.replace(sudoPrefixPattern, '$1sudo -S -p ""');
      lastIndex = segment.end;
    }

    normalized += command.slice(lastIndex);
    return normalized;
  }

  private commandMayChangeDirectory(command: string): boolean {
    const cdPrefixPattern = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*cd(?=\s|$)/;
    return this.getTopLevelCommandSegments(command).some(({ text }) => cdPrefixPattern.test(text));
  }

  private getTopLevelCommandSegments(command: string): Array<{ start: number; end: number; text: string }> {
    const segments: Array<{ start: number; end: number; text: string }> = [];
    let segmentStart = 0;
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escaped = false;

    const pushSegment = (end: number) => {
      const text = command.slice(segmentStart, end);
      if (text.trim()) {
        segments.push({ start: segmentStart, end, text });
      }
    };

    for (let index = 0; index < command.length; index++) {
      const char = command[index];
      const next = command[index + 1];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\' && !inSingleQuote) {
        escaped = true;
        continue;
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (inSingleQuote || inDoubleQuote) {
        continue;
      }

      if (char === ';' || char === '\n') {
        pushSegment(index);
        segmentStart = index + 1;
        continue;
      }

      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        pushSegment(index);
        segmentStart = index + 2;
        index++;
        continue;
      }

      if (char === '&' || char === '|') {
        pushSegment(index);
        segmentStart = index + 1;
      }
    }

    pushSegment(command.length);
    return segments;
  }

  private async executeSudoCommand(
    connection: SSHConnection,
    command: string,
    password: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<CommandResult> {
    const sshClient = this.getRawSshClient(connection);
    const wrappedCommand = this.wrapCommandWithCwd(this.normalizeSudoCommand(command), options?.cwd ?? connection.currentDirectory);

    return await new Promise<CommandResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;

      const timeout = options?.timeout
        ?? (process.env.COMMAND_TIMEOUT && parseInt(process.env.COMMAND_TIMEOUT) > 0
          ? parseInt(process.env.COMMAND_TIMEOUT)
          : undefined);

      let timeoutHandle: NodeJS.Timeout | undefined;
      if (timeout) {
        timeoutHandle = setTimeout(() => {
          settled = true;
          reject(new Error(`命令执行超时 (${timeout}ms)`));
        }, timeout);
      }

      sshClient.exec(wrappedCommand, (err, stream) => {
        if (err) {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          reject(err);
          return;
        }

        stream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });

        stream.on('close', (code?: number) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            stdout,
            stderr,
            code: typeof code === 'number' ? code : 0
          });
        });

        stream.on('error', (streamError: Error) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          if (settled) {
            return;
          }
          settled = true;
          reject(streamError);
        });

        stream.write(`${password}\n`);
      });
    });
  }

  private async startSudoBackgroundCommand(
    connection: SSHConnection,
    command: string,
    password: string,
    cwd: string | undefined,
    taskId: string,
  ): Promise<SSHExecCommandResponse> {
    const sshClient = this.getRawSshClient(connection);
    const wrappedCommand = this.wrapCommandWithCwd(this.normalizeSudoCommand(command), cwd ?? connection.currentDirectory);

    return await new Promise<SSHExecCommandResponse>((resolve, reject) => {
      sshClient.exec(wrappedCommand, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        stream.on('data', (chunk: Buffer) => {
          const task = this.backgroundTasks.get(taskId);
          if (task) {
            task.output += chunk.toString('utf8');
            this.eventEmitter.emit('task-update', { id: taskId, output: task.output });
          }
        });

        stream.stderr.on('data', (chunk: Buffer) => {
          const task = this.backgroundTasks.get(taskId);
          if (task) {
            task.output += chunk.toString('utf8');
            this.eventEmitter.emit('task-update', { id: taskId, output: task.output });
          }
        });

        stream.write(`${password}\n`);
        resolve(stream as unknown as SSHExecCommandResponse);
      });
    });
  }

  private attachBackgroundProcessHandlers(taskId: string, process: SSHExecCommandResponse, intervalMs?: number): void {
    const task = this.backgroundTasks.get(taskId);
    if (!task) {
      return;
    }

    let checkInterval: NodeJS.Timeout | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;

    if (process && typeof process === 'object' && Object.prototype.hasOwnProperty.call(process, 'code')) {
      const code = (process as unknown as { code?: number }).code;
      task.isRunning = false;
      task.exitCode = typeof code === 'number' ? code : 0;
      task.endTime = new Date();

      this.eventEmitter.emit('task-end', {
        id: taskId,
        output: task.output,
        exitCode: task.exitCode,
        startTime: task.startTime,
        endTime: task.endTime
      });
      return;
    }

    const channel = process as unknown as { on?: (event: string, handler: (...args: unknown[]) => void) => void };
    if (channel.on) {
      channel.on('close', (...args: unknown[]) => {
        if (checkInterval) {
          clearInterval(checkInterval);
          checkInterval = undefined;
        }
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }

        const currentTask = this.backgroundTasks.get(taskId);
        if (!currentTask || !currentTask.isRunning) {
          return;
        }

        const code = typeof args[0] === 'number' ? args[0] : 0;
        currentTask.isRunning = false;
        currentTask.exitCode = code;
        currentTask.endTime = new Date();

        if (currentTask.interval) {
          clearInterval(currentTask.interval);
          currentTask.interval = undefined;
        }

        this.eventEmitter.emit('task-end', {
          id: taskId,
          output: currentTask.output,
          exitCode: currentTask.exitCode,
          startTime: currentTask.startTime,
          endTime: currentTask.endTime
        });
      });
    }

    checkInterval = setInterval(() => {
      const currentTask = this.backgroundTasks.get(taskId);
      if (
        currentTask
        && currentTask.isRunning
        && process
        && typeof process === 'object'
        && Object.prototype.hasOwnProperty.call(process, 'code')
      ) {
        clearInterval(checkInterval);

        const code = (process as unknown as { code?: number }).code;
        currentTask.isRunning = false;
        currentTask.exitCode = typeof code === 'number' ? code : 0;
        currentTask.endTime = new Date();

        if (currentTask.interval) {
          clearInterval(currentTask.interval);
          currentTask.interval = undefined;
        }

        this.eventEmitter.emit('task-end', {
          id: taskId,
          output: currentTask.output,
          exitCode: currentTask.exitCode,
          startTime: currentTask.startTime,
          endTime: currentTask.endTime
        });
      }
    }, 1000);

    timeoutHandle = setTimeout(() => {
      clearInterval(checkInterval);
      const currentTask = this.backgroundTasks.get(taskId);
      if (currentTask && currentTask.isRunning) {
        currentTask.isRunning = false;
        currentTask.exitCode = -1;
        currentTask.endTime = new Date();

        if (currentTask.interval) {
          clearInterval(currentTask.interval);
          currentTask.interval = undefined;
        }

        this.eventEmitter.emit('task-end', {
          id: taskId,
          output: currentTask.output,
          exitCode: currentTask.exitCode,
          startTime: currentTask.startTime,
          endTime: currentTask.endTime
        });
      }
    }, 5 * 60 * 1000);

    if (intervalMs) {
      const interval = setInterval(() => {
        const currentTask = this.backgroundTasks.get(taskId);
        if (currentTask && currentTask.isRunning) {
          this.eventEmitter.emit('task-update', {
            id: taskId,
            output: currentTask.output,
            isRunning: true,
            startTime: currentTask.startTime
          });
        } else {
          clearInterval(interval);
        }
      }, intervalMs);

      task.interval = interval;
    }
  }

  public async stopBackgroundTask(taskId: string): Promise<boolean> {
    const task = this.backgroundTasks.get(taskId);
    if (!task || !task.isRunning) {
      return false;
    }

    try {
      task.process.signal('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));

      if (task.isRunning) {
        task.process.signal('SIGKILL');
      }

      task.isRunning = false;
      task.endTime = new Date();
      task.error = '任务被强制终止';

      if (task.interval) {
        clearInterval(task.interval);
        task.interval = undefined;
      }

      this.eventEmitter.emit('task-end', {
        id: taskId,
        output: task.output,
        error: task.error,
        startTime: task.startTime,
        endTime: task.endTime
      });

      return true;
    } catch (error) {
      console.error(`停止后台任务 ${taskId} 时出错:`, error);
      return false;
    }
  }

  public getBackgroundTaskInfo(taskId: string): BackgroundTaskResult | undefined {
    const task = this.backgroundTasks.get(taskId);
    if (!task) {
      return undefined;
    }

    return {
      id: taskId,
      output: task.output,
      isRunning: task.isRunning,
      exitCode: task.exitCode,
      error: task.error,
      startTime: task.startTime,
      endTime: task.endTime
    };
  }

  public getAllBackgroundTasks(): BackgroundTaskResult[] {
    const results: BackgroundTaskResult[] = [];

    for (const [id, task] of this.backgroundTasks.entries()) {
      results.push({
        id,
        output: task.output,
        isRunning: task.isRunning,
        exitCode: task.exitCode,
        error: task.error,
        startTime: task.startTime,
        endTime: task.endTime
      });
    }

    return results;
  }

  public async uploadFile(connectionId: string, localPath: string, remotePath: string): Promise<FileTransferInfo> {
    return this.fileTransferService.uploadFile(connectionId, localPath, remotePath);
  }

  public async downloadFile(connectionId: string, remotePath: string, localPath: string): Promise<FileTransferInfo> {
    return this.fileTransferService.downloadFile(connectionId, remotePath, localPath);
  }

  public async batchTransfer(config: BatchTransferConfig): Promise<string[]> {
    return this.fileTransferService.batchTransfer(config);
  }

  public getTransferInfo(transferId: string): FileTransferInfo | undefined {
    return this.fileTransferService.getTransferInfo(transferId);
  }

  public getAllTransfers(): FileTransferInfo[] {
    return this.fileTransferService.getAllTransfers();
  }

  public onTransferProgress(callback: (info: FileTransferInfo) => void): () => void {
    return this.fileTransferService.onTransferProgress(callback);
  }

  public onTransferComplete(callback: (info: FileTransferInfo) => void): () => void {
    return this.fileTransferService.onTransferComplete(callback);
  }

  public onTransferError(callback: (info: FileTransferInfo) => void): () => void {
    return this.fileTransferService.onTransferError(callback);
  }

  private async getCurrentDirectory(connectionId: string): Promise<string> {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    try {
      const result = await connection.client.execCommand('pwd');
      return result.stdout.trim();
    } catch (error) {
      console.error('获取当前目录时出错:', error);
      return '';
    }
  }

  public async deleteConnection(connectionId: string): Promise<boolean> {
    await this.ensureReady();

    const connection = this.connections.get(connectionId);
    if (!connection) {
      return false;
    }

    await this.disconnect(connectionId);

    if (connection.poolKey) {
      const pool = this.connectionPools.get(connection.poolKey);
      if (pool) {
        const index = pool.findIndex((conn) => conn.id === connectionId);
        if (index !== -1) {
          pool.splice(index, 1);
          pool.forEach((conn, idx) => {
            conn.poolIndex = idx;
          });
        }
        if (pool.length === 0) {
          this.connectionPools.delete(connection.poolKey);
        }
      }
    }

    this.connections.delete(connectionId);

    if (this.connectionCollection) {
      this.connectionCollection.findAndRemove({ id: connectionId });
    }

    if (!this.isDocker) {
      try {
        const keytar = (await import('keytar')).default;
        await keytar.deletePassword('mcp-ssh', connectionId);
        await keytar.deletePassword('mcp-ssh-passphrase', connectionId);
      } catch (error) {
        console.warn(`无法删除凭证: ${error}`);
      }
    } else {
      await this.ensureReady();
      if (this.credentialCollection) {
        this.credentialCollection.findAndRemove({ id: connectionId });
      }
    }

    return true;
  }

  public async createTunnel(config: TunnelConfig): Promise<string> {
    return this.tunnelService.createTunnel(config);
  }

  public async closeTunnel(tunnelId: string): Promise<boolean> {
    return this.tunnelService.closeTunnel(tunnelId);
  }

  public getTunnels(): TunnelConfig[] {
    return this.tunnelService.getTunnels();
  }

  public async createTerminalSession(connectionId: string, config?: TerminalSessionConfig): Promise<string> {
    return this.terminalService.createTerminalSession(connectionId, config);
  }

  public async writeToTerminal(sessionId: string, data: string): Promise<boolean> {
    return this.terminalService.writeToTerminal(sessionId, data);
  }

  public async resizeTerminal(sessionId: string, rows: number, cols: number): Promise<boolean> {
    return this.terminalService.resizeTerminal(sessionId, rows, cols);
  }

  public async closeTerminalSession(sessionId: string): Promise<boolean> {
    return this.terminalService.closeTerminalSession(sessionId);
  }

  public getTerminalSession(sessionId: string): Omit<TerminalSession, 'stream'> | undefined {
    return this.terminalService.getTerminalSession(sessionId);
  }

  public getAllTerminalSessions(): Omit<TerminalSession, 'stream'>[] {
    return this.terminalService.getAllTerminalSessions();
  }

  public onTerminalData(callback: (event: TerminalDataEvent) => void): () => void {
    return this.terminalService.onTerminalData(callback);
  }

  public onTerminalClose(callback: (event: { sessionId: string }) => void): () => void {
    return this.terminalService.onTerminalClose(callback);
  }

  private setupCleanupTasks(): void {
    setInterval(() => {
      this.cleanupCompletedTransfers();
    }, 60 * 60 * 1000);

    setInterval(async () => {
      try {
        const cleaned = await this.cleanupIdleConnections();
        if (cleaned > 0) {
          console.log(`清理了 ${cleaned} 个空闲连接`);
        }
      } catch (error) {
        console.error('清理空闲连接时出错:', error);
      }
    }, 30 * 60 * 1000);

    setInterval(() => {
      this.cleanupInactiveResources();
    }, 24 * 60 * 60 * 1000);

    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck().catch((err: unknown) => {
        console.error('健康检查出错:', err);
      });
    }, this.healthCheckInterval);
  }

  private cleanupCompletedTransfers(): void {
    this.fileTransferService.cleanupCompletedTransfers();
  }

  private cleanupInactiveResources(): void {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    for (const session of this.terminalService.getAllTerminalSessions()) {
      if (session.lastActivity < oneDayAgo) {
        this.closeTerminalSession(session.id).catch((err) => {
          console.error(`自动清理终端会话 ${session.id} 时出错:`, err);
        });
      }
    }

    for (const tunnelId of this.tunnelService.getTunnels().map((tunnel) => tunnel.id).filter((id): id is string => Boolean(id))) {
      void tunnelId;
    }

    console.error(`已清理不活跃资源，当前终端会话: ${this.terminalService.getSessionCount()}, 隧道: ${this.tunnelService.getTunnelCount()}`);
  }

  private async performHealthCheck(): Promise<void> {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.status !== ConnectionStatus.CONNECTED || !connection.client) {
        continue;
      }

      try {
        const result = await this.executeCommand(connectionId, 'echo __mcp_ssh_health_check__', {
          timeout: SSHService.HEALTH_CHECK_TIMEOUT
        });

        if (result.code !== 0) {
          throw new Error(result.stderr || 'health check command failed');
        }

        if (!result.stdout.includes('__mcp_ssh_health_check__')) {
          throw new Error('health check returned unexpected output');
        }
      } catch (error) {
        connection.status = ConnectionStatus.DISCONNECTED;
        connection.lastError = error instanceof Error ? error.message : String(error);

        try {
          await connection.client.dispose();
        } catch {
        }

        connection.client = undefined;

        if (connection.config.reconnect) {
          await this.tryReconnect(connectionId);
        }
      }
    }
  }

  private async tryReconnect(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    const reconnectAttempts = connection.config.reconnectTries || SSHService.MAX_RECONNECT_ATTEMPTS;
    const reconnectDelay = connection.config.reconnectDelay || SSHService.RECONNECT_DELAY;

    connection.status = ConnectionStatus.RECONNECTING;

    for (let attempt = 1; attempt <= reconnectAttempts; attempt++) {
      try {
        await new Promise((resolve) => setTimeout(resolve, reconnectDelay));

        const reconnectConfig: SSHConnectionConfig = {
          ...connection.config
        };

        if (!reconnectConfig.password && !reconnectConfig.privateKey) {
          const savedCredentials = await this.getCredentials(connectionId);
          if (savedCredentials.password) {
            reconnectConfig.password = savedCredentials.password;
          }
          if (savedCredentials.passphrase) {
            reconnectConfig.passphrase = savedCredentials.passphrase;
          }
        }

        const ssh = new NodeSSH();
        await ssh.connect({
          host: reconnectConfig.host,
          port: reconnectConfig.port || loadConfig().DEFAULT_SSH_PORT,
          username: reconnectConfig.username,
          password: reconnectConfig.password,
          privateKey: reconnectConfig.privateKey,
          passphrase: reconnectConfig.passphrase,
          keepaliveInterval: reconnectConfig.keepaliveInterval || 60000,
          readyTimeout: reconnectConfig.readyTimeout || loadConfig().CONNECTION_TIMEOUT
        });

        connection.client = ssh;
        connection.status = ConnectionStatus.CONNECTED;
        connection.lastUsed = new Date();
        connection.lastError = undefined;
        connection.currentDirectory = await this.getCurrentDirectory(connectionId);
        await this.saveConnection(connection);
        return;
      } catch (error) {
        connection.lastError = error instanceof Error ? error.message : String(error);
        if (attempt === reconnectAttempts) {
          connection.status = ConnectionStatus.ERROR;
          return;
        }
      }
    }
  }

  public async close(): Promise<void> {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    await this.terminalService.closeAllSessions();
    await this.tunnelService.closeAll();

    for (const taskId of this.backgroundTasks.keys()) {
      await this.stopBackgroundTask(taskId);
    }

    for (const pool of this.connectionPools.values()) {
      for (const connection of pool) {
        if (connection.status === ConnectionStatus.CONNECTED && connection.client) {
          try {
            await connection.client.dispose();
            connection.status = ConnectionStatus.DISCONNECTED;
            connection.client = undefined;
          } catch (error) {
            console.error(`关闭连接 ${connection.id} 时出错:`, error);
          }
        }
      }
    }

    this.connectionPools.clear();
    this.connections.clear();

    if (this.db) {
      this.db.saveDatabase();
    }
  }
}
