import type { NodeSSH } from 'node-ssh';

export interface SSHConnectionConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  keepaliveInterval?: number;
  readyTimeout?: number;
  reconnect?: boolean;
  reconnectTries?: number;
  reconnectDelay?: number;
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

export interface SSHConnection {
  id: string;
  name?: string;
  config: SSHConnectionConfig;
  status: ConnectionStatus;
  lastUsed?: Date;
  lastError?: string;
  client?: NodeSSH;
  tags?: string[];
  currentDirectory?: string;
  poolKey?: string;
  poolIndex?: number;
  createdAt?: Date;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface BackgroundTaskResult {
  id: string;
  output: string;
  isRunning: boolean;
  exitCode?: number;
  error?: string;
  startTime: Date;
  endTime?: Date;
}

export interface TunnelConfig {
  id?: string;
  connectionId: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  description?: string;
}

export interface FileTransferInfo {
  id: string;
  localPath: string;
  remotePath: string;
  direction: 'upload' | 'download';
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  progress: number;
  size: number;
  bytesTransferred: number;
  error?: string;
  startTime: Date;
  endTime?: Date;
}

export interface BatchTransferConfig {
  connectionId: string;
  items: {
    localPath: string;
    remotePath: string;
  }[];
  direction: 'upload' | 'download';
}

export interface TerminalSessionConfig {
  rows?: number;
  cols?: number;
  term?: string;
}

export interface TerminalSession {
  id: string;
  connectionId: string;
  stream: any;
  rows: number;
  cols: number;
  term: string;
  isActive: boolean;
  startTime: Date;
  lastActivity: Date;
  sudoPasswordPrompt: boolean;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface TerminalResizeEvent {
  sessionId: string;
  rows: number;
  cols: number;
}

export interface SSHCredentials {
  password?: string;
  passphrase?: string;
}
