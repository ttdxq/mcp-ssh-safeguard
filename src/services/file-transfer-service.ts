import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

import {
  ConnectionStatus,
  type BatchTransferConfig,
  type FileTransferInfo,
  type SSHConnection,
} from './ssh-service-types.js';

type GetConnectionFn = (connectionId: string) => SSHConnection | undefined;

export class FileTransferService {
  private static readonly MAX_FILE_TRANSFER_HISTORY = 200;

  private readonly fileTransfers: Map<string, FileTransferInfo> = new Map();
  private readonly eventEmitter: EventEmitter = new EventEmitter();

  constructor(private readonly getConnectionFn: GetConnectionFn) {}

  public async uploadFile(connectionId: string, localPath: string, remotePath: string): Promise<FileTransferInfo> {
    const connection = this.getConnectedConnection(connectionId);
    const client = connection.client;
    if (!client) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    const transferId = crypto
      .createHash('md5')
      .update(`upload:${connectionId}:${localPath}:${remotePath}:${Date.now()}`)
      .digest('hex');

    try {
      const stats = fs.statSync(localPath);
      if (!stats.isFile()) {
        throw new Error(`本地路径 ${localPath} 不是一个文件`);
      }

      const transferInfo: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'upload',
        status: 'pending',
        progress: 0,
        size: stats.size,
        bytesTransferred: 0,
        startTime: new Date()
      };

      this.storeFileTransfer(transferInfo);

      const sftp = await client.requestSFTP();

      await new Promise<void>((resolve, reject) => {
        transferInfo.status = 'in-progress';
        this.eventEmitter.emit('transfer-start', transferInfo);

        const readStream = fs.createReadStream(localPath);
        const writeStream = sftp.createWriteStream(remotePath);

        let settled = false;

        const cleanup = () => {
          readStream.removeAllListeners('data');
          readStream.removeAllListeners('error');
          writeStream.removeAllListeners('error');
          writeStream.removeAllListeners('close');
        };

        const fail = (err: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          transferInfo.status = 'failed';
          transferInfo.error = err.message;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-error', transferInfo);
          readStream.destroy();
          writeStream.destroy();
          reject(err);
        };

        const succeed = () => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          transferInfo.status = 'completed';
          transferInfo.progress = 100;
          transferInfo.bytesTransferred = stats.size;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-complete', transferInfo);
          resolve();
        };

        let bytesTransferred = 0;

        readStream.on('data', (chunk: string | Buffer) => {
          bytesTransferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk).length;
          transferInfo.bytesTransferred = bytesTransferred;
          transferInfo.progress = Math.min(100, Math.round((bytesTransferred / stats.size) * 100));
          this.eventEmitter.emit('transfer-progress', transferInfo);
        });

        readStream.on('error', (err: Error) => {
          fail(err);
        });

        writeStream.on('error', (err: Error) => {
          fail(err);
        });

        writeStream.on('close', () => {
          succeed();
        });

        readStream.pipe(writeStream);
      });

      return this.getStoredTransfer(transferId);
    } catch (error) {
      console.error(`上传文件到连接 ${connectionId} 时出错:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (this.fileTransfers.has(transferId)) {
        const transferInfo = this.getStoredTransfer(transferId);
        transferInfo.status = 'failed';
        transferInfo.error = errorMessage;
        transferInfo.endTime = new Date();
        this.eventEmitter.emit('transfer-error', transferInfo);
        return transferInfo;
      }

      const failedTransfer: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'upload',
        status: 'failed',
        progress: 0,
        size: 0,
        bytesTransferred: 0,
        error: errorMessage,
        startTime: new Date(),
        endTime: new Date()
      };

      this.storeFileTransfer(failedTransfer);
      this.eventEmitter.emit('transfer-error', failedTransfer);

      return failedTransfer;
    }
  }

  public async downloadFile(connectionId: string, remotePath: string, localPath: string): Promise<FileTransferInfo> {
    const connection = this.getConnectedConnection(connectionId);
    const client = connection.client;
    if (!client) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    const transferId = crypto
      .createHash('md5')
      .update(`download:${connectionId}:${remotePath}:${localPath}:${Date.now()}`)
      .digest('hex');

    try {
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      const sftp = await client.requestSFTP();
      const stats = await new Promise<{ size: number }>((resolve, reject) => {
        sftp.stat(remotePath, (err: Error | undefined, fileStats: { size: number }) => {
          if (err) {
            reject(err);
            return;
          }

          resolve(fileStats);
        });
      });

      const transferInfo: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'download',
        status: 'pending',
        progress: 0,
        size: stats.size,
        bytesTransferred: 0,
        startTime: new Date()
      };

      this.storeFileTransfer(transferInfo);

      await new Promise<void>((resolve, reject) => {
        transferInfo.status = 'in-progress';
        this.eventEmitter.emit('transfer-start', transferInfo);

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(localPath);

        let settled = false;

        const cleanup = () => {
          readStream.removeAllListeners('data');
          readStream.removeAllListeners('error');
          writeStream.removeAllListeners('error');
          writeStream.removeAllListeners('close');
        };

        const fail = (err: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          transferInfo.status = 'failed';
          transferInfo.error = err.message;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-error', transferInfo);
          readStream.destroy();
          writeStream.destroy();
          reject(err);
        };

        const succeed = () => {
          if (settled) {
            return;
          }

          settled = true;
          cleanup();
          transferInfo.status = 'completed';
          transferInfo.progress = 100;
          transferInfo.bytesTransferred = stats.size;
          transferInfo.endTime = new Date();
          this.eventEmitter.emit('transfer-complete', transferInfo);
          resolve();
        };

        let bytesTransferred = 0;

        readStream.on('data', (chunk: string | Buffer) => {
          bytesTransferred += Buffer.isBuffer(chunk) ? chunk.length : Buffer.from(chunk).length;
          transferInfo.bytesTransferred = bytesTransferred;
          transferInfo.progress = Math.min(100, Math.round((bytesTransferred / stats.size) * 100));
          this.eventEmitter.emit('transfer-progress', transferInfo);
        });

        readStream.on('error', (err: Error) => {
          fail(err);
        });

        writeStream.on('error', (err: Error) => {
          fail(err);
        });

        writeStream.on('close', () => {
          succeed();
        });

        readStream.pipe(writeStream);
      });

      return this.getStoredTransfer(transferId);
    } catch (error) {
      console.error(`从连接 ${connectionId} 下载文件时出错:`, error);

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (this.fileTransfers.has(transferId)) {
        const transferInfo = this.getStoredTransfer(transferId);
        transferInfo.status = 'failed';
        transferInfo.error = errorMessage;
        transferInfo.endTime = new Date();
        this.eventEmitter.emit('transfer-error', transferInfo);
        return transferInfo;
      }

      const failedTransfer: FileTransferInfo = {
        id: transferId,
        localPath,
        remotePath,
        direction: 'download',
        status: 'failed',
        progress: 0,
        size: 0,
        bytesTransferred: 0,
        error: errorMessage,
        startTime: new Date(),
        endTime: new Date()
      };

      this.storeFileTransfer(failedTransfer);
      this.eventEmitter.emit('transfer-error', failedTransfer);

      return failedTransfer;
    }
  }

  public async batchTransfer(config: BatchTransferConfig): Promise<string[]> {
    const { connectionId, items, direction } = config;
    this.getConnectedConnection(connectionId);

    const transferIds: string[] = [];
    const errors: Error[] = [];

    for (const item of items) {
      try {
        const transferInfo = direction === 'upload'
          ? await this.uploadFile(connectionId, item.localPath, item.remotePath)
          : await this.downloadFile(connectionId, item.remotePath, item.localPath);

        transferIds.push(transferInfo.id);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
        console.error('批量传输过程中出错:', error);
      }
    }

    if (errors.length === items.length) {
      throw new Error(`批量传输完全失败: ${errors.map((error) => error.message).join(', ')}`);
    }

    return transferIds;
  }

  public getTransferInfo(transferId: string): FileTransferInfo | undefined {
    return this.fileTransfers.get(transferId);
  }

  public getAllTransfers(): FileTransferInfo[] {
    return Array.from(this.fileTransfers.values());
  }

  public onTransferProgress(callback: (info: FileTransferInfo) => void): () => void {
    this.eventEmitter.on('transfer-progress', callback);
    return () => {
      this.eventEmitter.off('transfer-progress', callback);
    };
  }

  public onTransferComplete(callback: (info: FileTransferInfo) => void): () => void {
    this.eventEmitter.on('transfer-complete', callback);
    return () => {
      this.eventEmitter.off('transfer-complete', callback);
    };
  }

  public onTransferError(callback: (info: FileTransferInfo) => void): () => void {
    this.eventEmitter.on('transfer-error', callback);
    return () => {
      this.eventEmitter.off('transfer-error', callback);
    };
  }

  public cleanupCompletedTransfers(): void {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    for (const [id, transfer] of this.fileTransfers.entries()) {
      if ((transfer.status === 'completed' || transfer.status === 'failed') && transfer.endTime && transfer.endTime < oneHourAgo) {
        this.fileTransfers.delete(id);
      }
    }

    this.pruneFileTransfers();
    console.error(`已清理完成的文件传输记录，当前剩余: ${this.fileTransfers.size}`);
  }

  private getConnectedConnection(connectionId: string): SSHConnection {
    const connection = this.getConnectionFn(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    return connection;
  }

  private getStoredTransfer(transferId: string): FileTransferInfo {
    const transferInfo = this.fileTransfers.get(transferId);
    if (!transferInfo) {
      throw new Error(`文件传输 ${transferId} 不存在`);
    }

    return transferInfo;
  }

  private storeFileTransfer(transferInfo: FileTransferInfo): void {
    this.fileTransfers.set(transferInfo.id, transferInfo);
    this.pruneFileTransfers();
  }

  private pruneFileTransfers(): void {
    if (this.fileTransfers.size <= FileTransferService.MAX_FILE_TRANSFER_HISTORY) {
      return;
    }

    const removableTransfers = Array.from(this.fileTransfers.entries())
      .filter(([, transfer]) => transfer.status === 'completed' || transfer.status === 'failed')
      .sort(([, a], [, b]) => {
        const aTime = a.endTime?.getTime() ?? a.startTime.getTime();
        const bTime = b.endTime?.getTime() ?? b.startTime.getTime();
        return aTime - bTime;
      });

    while (this.fileTransfers.size > FileTransferService.MAX_FILE_TRANSFER_HISTORY && removableTransfers.length > 0) {
      const [transferId] = removableTransfers.shift()!;
      this.fileTransfers.delete(transferId);
    }
  }
}
