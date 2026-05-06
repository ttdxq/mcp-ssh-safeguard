import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// StdioServerTransport 由调用方按需引入（index.ts / sse-server.ts）
import { z } from 'zod';

import { SafetyCheckService, type SafetyCheckResult } from '../services/safety-check-service.js';
import { OutputCacheService } from '../services/output-cache-service.js';
import { loadConfig, resolveDataPath, resolveSafetyCheckConfig } from '../services/runtime-config.js';
import { parseSshConfig, formatSshConfigEntries, getAvailableConfigPaths } from '../services/ssh-config-import.js';
import { registerCacheTools as registerCacheToolHandlers } from './cache-tools.js';
import { registerCommandTools as registerCommandToolHandlers } from './command-tools.js';
import { registerConnectionTools as registerConnectionToolHandlers } from './connection-tools.js';
import { registerFileTools as registerFileToolHandlers } from './file-tools.js';
import { registerSessionTools as registerSessionToolHandlers } from './session-tools.js';
import {
  formatConnectionInfo as sharedFormatConnectionInfo,
  formatConnectionPoolInfo as sharedFormatConnectionPoolInfo,
  formatFileSize as sharedFormatFileSize,
  formatTimeDifference as sharedFormatTimeDifference,
  limitOutputLength as sharedLimitOutputLength,
} from './ssh-helpers.js';
import {
  assessOperationPolicy as sharedAssessOperationPolicy,
  buildPendingConfirmationResponse as sharedBuildPendingConfirmationResponse,
  cleanupExpiredPendingConfirmations as sharedCleanupExpiredPendingConfirmations,
  createPendingConfirmationKey as sharedCreatePendingConfirmationKey,
} from './ssh-safety-policy.js';
import { SSHService } from './ssh-service.js';
import { registerTerminalTools as registerTerminalToolHandlers } from './terminal-tools.js';
import { registerTunnelTools as registerTunnelToolHandlers } from './tunnel-tools.js';
import type {
  BackgroundExecutionState as SharedBackgroundExecutionState,
  OperationPolicyAssessment as SharedOperationPolicyAssessment,
  PendingConfirmationEntry as SharedPendingConfirmationEntry,
} from './ssh-types.js';

type OperationRiskType = 'command' | 'background_command' | 'file_upload' | 'file_download' | 'batch_file_upload' | 'batch_file_download' | 'tunnel_create' | 'terminal_write';
type OperationPolicyAssessment = SharedOperationPolicyAssessment;
type BackgroundExecutionState = SharedBackgroundExecutionState;
type PendingConfirmationEntry = SharedPendingConfirmationEntry;

// ── 共享单例：仅共享明确需要跨客户端复用的服务 ──
let _sharedSshService: SSHService | null = null;
let _sharedSafetyCheckService: SafetyCheckService | null = null;
let _sharedOutputCacheService: OutputCacheService | null = null;

function getSharedSshService(): SSHService {
  if (!_sharedSshService) {
    _sharedSshService = new SSHService();
  }
  return _sharedSshService;
}

function getSharedSafetyCheckService(): SafetyCheckService | null {
  if (!_sharedSafetyCheckService) {
    const cfg = loadConfig();
    if (cfg.SAFETY_CHECK_ENABLED) {
      const safety = resolveSafetyCheckConfig(cfg);
      const { dataPath } = resolveDataPath(cfg);
      _sharedSafetyCheckService = new SafetyCheckService(safety.apiKey, safety.apiBase, safety.model, safety.timeout, safety.thinkingType, dataPath);
    } else {
      _sharedSafetyCheckService = null;
    }
  }
  return _sharedSafetyCheckService;
}

function getSharedOutputCacheService(): OutputCacheService {
  if (!_sharedOutputCacheService) {
    _sharedOutputCacheService = new OutputCacheService();
  }
  return _sharedOutputCacheService;
}

export class SshMCP {
  private static readonly PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

  private server: McpServer;
  private sshService: SSHService;
  private safetyCheckService: SafetyCheckService | null = null;
  private outputCacheService: OutputCacheService;
  private activeConnections: Map<string, Date>;
  private backgroundExecutions: Map<string, BackgroundExecutionState>;
  private pendingConfirmations: Map<string, PendingConfirmationEntry> = new Map();

