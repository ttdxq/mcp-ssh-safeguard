import { z } from 'zod';

import { errorResponse, textResponse } from './ssh-helpers.js';
import type { SessionToolsContext } from './ssh-types.js';

export function registerSessionTools(context: SessionToolsContext): void {
  context.server.tool('listActiveSessions', 'Lists all currently active SSH sessions.', {}, async () => {
    try {
      if (context.activeConnections.size === 0) {
        return textResponse('当前没有活跃的会话');
      }

      let output = '活跃会话:\n\n';
      for (const [connectionId, lastActive] of context.activeConnections.entries()) {
        const connection = context.sshService.getConnection(connectionId);
        if (!connection) {
          continue;
        }

        output += context.formatConnectionInfo(connection);
        output += `上次活动: ${context.formatTimeDifference(lastActive)}\n`;

        if (context.backgroundExecutions.has(connectionId)) {
          const backgroundExecution = context.backgroundExecutions.get(connectionId);
          if (backgroundExecution) {
            output += `后台任务: 活跃中，最后执行: ${context.formatTimeDifference(backgroundExecution.lastCheck)}\n`;
          }
        }

        output += '\n---\n\n';
      }

      return textResponse(output);
    } catch (error) {
      return errorResponse(`获取活跃会话时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  context.server.tool('listBackgroundTasks', 'Lists all background tasks currently running.', {}, () => {
    try {
      if (context.backgroundExecutions.size === 0) {
        return textResponse('当前没有运行中的后台任务');
      }

      let output = '运行中的后台任务:\n\n';
      for (const [connectionId, info] of context.backgroundExecutions.entries()) {
        const connection = context.sshService.getConnection(connectionId);
        if (!connection) {
          continue;
        }

        output += `连接: ${connection.name || connection.id}\n`;
        output += `主机: ${connection.config.host}\n`;
        output += `用户: ${connection.config.username}\n`;
        output += `状态: ${connection.status}\n`;
        output += `最后执行: ${context.formatTimeDifference(info.lastCheck)}\n`;
        output += '\n---\n\n';
      }

      return textResponse(output);
    } catch (error) {
      return errorResponse(`获取后台任务时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  context.server.tool('stopAllBackgroundTasks', 'Stops all running background tasks.', {}, () => {
    try {
      const count = context.backgroundExecutions.size;
      if (count === 0) {
        return textResponse('当前没有运行中的后台任务');
      }

      for (const connectionId of context.backgroundExecutions.keys()) {
        context.stopBackgroundExecution(connectionId);
      }

      return textResponse(`已停止所有 ${count} 个后台任务`);
    } catch (error) {
      return errorResponse(`停止所有后台任务时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
