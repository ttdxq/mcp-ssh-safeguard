import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import type { NodeSSH } from 'node-ssh';
import type { Client as SSHClient } from 'ssh2';

import {
  ConnectionStatus,
  type SSHConnection,
  type SSHCredentials,
  type TerminalDataEvent,
  type TerminalSession,
  type TerminalSessionConfig,
} from './ssh-service-types.js';

type GetConnectionFn = (connectionId: string) => SSHConnection | undefined;
type GetCredentialsFn = (connectionId: string) => Promise<SSHCredentials>;

export class TerminalService {
  private readonly terminalSessions: Map<string, TerminalSession> = new Map();
  private readonly eventEmitter: EventEmitter = new EventEmitter();

  constructor(
    private readonly getConnectionFn: GetConnectionFn,
    private readonly getCredentialsFn: GetCredentialsFn,
  ) {}

  public async createTerminalSession(connectionId: string, config?: TerminalSessionConfig): Promise<string> {
    const connection = this.getConnectedConnection(connectionId);

    try {
      const sessionId = crypto
        .createHash('md5')
        .update(`terminal:${connectionId}:${Date.now()}`)
        .digest('hex');

      const termConfig = {
        rows: config?.rows || 24,
        cols: config?.cols || 80,
        term: config?.term || 'xterm-256color'
      };

      const ssh2Client = this.getRawSshClient(connection);
      const stream = await new Promise<any>((resolve, reject) => {
        ssh2Client.shell({
          term: termConfig.term,
          rows: termConfig.rows,
          cols: termConfig.cols,
          height: termConfig.rows,
          width: termConfig.cols
        }, (err: Error | undefined, shellStream: any) => {
          if (err) {
            reject(err);
            return;
          }

          resolve(shellStream);
        });
      });

      const session: TerminalSession = {
        id: sessionId,
        connectionId,
        stream,
        rows: termConfig.rows,
        cols: termConfig.cols,
        term: termConfig.term,
        isActive: true,
        startTime: new Date(),
        lastActivity: new Date(),
        sudoPasswordPrompt: false
      };

      this.terminalSessions.set(sessionId, session);

      stream.on('data', (data: Buffer) => {
        try {
          const dataStr = data.toString('utf8');

          if (dataStr.includes('[sudo] password for') || dataStr.includes('Password:') || dataStr.includes('密码：')) {
            session.sudoPasswordPrompt = true;

            const currentConnection = this.getConnectionFn(connectionId);
            if (currentConnection) {
              const password = currentConnection.config.password;
              if (!password) {
                this.getCredentialsFn(currentConnection.id)
                  .then((credentials) => {
                    try {
                      if (credentials.password && session.isActive) {
                        stream.write(`${credentials.password}\n`);
                      }
                    } catch (error) {
                      console.error('自动提供SSH密码时出错:', error);
                    }
                  })
                  .catch((err: unknown) => {
                    console.error('获取SSH密码时出错:', err);
                  });
              } else {
                stream.write(`${password}\n`);
              }
            }
          }

          this.eventEmitter.emit('terminal-data', {
            sessionId,
            data: dataStr
          });

          const currentSession = this.terminalSessions.get(sessionId);
          if (currentSession) {
            currentSession.lastActivity = new Date();
          }
        } catch (error) {
          console.error(`处理终端会话 ${sessionId} 数据时出错:`, error);
        }
      });

      stream.on('close', () => {
        this.closeTerminalSession(sessionId).catch((err) => {
          console.error(`关闭终端会话 ${sessionId} 时出错:`, err);
        });
      });

      return sessionId;
    } catch (error) {
      console.error('创建终端会话时出错:', error);
      throw error;
    }
  }

  public async writeToTerminal(sessionId: string, data: string): Promise<boolean> {
    const session = this.terminalSessions.get(sessionId);
    if (!session || !session.isActive) {
      return false;
    }

    try {
      if (session.sudoPasswordPrompt) {
        session.sudoPasswordPrompt = false;

        const connection = this.getConnectionFn(session.connectionId);
        if (connection) {
          let password = connection.config.password;
          if (!password) {
            const savedCredentials = await this.getCredentialsFn(connection.id);
            password = savedCredentials.password;
          }

          if (password) {
            session.stream.write(`${password}\n`);
            return true;
          }
        }
      }

      session.stream.write(data);
      session.lastActivity = new Date();
      return true;
    } catch (error) {
      console.error('向终端写入数据时出错:', error);
      return false;
    }
  }

  public async resizeTerminal(sessionId: string, rows: number, cols: number): Promise<boolean> {
    const session = this.terminalSessions.get(sessionId);
    if (!session || !session.isActive) {
      throw new Error(`终端会话 ${sessionId} 不存在或不活跃`);
    }

    try {
      session.rows = rows;
      session.cols = cols;
      session.lastActivity = new Date();
      session.stream.setWindow(rows, cols, 0, 0);
      return true;
    } catch (error) {
      console.error(`调整终端会话 ${sessionId} 大小时出错:`, error);
      return false;
    }
  }

  public async closeTerminalSession(sessionId: string): Promise<boolean> {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      if (session.stream && session.isActive) {
        session.stream.removeAllListeners();
        session.stream.end();
        session.isActive = false;
      }

      this.terminalSessions.delete(sessionId);
      this.eventEmitter.emit('terminal-close', { sessionId });
      return true;
    } catch (error) {
      console.error(`关闭终端会话 ${sessionId} 时出错:`, error);
      return false;
    }
  }

  public getTerminalSession(sessionId: string): Omit<TerminalSession, 'stream'> | undefined {
    const session = this.terminalSessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    const { stream, ...sessionInfo } = session;
    return sessionInfo;
  }

  public getAllTerminalSessions(): Omit<TerminalSession, 'stream'>[] {
    const sessions: Omit<TerminalSession, 'stream'>[] = [];

    for (const session of this.terminalSessions.values()) {
      const { stream, ...sessionInfo } = session;
      sessions.push(sessionInfo);
    }

    return sessions;
  }

  public onTerminalData(callback: (event: TerminalDataEvent) => void): () => void {
    this.eventEmitter.on('terminal-data', callback);
    return () => {
      this.eventEmitter.off('terminal-data', callback);
    };
  }

  public onTerminalClose(callback: (event: { sessionId: string }) => void): () => void {
    this.eventEmitter.on('terminal-close', callback);
    return () => {
      this.eventEmitter.off('terminal-close', callback);
    };
  }

  public async closeAllSessions(): Promise<void> {
    for (const sessionId of Array.from(this.terminalSessions.keys())) {
      await this.closeTerminalSession(sessionId);
    }
  }

  public getSessionCount(): number {
    return this.terminalSessions.size;
  }

  private getConnectedConnection(connectionId: string): SSHConnection {
    const connection = this.getConnectionFn(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    return connection;
  }

  private getRawSshClient(connection: SSHConnection): SSHClient {
    const sshClient = (connection.client as NodeSSH & { connection?: SSHClient }).connection;
    if (!sshClient) {
      throw new Error('无法获取底层SSH2连接');
    }

    return sshClient;
  }
}
