import * as path from 'path';

import { z } from 'zod';

import { errorResponse, textResponse } from './ssh-helpers.js';
import type { FileToolsContext } from './ssh-types.js';

export function registerFileTransferQueryTools(context: FileToolsContext): void {
  context.server.tool('getFileTransferStatus', 'Gets the status of a specific file transfer.', { transferId: z.string() }, async ({ transferId }) => {
    try {
      const transfer = context.sshService.getTransferInfo(transferId);
      if (!transfer) {
        return errorResponse(`错误: 传输 ${transferId} 不存在`);
      }

      const statusText = transfer.status === 'pending'
        ? '等待中'
        : transfer.status === 'in-progress'
          ? '传输中'
          : transfer.status === 'completed'
            ? '已完成'
            : transfer.status === 'failed'
              ? '失败'
              : transfer.status;
      const fileName = transfer.direction === 'upload' ? path.basename(transfer.localPath) : path.basename(transfer.remotePath);
      const directionText = transfer.direction === 'upload' ? '上传' : '下载';

      let output = `文件 ${directionText} 状态:\n`;
      output += `ID: ${transfer.id}\n`;
      output += `文件名: ${fileName}\n`;
      output += `状态: ${statusText}\n`;
      output += `进度: ${Math.round(transfer.progress)}%\n`;
      output += `大小: ${context.formatFileSize(transfer.size)}\n`;
      output += `已传输: ${context.formatFileSize(transfer.bytesTransferred)}\n`;

      if (transfer.startTime) {
        output += `开始时间: ${transfer.startTime.toLocaleString()}\n`;
      }

      if (transfer.endTime) {
        output += `结束时间: ${transfer.endTime.toLocaleString()}\n`;
        const duration = (transfer.endTime.getTime() - transfer.startTime.getTime()) / 1000;
        if (duration > 0) {
          output += `平均速度: ${context.formatFileSize(transfer.bytesTransferred / duration)}/s\n`;
        }
      }

      if (transfer.error) {
        output += `错误: ${transfer.error}\n`;
      }

      return textResponse(output, { transfer });
    } catch (error) {
      return errorResponse(`获取文件传输状态时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  context.server.tool('listFileTransfers', 'Lists all recent file transfers.', {}, async () => {
    try {
      const transfers = context.sshService.getAllTransfers();
      if (transfers.length === 0) {
        return textResponse('没有文件传输记录');
      }

      let output = `文件传输记录 (${transfers.length}):\n\n`;
      for (const transfer of transfers) {
        const fileName = transfer.direction === 'upload' ? path.basename(transfer.localPath) : path.basename(transfer.remotePath);
        const status = transfer.status === 'pending'
          ? '⏳ 等待中'
          : transfer.status === 'in-progress'
            ? '🔄 传输中'
            : transfer.status === 'completed'
              ? '✅ 已完成'
              : transfer.status === 'failed'
                ? '❌ 失败'
                : transfer.status;

        output += `${status} ${transfer.direction === 'upload' ? '⬆️' : '⬇️'} ${fileName}\n`;
        output += `ID: ${transfer.id}\n`;
        output += `进度: ${Math.round(transfer.progress)}% (${context.formatFileSize(transfer.bytesTransferred)}/${context.formatFileSize(transfer.size)})\n`;

        if (transfer.startTime) {
          output += `开始: ${transfer.startTime.toLocaleString()}\n`;
        }

        if (transfer.endTime) {
          output += `结束: ${transfer.endTime.toLocaleString()}\n`;
        }

        if (transfer.error) {
          output += `错误: ${transfer.error}\n`;
        }

        output += '\n';
      }

      return textResponse(output, { transfers });
    } catch (error) {
      return errorResponse(`获取文件传输列表时出错: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
