import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { z } from 'zod';

import { errorResponse, eventServer, requireConnectedConnection, textResponse } from './ssh-helpers.js';
import type { FileTransferInfo } from './ssh-service.js';
import type { FileToolsContext } from './ssh-types.js';

export function registerFileTransferBatchTools(context: FileToolsContext): void {
  context.server.tool(
    'batchUploadFiles',
    'Uploads multiple local files to a remote server.',
    {
      connectionId: z.string(),
      files: z.array(z.object({ localPath: z.string(), remotePath: z.string() })),
      confirmation: z.string().optional().describe('Confirmation string required for risky transfers'),
    },
    async ({ connectionId, files, confirmation }) => {
      try {
        const required = requireConnectedConnection(context.sshService, connectionId);
        if ('response' in required) {
          return required.response;
        }

        const missingFiles = files.filter((file) => !fs.existsSync(file.localPath));
        if (missingFiles.length > 0) {
          return errorResponse(`错误: 以下本地文件不存在:\n${missingFiles.map((file) => file.localPath).join('\n')}`);
        }

        context.activeConnections.set(connectionId, new Date());

        const operationSummary = `batch upload ${files.length} local files to remote destinations: ${files.map((file) => `${file.localPath} -> ${file.remotePath}`).join('; ')}`;
        const policyAssessment = await context.assessOperationPolicy({
          connectionId,
          command: operationSummary,
          confirmation,
          operationType: 'batch_file_upload',
          operationSummary,
        });

        if (policyAssessment.response) {
          return policyAssessment.response;
        }

        const transferIds = await context.sshService.batchTransfer({
          connectionId,
          items: files,
          direction: 'upload',
        });

        if (transferIds.length === 0) {
          return errorResponse('没有文件被上传');
        }

        const listeners = attachBatchProgressListeners(context, transferIds, 'upload');
        try {
          await waitForTransfers(context, transferIds);
          const finalTransferInfos = transferIds
            .map((id) => context.sshService.getTransferInfo(id))
            .filter(Boolean) as FileTransferInfo[];

          return textResponse(
            `批量上传完成\n成功: ${finalTransferInfos.filter((info) => info.status === 'completed').length}个文件\n失败: ${finalTransferInfos.filter((info) => info.status === 'failed').length}个文件`,
            { transferIds },
          );
        } finally {
          listeners.forEach((unsubscribe) => unsubscribe());
        }
      } catch (error) {
        return errorResponse(`批量上传文件时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  context.server.tool(
    'batchDownloadFiles',
    'Downloads multiple files from a remote server.',
    {
      connectionId: z.string(),
      files: z.array(z.object({ remotePath: z.string(), localPath: z.string().optional() })),
      confirmation: z.string().optional().describe('Confirmation string required for risky transfers'),
    },
    async ({ connectionId, files, confirmation }) => {
      try {
        const required = requireConnectedConnection(context.sshService, connectionId);
        if ('response' in required) {
          return required.response;
        }

        const normalizedFiles = normalizeDownloadFiles(files);
        if (normalizedFiles.length === 0) {
          return errorResponse('错误: 没有有效的文件传输项');
        }

        context.activeConnections.set(connectionId, new Date());

        const operationSummary = `batch download ${normalizedFiles.length} remote files to local destinations: ${normalizedFiles.map((file) => `${file.remotePath} -> ${file.localPath}`).join('; ')}`;
        const policyAssessment = await context.assessOperationPolicy({
          connectionId,
          command: operationSummary,
          confirmation,
          operationType: 'batch_file_download',
          operationSummary,
        });

        if (policyAssessment.response) {
          return policyAssessment.response;
        }

        const transferIds = await context.sshService.batchTransfer({
          connectionId,
          items: normalizedFiles,
          direction: 'download',
        });

        if (transferIds.length === 0) {
          return errorResponse('没有文件被下载');
        }

        const listeners = attachBatchProgressListeners(context, transferIds, 'download');
        try {
          await waitForTransfers(context, transferIds);
          const finalTransferInfos = transferIds
            .map((id) => context.sshService.getTransferInfo(id))
            .filter(Boolean) as FileTransferInfo[];

          return textResponse(
            `批量下载完成\n成功: ${finalTransferInfos.filter((info) => info.status === 'completed').length}个文件\n失败: ${finalTransferInfos.filter((info) => info.status === 'failed').length}个文件`,
            { transferIds },
          );
        } finally {
          listeners.forEach((unsubscribe) => unsubscribe());
        }
      } catch (error) {
        return errorResponse(`批量下载文件时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}

function attachBatchProgressListeners(context: FileToolsContext, transferIds: string[], direction: 'upload' | 'download'): Array<() => void> {
  const events = eventServer(context.server);

  return transferIds.map((transferId) => context.sshService.onTransferProgress((info: FileTransferInfo) => {
    if (info.id === transferId && (info.progress % 10 === 0 || info.status === 'completed' || info.status === 'failed')) {
      events.sendEvent('batch_transfer_progress', {
        transferId: info.id,
        progress: Math.round(info.progress),
        status: info.status,
        direction,
        human: `批量${direction === 'upload' ? '上传' : '下载'} - 文件: ${path.basename(direction === 'upload' ? info.localPath : info.remotePath)} - ${info.status}: ${Math.round(info.progress)}%`,
      });
    }
  }));
}

function waitForTransfers(context: FileToolsContext, transferIds: string[]): Promise<void> {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const allDone = transferIds.every((id) => {
        const info = context.sshService.getTransferInfo(id);
        return info && (info.status === 'completed' || info.status === 'failed');
      });

      if (allDone) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 500);
  });
}

function normalizeDownloadFiles(files: Array<{ remotePath: string; localPath?: string }>): Array<{ remotePath: string; localPath: string }> {
  return files
    .map((file) => {
      if (!file.remotePath) {
        return null;
      }

      if (file.localPath) {
        return { remotePath: file.remotePath, localPath: file.localPath };
      }

      const localPath = path.join(os.homedir(), 'Downloads', path.basename(file.remotePath));
      const saveDir = path.dirname(localPath);
      if (!fs.existsSync(saveDir)) {
        fs.mkdirSync(saveDir, { recursive: true });
      }

      return { remotePath: file.remotePath, localPath };
    })
    .filter((item): item is { remotePath: string; localPath: string } => item !== null);
}
