import * as fs from 'fs';
import * as os from 'os';

import { z } from 'zod';

import { loadConfig } from '../services/runtime-config.js';
import type { SSHConnectionConfig } from './ssh-service.js';
import { errorResponse, requireExistingConnection, textResponse } from './ssh-helpers.js';
import type { ConnectionToolsContext } from './ssh-types.js';

export function registerConnectionTools(context: ConnectionToolsContext): void {
  const {
    server,
    sshService,
    activeConnections,
    backgroundExecutions,
    formatConnectionInfo,
    formatConnectionPoolInfo,
    stopBackgroundExecution,
  } = context;

  server.tool(
    'connect',
    'Establishes a new SSH connection to a server.',
    {
      host: z.string(),
      port: z.number().optional(),
      username: z.string(),
      password: z.string().optional(),
      privateKey: z.string().optional(),
      passphrase: z.string().optional(),
      name: z.string().optional(),
      rememberPassword: z.boolean().optional().default(true),
      tags: z.array(z.string()).optional(),
    },
    async (params) => {
      try {
        const config: SSHConnectionConfig = {
          host: params.host,
          port: params.port || loadConfig().DEFAULT_SSH_PORT,
          username: params.username,
          password: params.password,
          keepaliveInterval: 60000,
          readyTimeout: loadConfig().CONNECTION_TIMEOUT,
          reconnect: true,
          reconnectTries: loadConfig().RECONNECT_ATTEMPTS,
          reconnectDelay: 5000,
        };

        if (params.privateKey) {
          if (params.privateKey.trim().startsWith('-----BEGIN')) {
            config.privateKey = params.privateKey;
          } else {
            let keyPath = params.privateKey;
            if (keyPath.startsWith('~')) {
              keyPath = keyPath.replace(/^~/, os.homedir());
            }

            if (!fs.existsSync(keyPath)) {
              return errorResponse(`连接失败: 私钥文件不存在: ${keyPath}`);
            }

            config.privateKey = fs.readFileSync(keyPath, 'utf8');
          }

          config.passphrase = params.passphrase;
        }

        const connection = await sshService.connect(
          config,
          params.name,
          params.rememberPassword,
          params.tags,
        );

        activeConnections.set(connection.id, new Date());

        const credentialNotice = params.rememberPassword && !sshService.canPersistCredentials()
          ? '\n\n提示: 当前在 Docker 模式下运行，默认不会持久化保存密码。如需恢复旧行为，请设置 ALLOW_INSECURE_DOCKER_CREDENTIALS=true。'
          : '';

        return textResponse(`连接成功!\n\n${formatConnectionInfo(connection)}${credentialNotice}`);
      } catch (error) {
        return errorResponse(`连接失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'disconnect',
    'Disconnects an active SSH connection.',
    {
      connectionId: z.string(),
      disconnectAll: z.boolean().optional().default(false),
    },
    async ({ connectionId, disconnectAll }) => {
      try {
        const existing = requireExistingConnection(sshService, connectionId);
        if ('response' in existing) {
          return existing.response;
        }

        const { connection } = existing;
        if (backgroundExecutions.has(connectionId)) {
          stopBackgroundExecution(connectionId);
        }

        const success = await sshService.disconnect(connectionId, disconnectAll);
        activeConnections.delete(connectionId);

        if (!success) {
          return errorResponse('断开连接失败');
        }

        return textResponse(
          disconnectAll
            ? `已成功断开连接到 ${connection.config.host} 的所有会话`
            : `已成功断开连接 ${connection.name || connectionId}`,
        );
      } catch (error) {
        return errorResponse(`断开连接时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool('listConnections', 'Lists all saved SSH connections.', {}, async () => {
    try {
      const connections = await sshService.getAllConnections();
      if (connections.length === 0) {
        return textResponse('当前没有保存的连接');
      }

      return textResponse(`已保存的连接:\n\n${connections.map((connection) => formatConnectionInfo(connection)).join('\n---\n')}`);
    } catch (error) {
      return errorResponse(`获取连接列表出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.tool('listConnectionPools', 'Lists all SSH connection pools and their status.', {}, async () => {
    try {
      return textResponse(formatConnectionPoolInfo());
    } catch (error) {
      return errorResponse(`获取连接池状态出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.tool(
    'getConnection',
    'Gets detailed information about a specific SSH connection.',
    { connectionId: z.string() },
    ({ connectionId }) => {
      try {
        const existing = requireExistingConnection(sshService, connectionId);
        if ('response' in existing) {
          return existing.response;
        }

        return textResponse(formatConnectionInfo(existing.connection, true));
      } catch (error) {
        return errorResponse(`获取连接详情出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.tool(
    'deleteConnection',
    'Deletes a saved SSH connection.',
    { connectionId: z.string() },
    async ({ connectionId }) => {
      try {
        const existing = requireExistingConnection(sshService, connectionId);
        if ('response' in existing) {
          return existing.response;
        }

        const { connection } = existing;
        if (backgroundExecutions.has(connectionId)) {
          stopBackgroundExecution(connectionId);
        }

        activeConnections.delete(connectionId);
        const success = await sshService.deleteConnection(connectionId);

        return success
          ? textResponse(`已成功删除连接 "${connection.name || connectionId}"`)
          : errorResponse('删除连接失败');
      } catch (error) {
        return errorResponse(`删除连接时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
