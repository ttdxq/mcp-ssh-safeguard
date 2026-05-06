import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConnectionStatus, type SSHConnection, type SSHService } from './ssh-service.js';
import type { BackgroundExecutionState, McpToolResponse } from './ssh-types.js';

interface FormatConnectionInfoOptions {
  includePassword?: boolean;
  activeConnections: Map<string, Date>;
  backgroundExecutions: Map<string, BackgroundExecutionState>;
}

export interface EventCapableServer {
  sendEvent(event: string, payload: Record<string, unknown>): void;
}

export function textResponse(text: string, extra: Record<string, unknown> = {}): McpToolResponse {
  return {
    content: [{ type: 'text', text }],
    ...extra,
  };
}

export function errorResponse(text: string, extra: Record<string, unknown> = {}): McpToolResponse {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    ...extra,
  };
}

export function eventServer(server: McpServer): EventCapableServer {
  return server as unknown as EventCapableServer;
}

export function requireExistingConnection(sshService: SSHService, connectionId: string): { connection: SSHConnection } | { response: McpToolResponse } {
  const connection = sshService.getConnection(connectionId);

  if (!connection) {
    return { response: errorResponse(`错误: 连接 ${connectionId} 不存在`) };
  }

  return { connection };
}

export function requireConnectedConnection(sshService: SSHService, connectionId: string): { connection: SSHConnection } | { response: McpToolResponse } {
  const existing = requireExistingConnection(sshService, connectionId);
  if ('response' in existing) {
    return existing;
  }

  if (existing.connection.status !== ConnectionStatus.CONNECTED) {
    return {
      response: errorResponse(`错误: 连接 ${existing.connection.name || connectionId} 未连接`),
    };
  }

  return existing;
}

export function formatConnectionInfo(connection: SSHConnection, options: FormatConnectionInfoOptions): string {
  const { includePassword = false, activeConnections, backgroundExecutions } = options;

  const statusEmoji = {
    [ConnectionStatus.CONNECTED]: '🟢',
    [ConnectionStatus.CONNECTING]: '🟡',
    [ConnectionStatus.DISCONNECTED]: '⚪',
    [ConnectionStatus.RECONNECTING]: '🟠',
    [ConnectionStatus.ERROR]: '🔴',
  };

  const statusText = {
    [ConnectionStatus.CONNECTED]: '已连接',
    [ConnectionStatus.CONNECTING]: '连接中',
    [ConnectionStatus.DISCONNECTED]: '已断开',
    [ConnectionStatus.RECONNECTING]: '重连中',
    [ConnectionStatus.ERROR]: '错误',
  };

  let info = `${statusEmoji[connection.status]} ${connection.name || connection.id}\n`;
  info += `ID: ${connection.id}\n`;
  info += `主机: ${connection.config.host}:${connection.config.port || 22}\n`;
  info += `用户名: ${connection.config.username}\n`;

  if (includePassword && connection.config.password) {
    info += `密码: ${'*'.repeat(connection.config.password.length)}\n`;
  }

  if (connection.config.privateKey) {
    info += '私钥认证: 是\n';
  }

  info += `状态: ${statusText[connection.status]}\n`;

  if (connection.lastError) {
    info += `最近错误: ${connection.lastError}\n`;
  }

  if (connection.lastUsed) {
    info += `最后使用: ${connection.lastUsed.toLocaleString()}\n`;
  }

  if (connection.currentDirectory) {
    info += `当前目录: ${connection.currentDirectory}\n`;
  }

  if (connection.tags && connection.tags.length > 0) {
    info += `标签: ${connection.tags.join(', ')}\n`;
  }

  if (connection.poolKey) {
    info += `连接池: ${connection.poolKey}\n`;
  }

  if (connection.createdAt) {
    info += `创建时间: ${connection.createdAt.toLocaleString()}\n`;
  }

  if (activeConnections.has(connection.id)) {
    const lastActive = activeConnections.get(connection.id);
    if (lastActive) {
      info += `活跃度: ${formatTimeDifference(lastActive)}\n`;
    }
  }

  if (backgroundExecutions.has(connection.id)) {
    info += '后台任务: 活跃中\n';
  }

  return info;
}

export function formatConnectionPoolInfo(sshService: SSHService, activeConnections: Map<string, Date>): string {
  const pools = sshService.getConnectionPools();
  if (pools.size === 0) {
    return '当前没有连接池';
  }

  let output = '连接池状态:\n\n';
  for (const [poolKey, connections] of pools.entries()) {
    const connectedConnections = connections.filter((connection) => connection.status === ConnectionStatus.CONNECTED);

    output += `📦 池: ${poolKey}\n`;
    output += `   总连接数: ${connections.length}\n`;
    output += `   活跃连接: ${connectedConnections.length}\n`;
    output += '   连接详情:\n';

    connections.forEach((connection, index) => {
      const statusEmoji = {
        [ConnectionStatus.CONNECTED]: '🟢',
        [ConnectionStatus.CONNECTING]: '🟡',
        [ConnectionStatus.DISCONNECTED]: '⚪',
        [ConnectionStatus.RECONNECTING]: '🟠',
        [ConnectionStatus.ERROR]: '🔴',
      };

      const statusText = {
        [ConnectionStatus.CONNECTED]: '已连接',
        [ConnectionStatus.CONNECTING]: '连接中',
        [ConnectionStatus.DISCONNECTED]: '已断开',
        [ConnectionStatus.RECONNECTING]: '重连中',
        [ConnectionStatus.ERROR]: '错误',
      };

      output += `   ${index + 1}. ${statusEmoji[connection.status]} ID: ${connection.id.substring(0, 8)}... | 状态: ${statusText[connection.status]}\n`;
      if (connection.createdAt) {
        output += `      创建时间: ${connection.createdAt.toLocaleString()}\n`;
      }
      if (activeConnections.has(connection.id)) {
        output += `      最后活跃: ${formatTimeDifference(activeConnections.get(connection.id)!)}\n`;
      }
    });

    output += '\n';
  }

  return output;
}

export function formatTimeDifference(date: Date): string {
  const diffMs = Date.now() - date.getTime();

  if (diffMs < 60_000) {
    return '刚刚活跃';
  }

  if (diffMs < 3_600_000) {
    return `${Math.floor(diffMs / 60_000)}分钟前活跃`;
  }

  if (diffMs < 86_400_000) {
    return `${Math.floor(diffMs / 3_600_000)}小时前活跃`;
  }

  return `${Math.floor(diffMs / 86_400_000)}天前活跃`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function limitOutputLength(text: string, maxLength: number = 3000, targetLength: number = 1500): string {
  if (text.length <= maxLength) {
    return text;
  }

  const halfTargetLength = Math.floor(targetLength / 2);
  const prefix = text.substring(0, halfTargetLength);
  const suffix = text.substring(text.length - halfTargetLength);
  const omittedLength = text.length - targetLength;
  const omittedMessage = `\n\n... 已省略 ${omittedLength} 个字符 ...\n`
    + '如需查看完整输出，可添加以下参数：\n'
    + '- 使用 > output.txt 将输出保存到文件\n'
    + '- 使用 | head -n 数字 查看前几行\n'
    + '- 使用 | tail -n 数字 查看后几行\n'
    + '- 使用 | grep "关键词" 过滤包含特定内容的行\n\n';

  return prefix + omittedMessage + suffix;
}