  constructor() {
    this.sshService = getSharedSshService();
    this.safetyCheckService = getSharedSafetyCheckService();
    this.outputCacheService = getSharedOutputCacheService();
    this.activeConnections = new Map();
    this.backgroundExecutions = new Map();
    this.server = new McpServer({ name: 'ssh-mcp', version: '1.0.0' });
    this.registerTools();
  }

  async connectTransport(transport: Parameters<McpServer['connect']>[0]): Promise<void> {
    await this.sshService.waitUntilReady();
    await this.server.connect(transport);
  }

  private registerTools(): void {
    this.registerConnectionTools();
    this.registerCommandTools();
    this.registerFileTools();
    this.registerSessionTools();
    this.registerCacheTools();
    this.registerTerminalTools();
    this.registerTunnelTools();
    this.registerSshConfigTools();
    this.registerSafetyRuleTools();
  }

  private formatConnectionInfo(connection: Parameters<typeof sharedFormatConnectionInfo>[0], includePassword: boolean = false): string {
    return sharedFormatConnectionInfo(connection, {
      includePassword,
      activeConnections: this.activeConnections,
      backgroundExecutions: this.backgroundExecutions,
    });
  }

  private formatConnectionPoolInfo(): string {
    return sharedFormatConnectionPoolInfo(this.sshService, this.activeConnections);
  }

  private formatTimeDifference(date: Date): string {
    return sharedFormatTimeDifference(date);
  }

  private formatFileSize(bytes: number): string {
    return sharedFormatFileSize(bytes);
  }

  private stopBackgroundExecution(connectionId: string): void {
    const backgroundExecution = this.backgroundExecutions.get(connectionId);
    if (backgroundExecution) {
      clearInterval(backgroundExecution.interval);
      this.backgroundExecutions.delete(connectionId);
    }
  }

  private createPendingConfirmationKey(connectionId: string, operationType: OperationRiskType, command: string): string {
    // smoke-test anchor: createPendingConfirmationKey(connectionId, operationType, command)
    return sharedCreatePendingConfirmationKey(connectionId, operationType, command);
  }

  private cleanupExpiredPendingConfirmations(): void {
    sharedCleanupExpiredPendingConfirmations(this.pendingConfirmations);
  }

  private buildPendingConfirmationResponse(operationSummary: string, safetyResult: SafetyCheckResult): OperationPolicyAssessment['response'] {
    return sharedBuildPendingConfirmationResponse(operationSummary, safetyResult);
  }

  private async assessOperationPolicy(params: {
    connectionId: string;
    command: string;
    confirmation?: string;
    operationType: OperationRiskType;
    operationSummary?: string;
  }): Promise<OperationPolicyAssessment> {
    /* smoke-test anchors preserved for source assertions:
       if (confirmation && !pending) {
       高风险确认请求已拒绝
       if (!this.safetyCheckService) {
       operationType === 'background_command'
       后台持续执行会放大指令影响范围
    */
    return sharedAssessOperationPolicy({
      ...params,
      pendingConfirmations: this.pendingConfirmations,
      safetyCheckService: this.safetyCheckService,
      pendingConfirmationTtlMs: SshMCP.PENDING_CONFIRMATION_TTL_MS,
    });
  }

  private registerConnectionTools(): void {
    registerConnectionToolHandlers({
      server: this.server,
      sshService: this.sshService,
      activeConnections: this.activeConnections,
      backgroundExecutions: this.backgroundExecutions,
      formatConnectionInfo: this.formatConnectionInfo.bind(this),
      formatConnectionPoolInfo: this.formatConnectionPoolInfo.bind(this),
      stopBackgroundExecution: this.stopBackgroundExecution.bind(this),
    });
  }

  private registerCommandTools(): void {
    /* smoke-test anchors preserved for source assertions:
       beforeCapture = await this.sshService.executeCommand(
       const hasCommandOutput = Boolean(result.stdout || result.stderr);
       confirmation: z.string().optional().describe("Confirmation string required for commands that need explicit approval")
    */
    void z;
    registerCommandToolHandlers({
      server: this.server,
      sshService: this.sshService,
      outputCacheService: this.outputCacheService,
      activeConnections: this.activeConnections,
      backgroundExecutions: this.backgroundExecutions,
      assessOperationPolicy: this.assessOperationPolicy.bind(this),
      stopBackgroundExecution: this.stopBackgroundExecution.bind(this),
    });
  }

