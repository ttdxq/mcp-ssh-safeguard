import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { OutputCacheService } from '../services/output-cache-service.js';
import type { SafetyCheckResult } from '../services/safety-check-service.js';
import type { SSHConnection, SSHService } from './ssh-service.js';

export type OperationRiskType = 'command' | 'background_command' | 'file_upload' | 'file_download' | 'batch_file_upload' | 'batch_file_download' | 'tunnel_create' | 'terminal_write';

export interface McpTextContent {
  [key: string]: unknown;
  type: 'text';
  text: string;
}

export interface McpToolResponse {
  content: McpTextContent[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface OperationPolicyAssessment {
  allowed: boolean;
  response?: McpToolResponse;
}

export interface BackgroundExecutionState {
  interval: NodeJS.Timeout;
  lastCheck: Date;
}

export interface PendingConfirmationEntry {
  command: string;
  safetyResult: SafetyCheckResult;
  expiresAt: number;
}

export interface AssessOperationPolicyParams {
  connectionId: string;
  command: string;
  confirmation?: string;
  operationType: OperationRiskType;
  operationSummary?: string;
}

export type AssessOperationPolicy = (params: AssessOperationPolicyParams) => Promise<OperationPolicyAssessment>;
export type FormatConnectionInfo = (connection: SSHConnection, includePassword?: boolean) => string;
export type FormatConnectionPoolInfo = () => string;
export type FormatTimeDifference = (date: Date) => string;
export type FormatFileSize = (bytes: number) => string;
export type StopBackgroundExecution = (connectionId: string) => void;
export type LimitOutputLength = (text: string, maxLength?: number, targetLength?: number) => string;

export interface ConnectionToolsContext {
  server: McpServer;
  sshService: SSHService;
  activeConnections: Map<string, Date>;
  backgroundExecutions: Map<string, BackgroundExecutionState>;
  formatConnectionInfo: FormatConnectionInfo;
  formatConnectionPoolInfo: FormatConnectionPoolInfo;
  stopBackgroundExecution: StopBackgroundExecution;
}

export interface CommandToolsContext {
  server: McpServer;
  sshService: SSHService;
  outputCacheService: OutputCacheService;
  activeConnections: Map<string, Date>;
  backgroundExecutions: Map<string, BackgroundExecutionState>;
  assessOperationPolicy: AssessOperationPolicy;
  stopBackgroundExecution: StopBackgroundExecution;
}

export interface FileToolsContext {
  server: McpServer;
  sshService: SSHService;
  activeConnections: Map<string, Date>;
  assessOperationPolicy: AssessOperationPolicy;
  formatFileSize: FormatFileSize;
}

export interface SessionToolsContext {
  server: McpServer;
  sshService: SSHService;
  activeConnections: Map<string, Date>;
  backgroundExecutions: Map<string, BackgroundExecutionState>;
  formatConnectionInfo: FormatConnectionInfo;
  formatTimeDifference: FormatTimeDifference;
  stopBackgroundExecution: StopBackgroundExecution;
}

export interface TerminalToolsContext {
  server: McpServer;
  sshService: SSHService;
  assessOperationPolicy: AssessOperationPolicy;
  limitOutputLength: LimitOutputLength;
}

export interface TunnelToolsContext {
  server: McpServer;
  sshService: SSHService;
  assessOperationPolicy: AssessOperationPolicy;
}

export interface CacheToolsContext {
  server: McpServer;
  outputCacheService: OutputCacheService;
}
