import * as crypto from 'crypto';
import * as net from 'net';

import { ConnectionStatus, type SSHConnection, type TunnelConfig } from './ssh-service-types.js';

type GetConnectionFn = (connectionId: string) => SSHConnection | undefined;

interface ActiveTunnel {
  config: TunnelConfig;
  server?: net.Server;
  connections: Set<net.Socket>;
  isActive: boolean;
}

export class TunnelService {
  private readonly tunnels: Map<string, ActiveTunnel> = new Map();

  constructor(private readonly getConnectionFn: GetConnectionFn) {}

  public async createTunnel(config: TunnelConfig): Promise<string> {
    const connection = this.getConnectedConnection(config.connectionId);

    const tunnelId = config.id || crypto
      .createHash('md5')
      .update(`${config.connectionId}:${config.localPort}:${config.remoteHost}:${config.remotePort}:${Date.now()}`)
      .digest('hex');

    const existingTunnel = Array.from(this.tunnels.values())
      .find((tunnel) => tunnel.config.localPort === config.localPort && tunnel.isActive);

    if (existingTunnel) {
      throw new Error(`本地端口 ${config.localPort} 已被另一个隧道使用`);
    }

    try {
      const server = net.createServer();
      const connections = new Set<net.Socket>();

      this.tunnels.set(tunnelId, {
        config: {
          ...config,
          id: tunnelId
        },
        server,
        connections,
        isActive: false
      });

      server.on('connection', (socket) => {
        connections.add(socket);

        socket.on('close', () => {
          connections.delete(socket);
        });

        socket.on('error', (err) => {
          console.error(`隧道 ${tunnelId} 上的本地套接字错误:`, err);
          connections.delete(socket);
          socket.destroy();
        });

        const sshClient = connection.client;
        if (!sshClient) {
          socket.destroy();
          connections.delete(socket);
          return;
        }

        sshClient.forwardOut('127.0.0.1', socket.remotePort || 0, config.remoteHost, config.remotePort)
          .then((stream) => {
            socket.pipe(stream);
            stream.pipe(socket);

            stream.on('error', (err: Error) => {
              console.error(`隧道 ${tunnelId} 上的SSH流错误:`, err);
              connections.delete(socket);
              socket.destroy();
            });

            socket.on('error', (err: Error) => {
              console.error(`隧道 ${tunnelId} 上的本地套接字错误:`, err);
              stream.destroy();
            });

            stream.on('close', () => {
              connections.delete(socket);
              socket.destroy();
            });

            socket.on('close', () => {
              stream.destroy();
            });
          })
          .catch((err) => {
            console.error(`为隧道 ${tunnelId} 创建转发时出错:`, err);
            connections.delete(socket);
            socket.destroy();
          });
      });

      await new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen(config.localPort, '127.0.0.1', () => {
          const tunnel = this.tunnels.get(tunnelId);
          if (tunnel) {
            tunnel.isActive = true;
          }
          resolve();
        });
      });

      return tunnelId;
    } catch (error) {
      this.closeTunnel(tunnelId).catch(() => {});
      console.error('创建隧道时出错:', error);
      throw error;
    }
  }

  public async closeTunnel(tunnelId: string): Promise<boolean> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) {
      return false;
    }

    try {
      for (const socket of tunnel.connections) {
        socket.removeAllListeners();
        socket.destroy();
      }

      tunnel.connections.clear();

      if (tunnel.server) {
        tunnel.server.removeAllListeners();
        await new Promise<void>((resolve) => {
          tunnel.server?.close(() => resolve());
        });
      }

      tunnel.isActive = false;
      this.tunnels.delete(tunnelId);
      return true;
    } catch (error) {
      console.error(`关闭隧道 ${tunnelId} 时出错:`, error);
      return false;
    }
  }

  public getTunnels(): TunnelConfig[] {
    return Array.from(this.tunnels.values())
      .filter((tunnel) => tunnel.isActive)
      .map((tunnel) => tunnel.config);
  }

  public async closeAll(): Promise<void> {
    for (const tunnelId of Array.from(this.tunnels.keys())) {
      await this.closeTunnel(tunnelId);
    }
  }

  public getTunnelCount(): number {
    return this.tunnels.size;
  }

  private getConnectedConnection(connectionId: string): SSHConnection {
    const connection = this.getConnectionFn(connectionId);
    if (!connection || !connection.client || connection.status !== ConnectionStatus.CONNECTED) {
      throw new Error(`连接 ${connectionId} 不可用或未连接`);
    }

    return connection;
  }
}
