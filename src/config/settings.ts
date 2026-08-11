import fs from 'node:fs';
import path from 'node:path';

export enum SecurityTier {
  STANDARD = 'STANDARD',
  STRICT = 'STRICT',
  FORTRESS = 'FORTRESS'
}

export interface KrixSettings {
  security: {
    currentTier: SecurityTier;
    enforceTotpForMutating: boolean;
    sanitizeOutputs: boolean;
    blockUnknownIps: boolean;
  };
  rateLimiting: {
    globalWindowMs: number;
    globalMaxRequests: number;
    authWindowMs: number;
    authMaxRequests: number;
    defaultKeyRateLimitPerMin: number;
  };
  sandbox: {
    disableBwrap: boolean;
    defaultTimeoutMs: number;
    maxMemoryMB: number;
    allowedManagers: string[];
  };
  email: {
    alertsEnabled: boolean;
    alertOnNewIpLogin: boolean;
    alertOnApiKeyCreation: boolean;
  };
  quotas: {
    maxKeysPerUser: number;
    defaultMaxMemoryPerSessionMB: number;
  };
}

export interface AllowedToolsConfig {
  policy: {
    defaultCategoryStatus: {
      core: boolean;
      github_issues_prs: boolean;
      github_admin: boolean;
      render: boolean;
      sandbox: boolean;
    };
    allowDynamicToolsetLoading: boolean;
  };
  tools: Record<string, {
    enabled: boolean;
    category: 'core' | 'github_issues_prs' | 'github_admin' | 'render' | 'sandbox';
    permission: 'READ_ONLY' | 'MUTATING' | 'ADMIN';
    description: string;
  }>;
}

const SETTINGS_PATH = path.resolve(process.cwd(), 'config/settings.json');
const ALLOWED_TOOLS_PATH = path.resolve(process.cwd(), 'config/allowedTools.json');

const DEFAULT_SETTINGS: KrixSettings = {
  security: {
    currentTier: SecurityTier.STANDARD,
    enforceTotpForMutating: false,
    sanitizeOutputs: true,
    blockUnknownIps: false
  },
  rateLimiting: {
    globalWindowMs: 900000,
    globalMaxRequests: 1000,
    authWindowMs: 900000,
    authMaxRequests: 20,
    defaultKeyRateLimitPerMin: 60
  },
  sandbox: {
    disableBwrap: true,
    defaultTimeoutMs: 30000,
    maxMemoryMB: 512,
    allowedManagers: ['npm', 'pip']
  },
  email: {
    alertsEnabled: true,
    alertOnNewIpLogin: true,
    alertOnApiKeyCreation: true
  },
  quotas: {
    maxKeysPerUser: 3,
    defaultMaxMemoryPerSessionMB: 512
  }
};

let cachedSettings: KrixSettings | null = null;
let cachedToolPolicy: AllowedToolsConfig | null = null;

export function loadSettings(): KrixSettings {
  if (cachedSettings) return cachedSettings;
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const data = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
      cachedSettings = { ...DEFAULT_SETTINGS, ...data, security: { ...DEFAULT_SETTINGS.security, ...data.security } };
      return cachedSettings!;
    }
  } catch (err) {
    console.error('[Settings] Error loading config/settings.json, falling back to defaults:', err);
  }
  cachedSettings = DEFAULT_SETTINGS;
  return cachedSettings;
}

export function saveSettings(newSettings: Partial<KrixSettings>): KrixSettings {
  const current = loadSettings();
  const merged: KrixSettings = {
    ...current,
    ...newSettings,
    security: { ...current.security, ...(newSettings.security || {}) },
    rateLimiting: { ...current.rateLimiting, ...(newSettings.rateLimiting || {}) },
    sandbox: { ...current.sandbox, ...(newSettings.sandbox || {}) },
    email: { ...current.email, ...(newSettings.email || {}) },
    quotas: { ...current.quotas, ...(newSettings.quotas || {}) }
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  cachedSettings = merged;
  return merged;
}

export function loadToolPolicy(): AllowedToolsConfig {
  if (cachedToolPolicy) return cachedToolPolicy;
  try {
    if (fs.existsSync(ALLOWED_TOOLS_PATH)) {
      cachedToolPolicy = JSON.parse(fs.readFileSync(ALLOWED_TOOLS_PATH, 'utf-8'));
      return cachedToolPolicy!;
    }
  } catch (err) {
    console.error('[Settings] Error loading config/allowedTools.json:', err);
  }
  return {
    policy: {
      defaultCategoryStatus: {
        core: true,
        github_issues_prs: false,
        github_admin: false,
        render: false,
        sandbox: false
      },
      allowDynamicToolsetLoading: true
    },
    tools: {}
  };
}

export function isToolGloballyAllowed(toolName: string): boolean {
  const policy = loadToolPolicy();
  const def = policy.tools?.[toolName];
  if (!def) return true;
  return def.enabled !== false;
}
