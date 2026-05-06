import { z } from 'zod';

import { errorResponse, requireConnectedConnection, textResponse } from './ssh-helpers.js';
import type { TunnelToolsContext } from './ssh-types.js';

export function registerTunnelTools(context: TunnelToolsContext): void {
  context.server.tool(
    'createTunnel',
    'Creates an SSH tunnel (port forwarding).',
    {
      connectionId: z.string(),
      localPort: z.number(),
      remoteHost: z.string(),
      remotePort: z.number(),
      description: z.string().optional(),
      confirmation: z.string().optional().describe('Confirmation string required for tunnel creation approval'),
    },
    async ({ connectionId, localPort, remoteHost, remotePort, description, confirmation }) => {
      try {
        const required = requireConnectedConnection(context.sshService, connectionId);
        if ('response' in required) {
          return required.response;
        }

        const operationSummary = `create SSH tunnel from local port ${localPort} to ${remoteHost}:${remotePort}${description ? ` (${description})` : ''}`;
        const policyAssessment = await context.assessOperationPolicy({
          connectionId,
          command: operationSummary,
          confirmation,
          operationType: 'tunnel_create',
          operationSummary,
        });

        if (policyAssessment.response) {
          return policyAssessment.response;
        }

        const tunnelId = await context.sshService.createTunnel({
          connectionId,
          localPort,
          remoteHost,
          remotePort,
          description,
        });

        return textResponse(`隧道已创建\n本地端口: ${localPort}\n远程: ${remoteHost}:${remotePort}\n隧道ID: ${tunnelId}`, { tunnelId });
      } catch (error) {
        return errorResponse(`创建隧道时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  context.server.tool('closeTunnel', 'Closes an active SSH tunnel.', { tunnelId: z.string() }, async ({ tunnelId }) => {
    try {
      const success = await context.sshService.closeTunnel(tunnelId);
      return success ? textResponse(`隧道 ${tunnelId} 已关闭`) : errorResponse(`关闭隧道 ${tunnelId} 失败`);
    } catch (error) {
      return errorResponse(`关闭隧道时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  context.server.tool('listTunnels', 'Lists all active SSH tunnels.', {}, () => {
    try {
      const tunnels = context.sshService.getTunnels();
      if (tunnels.length === 0) {
        return textResponse('当前没有活跃的隧道');
      }

      let output = '活跃的隧道:\n\n';
      for (const tunnel of tunnels) {
        const connection = context.sshService.getConnection(tunnel.connectionId);
        output += `ID: ${tunnel.id}\n`;
        output += `本地端口: ${tunnel.localPort}\n`;
        output += `远程: ${tunnel.remoteHost}:${tunnel.remotePort}\n`;
        if (connection) {
          output += `连接: ${connection.name || connection.id} (${connection.config.host})\n`;
        }
        if (tunnel.description) {
          output += `描述: ${tunnel.description}\n`;
        }
        output += '\n---\n\n';
      }

      return textResponse(output, { tunnels });
    } catch (error) {
      return errorResponse(`获取隧道列表时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
