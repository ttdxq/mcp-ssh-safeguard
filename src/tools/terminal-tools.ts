import { z } from 'zod';

import { errorResponse, eventServer, textResponse } from './ssh-helpers.js';
import type { TerminalToolsContext } from './ssh-types.js';

export function registerTerminalTools(context: TerminalToolsContext): void {
  context.server.tool(
    'mcp_ssh_mcp_createTerminalSession',
    'Creates a new interactive terminal session.',
    {
      connectionId: z.string(),
      rows: z.number().optional(),
      cols: z.number().optional(),
      term: z.string().optional(),
    },
    async ({ connectionId, rows, cols, term }) => {
      try {
        const sessionId = await context.sshService.createTerminalSession(connectionId, { rows, cols, term });
        const events = eventServer(context.server);

        const unsubscribeData = context.sshService.onTerminalData((event) => {
          if (event.sessionId === sessionId) {
            const limitedData = context.limitOutputLength(event.data);
            events.sendEvent('terminal_data', {
              sessionId: event.sessionId,
              data: limitedData,
              human: limitedData,
            });
          }
        });

        const unsubscribeClose = context.sshService.onTerminalClose((event) => {
          if (event.sessionId === sessionId) {
            unsubscribeData();
            unsubscribeClose();
            events.sendEvent('terminal_closed', {
              sessionId: event.sessionId,
              human: `终端会话 ${sessionId} 已关闭`,
            });
          }
        });

        return textResponse(`已创建终端会话 ${sessionId}`, { sessionId });
      } catch (error) {
        console.error('创建终端会话失败:', error);
        return errorResponse(`创建终端会话失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  context.server.tool(
    'mcp_ssh_mcp_writeToTerminal',
    'Writes data to an interactive terminal session.',
    {
      sessionId: z.string(),
      data: z.string(),
      confirmation: z.string().optional().describe('Confirmation string required for risky terminal writes'),
    },
    async ({ sessionId, data, confirmation }) => {
      try {
        const operationSummary = `write terminal input to session ${sessionId}: ${data}`;
        const policyAssessment = await context.assessOperationPolicy({
          connectionId: `terminal:${sessionId}`,
          command: operationSummary,
          confirmation,
          operationType: 'terminal_write',
          operationSummary,
        });

        if (policyAssessment.response) {
          return policyAssessment.response;
        }

        const success = await context.sshService.writeToTerminal(sessionId, data);
        return textResponse(success ? `数据已发送到终端 ${sessionId}` : '数据发送失败', { success });
      } catch (error) {
        return errorResponse(`向终端写入数据时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}
