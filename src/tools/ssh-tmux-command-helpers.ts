import type { CommandResult, SSHService } from './ssh-service.js';
import { errorResponse } from './ssh-helpers.js';
import type { McpToolResponse } from './ssh-types.js';

const TMUX_SEND_KEYS_REGEX = /tmux\s+send-keys\s+(?:-t\s+)?["']?([^"'\s]+)["']?\s+["']?(.+?)["']?\s+(?:Enter|C-m)/i;
const TMUX_CAPTURE_REGEX = /tmux\s+capture-pane\s+(?:-t\s+)["']?([^"'\s]+)["']?/i;
const TMUX_NEW_SESSION_REGEX = /tmux\s+new-session\s+(?:-[ds]\s+)+(?:-s\s+)["']?([^"'\s]+)["']?/i;
const TMUX_KILL_SESSION_REGEX = /tmux\s+kill-session\s+(?:-t\s+)["']?([^"'\s]+)["']?/i;
const TMUX_HAS_SESSION_REGEX = /tmux\s+has-session\s+(?:-t\s+)["']?([^"'\s]+)["']?/i;
const PROMPT_REGEX = /^.*[\$#>]\s+/m;

export interface TmuxCommandState {
  isTmuxSendKeys: boolean;
  isTmuxCapture: boolean;
  isTmuxNewSession: boolean;
  isTmuxKillSession: boolean;
  isTmuxHasSession: boolean;
  isTmuxCommand: boolean;
  sessionName: string | null;
  beforeCapture?: CommandResult;
}

interface PrepareTmuxCommandParams {
  sshService: SSHService;
  connectionId: string;
  command: string;
  cwd?: string;
}

export interface PrepareTmuxCommandResult extends TmuxCommandState {
  response?: McpToolResponse;
}

interface EnhanceTmuxCommandOutputParams extends PrepareTmuxCommandParams {
  result: CommandResult;
  output: string;
  tmuxState: TmuxCommandState;
}

export async function prepareTmuxCommand(params: PrepareTmuxCommandParams): Promise<PrepareTmuxCommandResult> {
  const detection = detectTmuxCommand(params.command);

  if (!detection.isTmuxSendKeys || !detection.sessionName) {
    return detection;
  }

  const beforeCapture = await params.sshService.executeCommand(
    params.connectionId,
    `tmux capture-pane -p -t ${detection.sessionName}`,
    { cwd: params.cwd, timeout: 5000 },
  );

  try {
    const blockedResponse = await getBlockedTmuxResponse(
      params.sshService,
      params.connectionId,
      detection.sessionName,
      params.cwd,
    );

    if (blockedResponse) {
      return { ...detection, beforeCapture, response: blockedResponse };
    }
  } catch (error) {
    console.error('检查tmux会话状态时出错:', error);
  }

  return { ...detection, beforeCapture };
}

export async function enhanceTmuxCommandOutput(params: EnhanceTmuxCommandOutputParams): Promise<string> {
  const { sshService, connectionId, command, cwd, result, output, tmuxState } = params;

  if (!tmuxState.isTmuxCommand || result.code !== 0 || result.stdout || result.stderr) {
    return output;
  }

  try {
    if (tmuxState.isTmuxSendKeys && tmuxState.sessionName && tmuxState.beforeCapture?.stdout) {
      await sleep(300);

      const afterCapture = await sshService.executeCommand(
        connectionId,
        `tmux capture-pane -p -t ${tmuxState.sessionName}`,
        { cwd, timeout: 5000 },
      );

      if (afterCapture?.stdout && tmuxState.beforeCapture.stdout) {
        return buildSendKeysOutput(tmuxState.sessionName, tmuxState.beforeCapture.stdout, afterCapture.stdout);
      }
    }

    if (tmuxState.isTmuxNewSession) {
      const match = command.match(TMUX_NEW_SESSION_REGEX);
      if (match) {
        let nextOutput = `已创建新的tmux会话 "${match[1]}"`;
        const checkResult = await sshService.executeCommand(
          connectionId,
          `tmux has-session -t ${match[1]} 2>/dev/null && echo "会话存在" || echo "会话创建失败"`,
          { timeout: 3000 },
        );

        if (checkResult.stdout && checkResult.stdout.includes('会话存在')) {
          nextOutput += '\n会话已成功启动并在后台运行';
        }

        return nextOutput;
      }
    }

    if (tmuxState.isTmuxKillSession) {
      const match = command.match(TMUX_KILL_SESSION_REGEX);
      if (match) {
        return `已终止tmux会话 "${match[1]}"`;
      }
    }

    if (tmuxState.isTmuxHasSession) {
      const match = command.match(TMUX_HAS_SESSION_REGEX);
      if (match) {
        return result.code === 0
          ? `tmux会话 "${match[1]}" 存在`
          : `tmux会话 "${match[1]}" 不存在`;
      }
    }

    if (tmuxState.isTmuxCapture) {
      const match = command.match(TMUX_CAPTURE_REGEX);
      if (match) {
        return `tmux会话 "${match[1]}" 内容已捕获，但原始命令未返回输出内容`;
      }
    }

    if (command.includes('tmux') && (command.includes('&&') || command.includes(';'))) {
      return await buildCompositeTmuxOutput(sshService, connectionId, command, cwd);
    }
  } catch (error) {
    console.error('处理tmux命令输出时出错:', error);
    return `tmux命令已执行，但无法获取额外信息: ${error instanceof Error ? error.message : String(error)}`;
  }

  return output;
}

function detectTmuxCommand(command: string): TmuxCommandState {
  const sendKeysMatch = command.match(TMUX_SEND_KEYS_REGEX);
  const isTmuxSendKeys = Boolean(sendKeysMatch);
  const isTmuxCapture = TMUX_CAPTURE_REGEX.test(command);
  const isTmuxNewSession = TMUX_NEW_SESSION_REGEX.test(command);
  const isTmuxKillSession = TMUX_KILL_SESSION_REGEX.test(command);
  const isTmuxHasSession = TMUX_HAS_SESSION_REGEX.test(command);

  return {
    isTmuxSendKeys,
    isTmuxCapture,
    isTmuxNewSession,
    isTmuxKillSession,
    isTmuxHasSession,
    isTmuxCommand: isTmuxSendKeys || isTmuxCapture || isTmuxNewSession || isTmuxKillSession || isTmuxHasSession,
    sessionName: sendKeysMatch?.[1] || null,
  };
}

async function getBlockedTmuxResponse(
  sshService: SSHService,
  connectionId: string,
  sessionName: string,
  cwd?: string,
): Promise<McpToolResponse | null> {
  const checkResult = await sshService.executeCommand(
    connectionId,
    `tmux list-panes -t ${sessionName} -F "#{pane_pid} #{pane_current_command}"`,
    { cwd, timeout: 5000 },
  );

  if (!checkResult?.stdout) {
    return null;
  }

  const [panePid, currentCommand] = checkResult.stdout.trim().split(' ');
  if (!panePid) {
    return null;
  }

  const processResult = await sshService.executeCommand(connectionId, `ps -o state= -p ${panePid}`, { timeout: 3000 });
  const processState = processResult?.stdout?.trim();
  const childProcessResult = await sshService.executeCommand(connectionId, `pgrep -P ${panePid}`, { timeout: 3000 });

  const isBlocked = processState === 'D'
    || processState === 'T'
    || processState === 'W'
    || /^(vim|nano|less|more|top|htop|man)$/.test(currentCommand)
    || (childProcessResult?.stdout || '').trim() !== '';

  if (!isBlocked) {
    return null;
  }

  const processInfo = await sshService.executeCommand(
    connectionId,
    `ps -o pid,ppid,stat,time,command -p ${panePid}`,
    { timeout: 3000 },
  );

  const contextOutput = await sshService.executeCommand(
    connectionId,
    `tmux capture-pane -p -t ${sessionName} -S -10`,
    { timeout: 3000 },
  );

  return errorResponse(
    `警告: tmux会话 "${sessionName}" 当前有阻塞进程:\n\n`
    + `当前会话上下文:\n${contextOutput.stdout}\n\n`
    + `进程信息:\n${processInfo.stdout}\n\n`
    + '建议操作:\n'
    + '1. 如果是交互式程序(vim/nano等), 请先正常退出\n'
    + '2. 如果是后台任务, 可以:\n'
    + `   - 等待任务完成（执行 sleep <seconds> 命令进行等待）\n`
    + `   - 使用 Ctrl+C (tmux send-keys -t ${sessionName} C-c)\n`
    + `   - 使用 kill -TERM ${panePid} 终止进程\n\n`
    + '为避免命令冲突, 本次操作已取消。请先解决阻塞问题后再试。',
  );
}

function buildSendKeysOutput(sessionName: string, beforeText: string, afterText: string): string {
  const beforeLines = beforeText.trim().split('\n');
  const afterLines = afterText.trim().split('\n');

  let diffOutput = '';
  let commonPrefix = 0;

  while (commonPrefix < Math.min(beforeLines.length, afterLines.length) && beforeLines[commonPrefix] === afterLines[commonPrefix]) {
    commonPrefix += 1;
  }

  const newLines = afterLines.slice(commonPrefix);
  if (newLines.length > 0) {
    diffOutput = newLines.join('\n');
  }

  if (!diffOutput && afterText.length > beforeText.length) {
    diffOutput = afterText.substring(beforeText.length);
  }

  if (diffOutput && diffOutput.trim()) {
    const contextLines: string[] = [];
    let promptCount = 0;

    for (let index = Math.max(0, commonPrefix - 15); index < afterLines.length; index += 1) {
      contextLines.push(afterLines[index]);
      if (PROMPT_REGEX.test(afterLines[index])) {
        promptCount += 1;
      }
      if (promptCount >= 2 || index >= commonPrefix) {
        break;
      }
    }

    let contextOutput = contextLines.join('\n');
    if (contextOutput && !contextOutput.endsWith('\n')) {
      contextOutput += '\n';
    }

    return `命令已发送到tmux会话 "${sessionName}"，带上下文的输出:\n\n${contextOutput}${diffOutput.trim()}`;
  }

  if (beforeText !== afterText) {
    const promptPositions: number[] = [];

    for (let index = Math.max(0, afterLines.length - 30); index < afterLines.length; index += 1) {
      if (PROMPT_REGEX.test(afterLines[index])) {
        promptPositions.push(index);
      }
    }

    if (promptPositions.length > 0) {
      const startPosition = promptPositions.length > 3
        ? promptPositions[promptPositions.length - 3]
        : promptPositions[0];

      return `命令已发送到tmux会话 "${sessionName}"，最近的命令和输出:\n\n${afterLines.slice(startPosition).join('\n')}`;
    }

    return `命令已发送到tmux会话 "${sessionName}"，最近内容:\n\n${afterLines.slice(-30).join('\n')}`;
  }

  return `命令已发送到tmux会话 "${sessionName}"，但未检测到输出变化`;
}

async function buildCompositeTmuxOutput(
  sshService: SSHService,
  connectionId: string,
  command: string,
  cwd?: string,
): Promise<string> {
  const tmuxCommands = command.split(/&&|;/).map((segment) => segment.trim());
  let lastSessionName: string | null = null;

  for (const tmuxCommand of tmuxCommands) {
    let match: RegExpMatchArray | null = null;
    if ((match = tmuxCommand.match(TMUX_NEW_SESSION_REGEX))
      || (match = tmuxCommand.match(TMUX_KILL_SESSION_REGEX))
      || (match = tmuxCommand.match(TMUX_HAS_SESSION_REGEX))
      || (match = tmuxCommand.match(TMUX_SEND_KEYS_REGEX))
      || (match = tmuxCommand.match(TMUX_CAPTURE_REGEX))) {
      lastSessionName = match[1];
    }
  }

  if (!lastSessionName) {
    return '已执行tmux复合命令';
  }

  const lastCommand = tmuxCommands[tmuxCommands.length - 1];
  if (lastCommand.includes('new-session')) {
    let output = `已执行tmux复合命令，最后创建了会话 "${lastSessionName}"`;
    await sleep(500);
    const checkResult = await sshService.executeCommand(
      connectionId,
      `tmux has-session -t ${lastSessionName} 2>/dev/null && echo "会话存在" || echo "会话创建失败"`,
      { timeout: 3000 },
    );

    if (checkResult.stdout && checkResult.stdout.includes('会话存在')) {
      output += '\n会话已成功启动并在后台运行';
    }

    return output;
  }

  if (lastCommand.includes('kill-session')) {
    return `已执行tmux复合命令，最后终止了会话 "${lastSessionName}"`;
  }

  await sleep(500);

  const blockedResponse = await waitForTmuxUnblocked(sshService, connectionId, lastSessionName, cwd);
  if (blockedResponse) {
    return blockedResponse;
  }

  try {
    const captureResult = await sshService.executeCommand(
      connectionId,
      `tmux has-session -t ${lastSessionName} 2>/dev/null && tmux capture-pane -p -t ${lastSessionName} || echo "会话不存在"`,
      { cwd, timeout: 5000 },
    );

    if (captureResult.stdout && !captureResult.stdout.includes('会话不存在')) {
      const lines = captureResult.stdout.split('\n');
      return `已执行tmux复合命令，会话 "${lastSessionName}" 当前内容:\n\n${lines.slice(-40).join('\n')}`;
    }

    return `已执行tmux复合命令，但会话 "${lastSessionName}" 不存在或无法捕获内容`;
  } catch {
    return `已执行tmux复合命令，涉及会话 "${lastSessionName}"`;
  }
}

async function waitForTmuxUnblocked(
  sshService: SSHService,
  connectionId: string,
  sessionName: string,
  cwd?: string,
): Promise<string | null> {
  const waitStartTime = Date.now();
  const maxWaitTime = 10 * 60 * 1000;
  let isBlocked = true;

  while (isBlocked && Date.now() - waitStartTime < maxWaitTime) {
    try {
      const checkResult = await sshService.executeCommand(
        connectionId,
        `tmux list-panes -t ${sessionName} -F "#{pane_pid} #{pane_current_command}"`,
        { cwd, timeout: 5000 },
      );

      if (!checkResult?.stdout) {
        isBlocked = false;
        break;
      }

      const [panePid, currentCommand] = checkResult.stdout.trim().split(' ');
      if (!panePid) {
        isBlocked = false;
        break;
      }

      const processResult = await sshService.executeCommand(connectionId, `ps -o state= -p ${panePid}`, { timeout: 3000 });
      const childProcessResult = await sshService.executeCommand(connectionId, `pgrep -P ${panePid}`, { timeout: 3000 });
      const processState = processResult?.stdout?.trim();

      isBlocked = processState === 'D'
        || processState === 'T'
        || processState === 'W'
        || /^(vim|nano|less|more|top|htop|man)$/.test(currentCommand)
        || (childProcessResult?.stdout || '').trim() !== '';

      if (!isBlocked) {
        break;
      }

      await sleep(5000);
    } catch (error) {
      console.error('检查会话阻塞状态时出错:', error);
      isBlocked = false;
    }
  }

  if (!isBlocked || Date.now() - waitStartTime < maxWaitTime) {
    return null;
  }

  try {
    const processInfo = await sshService.executeCommand(
      connectionId,
      `tmux list-panes -t ${sessionName} -F "#{pane_pid}" | xargs ps -o pid,ppid,stat,time,command -p`,
      { timeout: 5000 },
    );
    const contextOutput = await sshService.executeCommand(
      connectionId,
      `tmux capture-pane -p -t ${sessionName} -S -10`,
      { timeout: 3000 },
    );

    return `已执行tmux复合命令，但会话 "${sessionName}" 仍处于阻塞状态超过10分钟:\n\n`
      + `当前会话上下文:\n${contextOutput.stdout}\n\n`
      + `进程信息:\n${processInfo.stdout}\n\n`
      + '如果是正常情况，请执行 sleep <seconds> 命令等待';
  } catch {
    return `已执行tmux复合命令，但会话 "${sessionName}" 仍处于阻塞状态超过10分钟。无法获取详细信息。`;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