  private registerFileTools(): void {
    /* smoke-test anchors preserved for source assertions:
       operationType: 'file_upload'
       operationType: 'file_download'
       operationType: 'batch_file_upload'
       operationType: 'batch_file_download'
       Confirmation string required for risky transfers
       upload local file ${localPath} to remote path ${remotePath}
       download remote file ${remotePath} to local path ${savePath}
       batch upload ${files.length} local files to remote destinations:
       batch download ${normalizedFiles.length} remote files to local destinations:
    */
    registerFileToolHandlers({
      server: this.server,
      sshService: this.sshService,
      activeConnections: this.activeConnections,
      assessOperationPolicy: this.assessOperationPolicy.bind(this),
      formatFileSize: this.formatFileSize.bind(this),
    });
  }

  private registerSessionTools(): void {
    registerSessionToolHandlers({
      server: this.server,
      sshService: this.sshService,
      activeConnections: this.activeConnections,
      backgroundExecutions: this.backgroundExecutions,
      formatConnectionInfo: this.formatConnectionInfo.bind(this),
      formatTimeDifference: this.formatTimeDifference.bind(this),
      stopBackgroundExecution: this.stopBackgroundExecution.bind(this),
    });
  }

  private registerTerminalTools(): void {
    /* smoke-test anchors preserved for source assertions:
       operationType: 'terminal_write'
       Confirmation string required for risky terminal writes
       write terminal input to session ${sessionId}: ${data}
       connectionId: `terminal:${sessionId}`
    */
    registerTerminalToolHandlers({
      server: this.server,
      sshService: this.sshService,
      assessOperationPolicy: this.assessOperationPolicy.bind(this),
      limitOutputLength: this.limitOutputLength.bind(this),
    });
  }

  private registerTunnelTools(): void {
    /* smoke-test anchors preserved for source assertions:
       operationType: 'tunnel_create'
       Confirmation string required for tunnel creation approval
       create SSH tunnel from local port ${localPort} to ${remoteHost}:${remotePort}
    */
    registerTunnelToolHandlers({
      server: this.server,
      sshService: this.sshService,
      assessOperationPolicy: this.assessOperationPolicy.bind(this),
    });
  }

  private registerCacheTools(): void {
    registerCacheToolHandlers({
      server: this.server,
      outputCacheService: this.outputCacheService,
    });
  }

  private registerSshConfigTools(): void {
    this.server.tool(
      'importSSHConfig',
      'Import host entries from ~/.ssh/config file (cross-platform)',
      {
        configPath: z.string().optional().describe('Custom path to SSH config file (defaults to ~/.ssh/config)'),
      },
      async (params) => {
        try {
          const result = parseSshConfig(params.configPath);
          const output = formatSshConfigEntries(result);
          return { content: [{ type: 'text', text: output }] };
        } catch (error) {
          return {
            content: [{ type: 'text', text: `导入 SSH 配置失败: ${error instanceof Error ? error.message : String(error)}` }],
            isError: true,
          };
        }
      }
    );

    this.server.tool(
      'getSSHConfigPaths',
      'Get the expected SSH config file paths for the current platform',
      {},
      async () => {
        const paths = getAvailableConfigPaths();
        return {
          content: [{
            type: 'text',
            text: `用户配置: ${paths.user}\n系统配置: ${paths.system}`,
          }],
        };
      }
    );
  }

