import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { z } from 'zod';

import { errorResponse, eventServer, requireConnectedConnection, textResponse } from './ssh-helpers.js';
import type { FileTransferInfo } from './ssh-service.js';
import type { FileToolsContext } from './ssh-types.js';

export function registerFileTransferBasicTools(context: FileToolsContext): void {
  context.server.tool(
    'uploadFile',
    'Uploads a local file to a remote server.',
    {
      connectionId: z.string(),
      localPath: z.string(),
      remotePath: z.string(),
      confirmation: z.string().optional().describe('Confirmation string required for risky transfers'),
    },
    async ({ connectionId, localPath, remotePath, confirmation }) => {
      try {
        const required = requireConnectedConnection(context.sshService, connectionId);
        if ('response' in required) {
          return required.response;
        }

        if (!fs.existsSync(localPath)) {
          return errorResponse(`错误: 本地文件 "${localPath}" 不存在`);
        }

        context.activeConnections.set(connectionId, new Date());

        const operationSummary = `upload local file ${localPath} to remote path ${remotePath}`;
        const policyAssessment = await context.assessOperationPolicy({
          connectionId,
          command: operationSummary,
          confirmation,
          operationType: 'file_upload',
          operationSummary,
        });

        if (policyAssessment.response) {
          return policyAssessment.response;
        }

        const transferInfo = await context.sshService.uploadFile(connectionId, localPath, remotePath);
        const transferId = transferInfo.id;
        const events = eventServer(context.server);
        const unsubscribe = context.sshService.onTransferProgress((info: FileTransferInfo) => {
          if (info.progress % 5 === 0 || info.status === 'completed' || info.status === 'failed') {
            events.sendEvent('file_transfer_progress', {
              transferId: info.id,
              progress: Math.round(info.progress),
              status: info.status,
              human: `文件传输 ${info.id} - ${info.status}: ${Math.round(info.progress)}% (${context.formatFileSize(info.bytesTransferred)}/${context.formatFileSize(info.size)})`,
            });
          }
        });

        try {
          const result = context.sshService.getTransferInfo(transferId);
          if (result && result.status === 'failed') {
            return errorResponse(`文件上传失败: ${result.error || '未知错误'}`, { transferId });
          }

          return textResponse(`文件 "${path.basename(localPath)}" 上传成功\n本地路径: ${localPath}\n远程路径: ${remotePath}`, { transferId });
        } finally {
          unsubscribe();
        }
      } catch (error) {
        return errorResponse(`上传文件时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  context.server.tool(
    'downloadFile',
    'Downloads a file from a remote server to the local machine.',
    {
      connectionId: z.string(),
      remotePath: z.string(),
      localPath: z.string().optional(),
      confirmation: z.string().optional().describe('Confirmation string required for risky transfers'),
    },
    async ({ connectionId, remotePath, localPath, confirmation }) => {
      try {
        const required = requireConnectedConnection(context.sshService, connectionId);
        if ('response' in required) {
          return required.response;
        }

        const savePath = resolveDownloadPath(remotePath, localPath);
        context.activeConnections.set(connectionId, new Date());

        const operationSummary = `download remote file ${remotePath} to local path ${savePath}`;
        const policyAssessment = await context.assessOperationPolicy({
          connectionId,
          command: operationSummary,
          confirmation,
          operationType: 'file_download',
          operationSummary,
        });

        if (policyAssessment.response) {
          return policyAssessment.response;
        }

        const transferInfo = await context.sshService.downloadFile(connectionId, remotePath, savePath);
        const transferId = transferInfo.id;
        const events = eventServer(context.server);
        const unsubscribe = context.sshService.onTransferProgress((info: FileTransferInfo) => {
          if (info.progress % 5 === 0 || info.status === 'completed' || info.status === 'failed') {
            events.sendEvent('file_transfer_progress', {
              transferId: info.id,
              progress: Math.round(info.progress),
              status: info.status,
              human: `文件传输 ${info.id} - ${info.status}: ${Math.round(info.progress)}% (${context.formatFileSize(info.bytesTransferred)}/${context.formatFileSize(info.size)})`,
            });
          }
        });

        try {
          const result = context.sshService.getTransferInfo(transferId);
          if (result && result.status === 'failed') {
            return errorResponse(`文件下载失败: ${result.error || '未知错误'}`, { transferId });
          }

          return textResponse(`文件 "${path.basename(remotePath)}" 下载成功\n远程路径: ${remotePath}\n本地路径: ${savePath}`, { transferId });
        } finally {
          unsubscribe();
        }
      } catch (error) {
        return errorResponse(`下载文件时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );
}

function resolveDownloadPath(remotePath: string, localPath?: string): string {
  if (localPath) {
    return localPath;
  }

  const savePath = path.join(os.homedir(), 'Downloads', path.basename(remotePath));
  const saveDir = path.dirname(savePath);
  if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
  }
  return savePath;
}
