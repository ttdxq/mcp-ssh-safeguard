import { loadConfig } from '../services/runtime-config.js';
import type { SSHConnection, CommandResult } from './ssh-service.js';
import { errorResponse, requireConnectedConnection, textResponse } from './ssh-helpers.js';
import { enhanceTmuxCommandOutput, prepareTmuxCommand } from './ssh-tmux-command-helpers.js';
import type { CommandToolsContext, McpToolResponse } from './ssh-types.js';

interface ExecuteCommandParams {
  connectionId: string;
  command: string;
  cwd?: string;
  timeout?: number;
  confirmation?: string;
}

export async function executeCommandTool(context: CommandToolsContext, params: ExecuteCommandParams): Promise<McpToolResponse> {
  try {
    const required = requireConnectedConnection(context.sshService, params.connectionId);
    if ('response' in required) {
      return required.response;
    }

    const connection = required.connection;
    context.activeConnections.set(params.connectionId, new Date());

    const policyAssessment = await context.assessOperationPolicy({
      connectionId: params.connectionId,
      command: params.command,
      confirmation: params.confirmation,
      operationType: 'command',
    });

    if (policyAssessment.response) {
      return policyAssessment.response;
    }

    if (!policyAssessment.allowed) {
      return errorResponse('安全检查未通过，无法执行指令。');
    }

    const tmuxState = await prepareTmuxCommand({
      sshService: context.sshService,
      connectionId: params.connectionId,
      command: params.command,
      cwd: params.cwd,
    });

    if (tmuxState.response) {
      return tmuxState.response;
    }

    const result = await context.sshService.executeCommand(
      params.connectionId,
      params.command,
      { cwd: params.cwd, timeout: params.timeout },
    );

    let output = buildCommandOutput(connection, result);
    output = await enhanceTmuxCommandOutput({
      sshService: context.sshService,
      connectionId: params.connectionId,
      command: params.command,
      cwd: params.cwd,
      result,
      output,
      tmuxState,
    });

    const maxLength = loadConfig().MAX_OUTPUT_LENGTH;
    if (output.length > maxLength) {
      const cacheId = context.outputCacheService.cacheOutput(params.command, output, params.connectionId);
      const lastLines = context.outputCacheService.getLastLines(cacheId, 100);

      return textResponse(
        `输出内容过长 (${output.length} 字符)，已缓存。\n\n最后100行:\n${lastLines}\n\n缓存ID: ${cacheId}\n\n请选择操作:\n1. 查看完整输出: getCachedOutput "${cacheId}" "full"\n2. 查看最后N行: getCachedOutput "${cacheId}" "last" 200\n3. 保存到文件: getCachedOutput "${cacheId}" "save" "/path/to/file"`,
      );
    }

    return textResponse(output || '命令执行成功，无输出');
  } catch (error) {
    return errorResponse(`执行命令时出错: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildCommandOutput(connection: SSHConnection, result: CommandResult): string {
  let output = '';

  if (result.stdout) {
    output += result.stdout;
  }

  if (result.stderr) {
    if (output) {
      output += '\n';
    }
    output += `错误输出:\n${result.stderr}`;
  }

  if (result.code !== 0) {
    output += `\n命令退出码: ${result.code}`;
  }

  if (output) {
    output += '\n';
  }

  return `${output}\n[${connection.config.username}@${connection.config.host} ${connection.currentDirectory || '~'}]$ `;
}
