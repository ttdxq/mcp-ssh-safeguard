import { z } from 'zod';

import { errorResponse, requireConnectedConnection, requireExistingConnection, textResponse } from './ssh-helpers.js';
import { executeCommandTool } from './ssh-command-execution.js';
import type { CommandToolsContext } from './ssh-types.js';

export function registerCommandTools(context: CommandToolsContext): void {
  context.server.tool(
    'executeCommand',
    'IMPORTANT: Before executing any command, ALWAYS use \'listConnections\' first to verify the connection exists and get the correct connectionId. If you\'re unsure about the connection state, use \'getConnection\' to check details. Executes a command on a remote server via SSH. All commands go through mandatory safety checks.',
    {
      connectionId: z.string().describe("The connection ID. Use 'listConnections' to find available connections before executing commands."),
      command: z.string().describe('The command to execute on the remote server'),
      cwd: z.string().optional().describe('Working directory for command execution'),
      timeout: z.number().optional().describe('Command execution timeout in milliseconds'),
      confirmation: z.string().optional().describe('Confirmation string (required when prompted by safety check)'),
    },
    (params) => executeCommandTool(context, params),
  );

  context.server.tool(
    'backgroundExecute',
    'Executes a command in the background on a remote server at a specified interval.',
    {
      connectionId: z.string(),
      command: z.string(),
      interval: z.number().optional(),
      cwd: z.string().optional(),
      confirmation: z.string().optional().describe('Confirmation string required for commands that need explicit approval'),
    },
    async ({ connectionId, command, interval = 10000, cwd, confirmation }) => {
      try {
        const required = requireConnectedConnection(context.sshService, connectionId);
        if ('response' in required) {
          return required.response;
        }

        const { connection } = required;
        if (context.backgroundExecutions.has(connectionId)) {
          context.stopBackgroundExecution(connectionId);
        }

        context.activeConnections.set(connectionId, new Date());

        const policyAssessment = await context.assessOperationPolicy({
          connectionId,
          command,
          confirmation,
          operationType: 'background_command',
        });

        if (policyAssessment.response) {
          return policyAssessment.response;
        }

        if (!policyAssessment.allowed) {
          return errorResponse('安全策略未允许后台执行该命令。');
        }

        await context.sshService.executeCommand(connectionId, command, { cwd });

        const timer = setInterval(async () => {
          try {
            const currentConnection = context.sshService.getConnection(connectionId);
            if (currentConnection && currentConnection.status === 'connected') {
              await context.sshService.executeCommand(connectionId, command, { cwd });
              const backgroundExecution = context.backgroundExecutions.get(connectionId);
              if (backgroundExecution) {
                backgroundExecution.lastCheck = new Date();
              }
            } else {
              context.stopBackgroundExecution(connectionId);
            }
          } catch (error) {
            console.error('后台执行命令出错:', error);
          }
        }, interval);

        context.backgroundExecutions.set(connectionId, {
          interval: timer,
          lastCheck: new Date(),
        });

        return textResponse(
          `已在后台启动命令: ${command}\n间隔: ${interval / 1000}秒\n连接: ${connection.name || connectionId}\n\n使用 stopBackground 工具可停止此后台任务。`,
        );
      } catch (error) {
        return errorResponse(`设置后台任务时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  context.server.tool('stopBackground', 'Stops a background command execution on a specific connection.', { connectionId: z.string() }, ({ connectionId }) => {
    try {
      const existing = requireExistingConnection(context.sshService, connectionId);
      if ('response' in existing) {
        return existing.response;
      }

      if (!context.backgroundExecutions.has(connectionId)) {
        return textResponse(`连接 ${existing.connection.name || connectionId} 没有正在运行的后台任务`);
      }

      context.stopBackgroundExecution(connectionId);
      return textResponse(`已停止连接 ${existing.connection.name || connectionId} 的后台任务`);
    } catch (error) {
      return errorResponse(`停止后台任务时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  context.server.tool('getCurrentDirectory', 'Gets the current working directory of an SSH connection.', { connectionId: z.string() }, async ({ connectionId }) => {
    try {
      const required = requireConnectedConnection(context.sshService, connectionId);
      if ('response' in required) {
        return required.response;
      }

      context.activeConnections.set(connectionId, new Date());
      const result = await context.sshService.executeCommand(connectionId, 'pwd');
      return textResponse(result.stdout.trim());
    } catch (error) {
      return errorResponse(`获取当前目录时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