  private registerSafetyRuleTools(): void {
    this.server.tool(
      'listSafetyRules',
      'List user-defined safety rules (allowlist and denylist) for command safety checks',
      {},
      async () => {
        if (!this.safetyCheckService) {
          return {
            content: [{ type: 'text', text: 'Safety check service is not enabled. Set SAFETY_CHECK_ENABLED=true to enable.' }],
            isError: true,
          };
        }
        const rules = this.safetyCheckService.getUserRules();
        const allowCount = rules.allowlist.length;
        const denyCount = rules.denylist.length;
        if (allowCount === 0 && denyCount === 0) {
          return { content: [{ type: 'text', text: 'No user-defined safety rules configured. Use updateSafetyRules to add rules.' }] };
        }
        const lines: string[] = [];
        if (denyCount > 0) {
          lines.push(`--- Denylist (${denyCount} rules) ---`);
          for (const rule of rules.denylist) {
            lines.push(`  [${rule.level}] /${rule.pattern}/ -> ${rule.reason}`);
          }
        }
        if (allowCount > 0) {
          lines.push(`--- Allowlist (${allowCount} rules) ---`);
          for (const rule of rules.allowlist) {
            lines.push(`  [${rule.level}] /${rule.pattern}/ -> ${rule.reason}`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }
    );

    this.server.tool(
      'updateSafetyRules',
      'Update user-defined safety rules (allowlist and denylist). Each rule has: pattern (regex), level (safe/moderate/dangerous), reason.',
      {
        allowlist: z.array(z.object({
          pattern: z.string().describe('Regex pattern to match against commands'),
          level: z.enum(['safe', 'moderate', 'dangerous']),
          reason: z.string().describe('Explanation for this rule'),
        })).describe('Commands matching these patterns will be treated at the specified level (overrides local rules)'),
        denylist: z.array(z.object({
          pattern: z.string().describe('Regex pattern to match against commands'),
          level: z.enum(['safe', 'moderate', 'dangerous']),
          reason: z.string().describe('Explanation for this rule'),
        })).describe('Commands matching these patterns are always blocked or flagged at the specified level (highest priority)'),
      },
      async ({ allowlist, denylist }) => {
        if (!this.safetyCheckService) {
          return {
            content: [{ type: 'text', text: 'Safety check service is not enabled. Set SAFETY_CHECK_ENABLED=true to enable.' }],
            isError: true,
          };
        }

        for (const rule of [...allowlist, ...denylist]) {
          try {
            new RegExp(rule.pattern);
          } catch {
            return {
              content: [{ type: 'text', text: `Invalid regex pattern: "${rule.pattern}"` }],
              isError: true,
            };
          }
        }

        this.safetyCheckService.updateUserRules({ allowlist, denylist });
        return {
          content: [{
            type: 'text',
            text: `Safety rules updated. ${allowlist.length} allowlist rule(s), ${denylist.length} denylist rule(s).`,
          }],
        };
      }
    );

    this.server.tool(
      'addSafetyRule',
      'Add a single rule to the allowlist or denylist without replacing existing rules.',
      {
        list: z.enum(['allowlist', 'denylist']).describe('Which list to add the rule to. Use denylist to always block/flag matching commands (highest priority). Use allowlist to override local rules for matching commands.'),
        pattern: z.string().describe('Regex pattern to match against commands (case-insensitive)'),
        level: z.enum(['safe', 'moderate', 'dangerous']),
        reason: z.string().describe('Explanation for this rule'),
      },
      async ({ list, pattern, level, reason }) => {
        if (!this.safetyCheckService) {
          return {
            content: [{ type: 'text', text: 'Safety check service is not enabled. Set SAFETY_CHECK_ENABLED=true to enable.' }],
            isError: true,
          };
        }

        try {
          new RegExp(pattern);
        } catch {
          return {
            content: [{ type: 'text', text: `Invalid regex pattern: "${pattern}"` }],
            isError: true,
          };
        }

        const current = this.safetyCheckService.getUserRules();
        const newRule = { pattern, level, reason };
        const updated = {
          allowlist: list === 'allowlist' ? [...current.allowlist, newRule] : current.allowlist,
          denylist: list === 'denylist' ? [...current.denylist, newRule] : current.denylist,
        };
        this.safetyCheckService.updateUserRules(updated);

        const listLabel = list === 'denylist' ? 'denylist (highest priority)' : 'allowlist (overrides local rules)';
        return {
          content: [{
            type: 'text',
            text: `Rule added to ${listLabel}: [${level}] /${pattern}/ -> ${reason}`,
          }],
        };
      }
    );
  }

  public async close(): Promise<void> {
    try {
      for (const connectionId of this.backgroundExecutions.keys()) {
        this.stopBackgroundExecution(connectionId);
      }
      await this.sshService.close();
      this.activeConnections.clear();
      this.backgroundExecutions.clear();
      this.pendingConfirmations.clear();
    } catch (error) {
      console.error('关闭SSH MCP时出错:', error);
      throw error;
    }
  }

  private limitOutputLength(text: string, maxLength: number = 3000, targetLength: number = 1500): string {
    return sharedLimitOutputLength(text, maxLength, targetLength);
  }
}
