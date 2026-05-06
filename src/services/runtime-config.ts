import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';

const DEFAULT_DATA_PATH = path.join(os.homedir(), '.mcp-ssh');

// ── Zod schema: single source of truth for every env var this project reads ──

const EnvSchema = z.object({
  // Data / storage
  DATA_PATH: z.string().optional(),
  SSH_DATA_PATH: z.string().optional(),

  // Docker
  IS_DOCKER: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
  ALLOW_INSECURE_DOCKER_CREDENTIALS: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),

  // SSH defaults
  DEFAULT_SSH_PORT: z.coerce.number().int().positive().default(22),
  CONNECTION_TIMEOUT: z.coerce.number().int().positive().default(10000),
  RECONNECT_ATTEMPTS: z.coerce.number().int().min(0).default(3),
  COMMAND_TIMEOUT: z.coerce.number().int().positive().optional(),
  SSH_POOL_SIZE: z.coerce.number().int().positive().default(10),
  HEALTH_CHECK_INTERVAL: z.coerce.number().int().positive().default(30000),

  // Output
  MAX_OUTPUT_LENGTH: z.coerce.number().int().positive().default(3000),
  SAVE_HISTORY: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),

  // AI safety check
  SAFETY_CHECK_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform(v => v === 'true'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_BASE: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-3.5-turbo'),
  OPENAI_TIMEOUT: z.coerce.number().int().positive().default(30000),
  OPENAI_THINKING_TYPE: z.enum(['disabled', 'enabled', 'auto']).default('disabled'),
  ARK_API_KEY: z.string().optional(),
  ARK_API_BASE: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_TIMEOUT: z.coerce.number().int().positive().optional(),
  ARK_THINKING_TYPE: z.enum(['disabled', 'enabled', 'auto']).optional(),

  // SSE server
  MCP_SSE_PORT: z.coerce.number().int().positive().optional(),
  MCP_SSE_HOST: z.string().default('127.0.0.1'),
  MCP_SSE_HEARTBEAT_INTERVAL: z.coerce.number().int().positive().default(15000),
  MCP_SSE_WRITE_TIMEOUT: z.coerce.number().int().positive().default(5000),
  MCP_SSE_LOG_LANGUAGE: z.enum(['zh', 'en', 'auto']).optional(),
  MCP_SSE_AUTH_TOKEN: z.string().optional(),

  // Process manager
  LOCK_FILE_PATH: z.string().optional(),
  MCP_SSH_LOCK_PATH: z.string().optional(),
  MCP_LOCK_FILE: z.string().optional(),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

// ── Derived config helpers (resolved once, used everywhere) ──

export interface DataPathResolution {
  dataPath: string;
  warning?: string;
}

export function isInsecureDockerCredentialPersistenceEnabled(cfg: Pick<EnvConfig, 'ALLOW_INSECURE_DOCKER_CREDENTIALS'>): boolean {
  return cfg.ALLOW_INSECURE_DOCKER_CREDENTIALS === true;
}

export function resolveDataPath(cfg: Pick<EnvConfig, 'DATA_PATH' | 'SSH_DATA_PATH'>): DataPathResolution {
  const dataPath = cfg.DATA_PATH?.trim();
  const legacyDataPath = cfg.SSH_DATA_PATH?.trim();

  if (dataPath) {
    if (legacyDataPath && legacyDataPath !== dataPath) {
      return {
        dataPath,
        warning: 'DATA_PATH and SSH_DATA_PATH are both set; using DATA_PATH.'
      };
    }
    return { dataPath };
  }

  if (legacyDataPath) {
    return {
      dataPath: legacyDataPath,
      warning: 'SSH_DATA_PATH is deprecated; use DATA_PATH instead.'
    };
  }

  return { dataPath: DEFAULT_DATA_PATH };
}

// ── Resolved AI safety config (OPENAI_* takes priority over ARK_*) ──

export interface SafetyCheckConfig {
  apiKey: string | undefined;
  apiBase: string | undefined;
  model: string;
  timeout: number;
  thinkingType: 'disabled' | 'enabled' | 'auto';
}

export function resolveSafetyCheckConfig(cfg: EnvConfig): SafetyCheckConfig {
  return {
    apiKey: cfg.OPENAI_API_KEY || cfg.ARK_API_KEY,
    apiBase: cfg.OPENAI_API_BASE || cfg.ARK_API_BASE,
    model: cfg.OPENAI_MODEL || cfg.ARK_MODEL || 'gpt-3.5-turbo',
    timeout: cfg.OPENAI_TIMEOUT || cfg.ARK_TIMEOUT || 30000,
    thinkingType: cfg.OPENAI_THINKING_TYPE || cfg.ARK_THINKING_TYPE || 'disabled',
  };
}

// ── Singleton: parse once at first import, fail fast on bad values ──

let _config: EnvConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  if (!_config) {
    _config = EnvSchema.parse(env);
  }
  return _config;
}
