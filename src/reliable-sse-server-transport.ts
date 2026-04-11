import * as http from 'http';
import { randomUUID } from 'crypto';
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

type RequestId = string | number;

interface InflightRequestInfo {
  startedAt: number;
  method?: string;
  toolName?: string;
}

interface LogDetails {
  [key: string]: string | number | boolean | null | undefined;
}

export type ReliableSseLogEvent =
  | 'transport-started'
  | 'message-received'
  | 'message-accepted'
  | 'message-sent'
  | 'message-send-failed';

interface ReliableSSEServerTransportOptions {
  endpoint: string;
  response: http.ServerResponse;
  writeTimeoutMs?: number;
  sessionId?: string;
  onLog?: (event: ReliableSseLogEvent, details: LogDetails) => void;
  onActivity?: () => void;
}

const DEFAULT_WRITE_TIMEOUT_MS = 5000;

export class ReliableSSEServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  sessionId: string;

  private readonly endpoint: string;
  private readonly response: http.ServerResponse;
  private readonly writeTimeoutMs: number;
  private readonly inflightRequests = new Map<RequestId, InflightRequestInfo>();
  private readonly onLog?: (event: ReliableSseLogEvent, details: LogDetails) => void;
  private readonly onActivity?: () => void;
  private sseResponse?: http.ServerResponse;
  private isClosed = false;

  constructor(options: ReliableSSEServerTransportOptions) {
    this.endpoint = options.endpoint;
    this.response = options.response;
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.sessionId = options.sessionId ?? randomUUID();
    this.onLog = options.onLog;
    this.onActivity = options.onActivity;
  }

  async start(): Promise<void> {
    if (this.sseResponse) {
      throw new Error('ReliableSSEServerTransport already started');
    }

    this.response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    this.sseResponse = this.response;
    this.response.once('close', () => {
      this.handleClose();
    });
    this.response.once('error', (error) => {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });

    await this.writeChunk(`event: endpoint\ndata: ${encodeURI(this.endpoint)}?sessionId=${this.sessionId}\n\n`);
    this.log('transport-started', {
      sessionId: this.sessionId,
      endpoint: this.endpoint,
    });
  }

  async handlePostMessage(req: http.IncomingMessage, res: http.ServerResponse, parsedBody: unknown): Promise<void> {
    if (!this.sseResponse || this.isClosed) {
      const message = 'SSE connection not established';
      res.writeHead(500).end(message);
      throw new Error(message);
    }

    const contentType = req.headers['content-type'];
    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
      res.writeHead(400).end('Unsupported content-type');
      return;
    }

    try {
      const parsedMessage = JSONRPCMessageSchema.parse(parsedBody);
      const messageInfo = getMessageInfo(parsedMessage);

      if (messageInfo.id !== undefined && messageInfo.messageType === 'request') {
        this.inflightRequests.set(messageInfo.id, {
          startedAt: Date.now(),
          method: messageInfo.method,
          toolName: messageInfo.toolName,
        });
      }

      this.onActivity?.();
      this.log('message-received', {
        sessionId: this.sessionId,
        messageId: stringifyRequestId(messageInfo.id),
        messageType: messageInfo.messageType,
        method: messageInfo.method,
        toolName: messageInfo.toolName,
      });

      this.onmessage?.(parsedMessage);
      res.writeHead(202).end('Accepted');

      this.log('message-accepted', {
        sessionId: this.sessionId,
        messageId: stringifyRequestId(messageInfo.id),
        messageType: messageInfo.messageType,
        method: messageInfo.method,
        toolName: messageInfo.toolName,
      });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(normalizedError);
      res.writeHead(400).end(`Invalid message: ${normalizedError.message}`);
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.sseResponse || this.isClosed) {
      throw new Error('Not connected');
    }

    const messageInfo = getMessageInfo(message);
    const inflight = messageInfo.id !== undefined ? this.inflightRequests.get(messageInfo.id) : undefined;
    const processingTimeMs = inflight ? Date.now() - inflight.startedAt : undefined;

    try {
      await this.writeChunk(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
      this.onActivity?.();

      this.log('message-sent', {
        sessionId: this.sessionId,
        messageId: stringifyRequestId(messageInfo.id),
        messageType: messageInfo.messageType,
        method: messageInfo.method ?? inflight?.method,
        toolName: messageInfo.toolName ?? inflight?.toolName,
        processingTimeMs,
        hasError: messageInfo.hasError,
      });
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.log('message-send-failed', {
        sessionId: this.sessionId,
        messageId: stringifyRequestId(messageInfo.id),
        messageType: messageInfo.messageType,
        method: messageInfo.method ?? inflight?.method,
        toolName: messageInfo.toolName ?? inflight?.toolName,
        processingTimeMs,
        error: normalizedError.message,
      });
      this.onerror?.(normalizedError);
      throw normalizedError;
    } finally {
      if (messageInfo.id !== undefined) {
        this.inflightRequests.delete(messageInfo.id);
      }
    }
  }

  async close(): Promise<void> {
    const response = this.sseResponse;
    this.handleClose();
    response?.end();
  }

  private handleClose(): void {
    if (this.isClosed) {
      return;
    }

    this.isClosed = true;
    this.sseResponse = undefined;
    this.inflightRequests.clear();
    this.onclose?.();
  }

  private async writeChunk(chunk: string): Promise<void> {
    const response = this.sseResponse;
    if (!response || response.writableEnded || response.destroyed) {
      throw new Error('SSE response is closed');
    }

    const canContinue = response.write(chunk);
    if (canContinue) {
      return;
    }

    await waitForDrain(response, this.writeTimeoutMs);
  }

  private log(event: ReliableSseLogEvent, details: LogDetails): void {
    this.onLog?.(event, details);
  }
}

function waitForDrain(response: http.ServerResponse, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
      clearTimeout(timeoutId);
    };

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };

    const onDrain = () => settle(resolve);
    const onClose = () => settle(() => reject(new Error('SSE response closed while waiting for drain')));
    const onError = (error: Error) => settle(() => reject(error));
    const timeoutId = setTimeout(() => {
      settle(() => reject(new Error(`SSE write drain timeout (${timeoutMs}ms)`)));
    }, timeoutMs);

    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

function stringifyRequestId(id: RequestId | undefined): string | undefined {
  if (id === undefined) {
    return undefined;
  }
  return String(id);
}

function getMessageInfo(message: JSONRPCMessage): {
  id?: RequestId;
  method?: string;
  toolName?: string;
  messageType: 'request' | 'notification' | 'response' | 'error';
  hasError: boolean;
} {
  if ('method' in message) {
    const toolName = message.method === 'tools/call' && message.params && typeof message.params === 'object' && 'name' in message.params
      ? typeof message.params.name === 'string'
        ? message.params.name
        : undefined
      : undefined;

    if ('id' in message) {
      return {
        id: message.id,
        method: message.method,
        toolName,
        messageType: 'request',
        hasError: false,
      };
    }

    return {
      method: message.method,
      toolName,
      messageType: 'notification',
      hasError: false,
    };
  }

  if ('error' in message) {
    return {
      id: message.id,
      messageType: 'error',
      hasError: true,
    };
  }

  return {
    id: message.id,
    messageType: 'response',
    hasError: false,
  };
}
