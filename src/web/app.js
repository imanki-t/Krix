// Krix Enterprise Glassmorphism Single-Page Application & Routing Engine

const state = {
  user: null,
  keys: [],
  logs: [],
  serverStatus: null,
  currentPath: window.location.pathname || '/',
  modal: null, // { type: 'create_key' | 'view_key' | 'setup_2fa', data: any }
  consoleOutput: null,
  consoleRunning: false
};

// Toast notification system
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : '⚡';
  toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

async function fetchMe() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      state.user = await res.json();
    } else {
      state.user = null;
    }
  } catch {
    state.user = null;
  }
}

async function fetchKeys() {
  try {
    const res = await fetch('/api/keys');
    if (res.ok) {
      const data = await res.json();
      state.keys = data.keys || [];
    }
  } catch {}
}

async function fetchLogs() {
  try {
    const res = await fetch('/api/audit');
    if (res.ok) {
      const data = await res.json();
      state.logs = data.logs || [];
    }
  } catch {}
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      state.serverStatus = await res.json();
    }
  } catch {}
}

export function navigate(path, pushState = true) {
  if (pushState) {
    window.history.pushState({}, '', path);
  }
  state.currentPath = path;
  render();
}

window.addEventListener('popstate', () => {
  state.currentPath = window.location.pathname;
  render();
});

// Render Core
export async function render() {
  const app = document.getElementById('app');
  if (!app) return;

  const p = state.currentPath;

  if (p.startsWith('/dashboard') && !state.user) {
    await fetchMe();
    if (!state.user) {
      navigate('/login');
      return;
    }
    await Promise.all([fetchKeys(), fetchLogs(), fetchStatus()]);
  }

  app.innerHTML = `
    ${renderNavbar()}
    <main>
      ${renderRouteView()}
    </main>
    ${renderModal()}
  `;

  attachViewListeners();
}

function renderNavbar() {
  const isAuth = Boolean(state.user);
  return `
    <header class="navbar">
      <div class="nav-brand">
        <a href="/" onclick="event.preventDefault(); window.krix.nav('/')" style="display:flex;align-items:center;gap:12px;">
          <img src="/logo.svg" alt="Krix Logo" class="brand-logo-img" />
          <span style="letter-spacing:-0.03em;font-weight:700;font-size:16px;">KRIX</span>
          <span class="badge badge-emerald">v2.0 LIVE</span>
        </a>
      </div>
      <nav style="display:flex;align-items:center;gap:16px;">
        <a href="/docs" onclick="event.preventDefault(); window.krix.nav('/docs')" class="nav-link">Documentation</a>
        <a href="/policy" onclick="event.preventDefault(); window.krix.nav('/policy')" class="nav-link">Security Policy</a>
        ${isAuth ? `
          <a href="/dashboard" onclick="event.preventDefault(); window.krix.nav('/dashboard')" class="nav-link" style="color:#ffffff;font-weight:600;">Control Center</a>
          <div style="display:flex;align-items:center;gap:12px;margin-left:8px;border-left:1px solid var(--border-glass);padding-left:16px;">
            <span style="font-size:13px;color:var(--text-secondary);">${escapeHtml(state.user.email)}</span>
            <button class="btn btn-secondary btn-sm" onclick="window.krix.logout()">Sign Out</button>
          </div>
        ` : `
          <a href="/login" onclick="event.preventDefault(); window.krix.nav('/login')" class="btn btn-secondary btn-sm">Sign In</a>
          <a href="/signup" onclick="event.preventDefault(); window.krix.nav('/signup')" class="btn btn-primary btn-sm">Get Started</a>
        `}
      </nav>
    </header>
  `;
}

function renderRouteView() {
  const p = state.currentPath;
  if (p === '/') return renderHomeView();
  if (p === '/login') return renderLoginView();
  if (p === '/signup') return renderSignupView();
  if (p === '/docs') return renderDocsView();
  if (p === '/policy' || p === '/privacy' || p === '/terms') return renderPolicyView();
  if (p.startsWith('/dashboard')) return renderDashboardView();
  return renderNotFoundView();
}

function renderHomeView() {
  return `
    <div style="max-width: 1040px; margin: 0 auto; padding: 100px 24px 80px; text-align: center;">
      <div style="display:inline-flex;align-items:center;gap:8px;padding:6px 16px;border-radius:var(--radius-full);background:rgba(255,255,255,0.04);border:1px solid var(--border-glass);font-size:12.5px;margin-bottom:28px;backdrop-filter:blur(8px);">
        <span class="pulse-dot"></span>
        <span style="color:var(--text-secondary);">Enterprise Model Context Protocol Gateway</span>
      </div>

      <h1 style="font-size: 64px; font-weight: 800; letter-spacing: -0.04em; line-height: 1.08; margin-bottom: 24px;">
        Autonomous Intelligence.<br/>
        <span style="background: linear-gradient(180deg, #ffffff 0%, #a1a1aa 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">Fortified Execution.</span>
      </h1>

      <p style="font-size: 18px; color: var(--text-secondary); max-width: 700px; margin: 0 auto 40px; line-height: 1.6;">
        Production MCP gateway enabling Claude, Cursor, and agentic workflows to safely orchestrate GitHub repositories, Render infrastructure, and multi-runtime execution sandboxes.
      </p>

      <div style="display: flex; justify-content: center; gap: 14px; margin-bottom: 72px;">
        <a href="/signup" onclick="event.preventDefault(); window.krix.nav('/signup')" class="btn btn-primary" style="padding: 13px 32px; font-size: 14.5px;">Launch Control Center</a>
        <a href="/docs" onclick="event.preventDefault(); window.krix.nav('/docs')" class="btn btn-secondary" style="padding: 13px 28px; font-size: 14.5px;">Explore Documentation</a>
      </div>

      <!-- Quick Connect Glass Card -->
      <div class="glass-card" style="text-align: left; max-width: 860px; margin: 0 auto;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-size:14px;font-weight:600;color:#ffffff;">Claude Desktop & Cursor IDE Configuration</div>
            <span class="badge badge-purple">Streamable HTTP / SSE</span>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('${window.location.origin}/mcp'); window.krix.toast('Copied MCP Gateway URL!')">Copy URL</button>
        </div>
        <pre style="background:rgba(0,0,0,0.7);border:1px solid var(--border-glass);border-radius:var(--radius-md);padding:18px;font-size:13px;color:#a1a1aa;overflow-x:auto;line-height:1.6;">
{
  "mcpServers": {
    "krix": {
      "url": "${window.location.origin}/mcp",
      "headers": {
        "x-api-key": "krix_live_YOUR_API_KEY"
      }
    }
  }
}</pre>
      </div>
    </div>
  `;
}

function renderLoginView() {
  return `
    <div style="min-height: calc(100vh - 64px); display: flex; align-items: center; justify-content: center; padding: 24px;">
      <div class="glass-card" style="max-width: 420px; width: 100%; padding: 40px 36px;">
        <div style="text-align:center;margin-bottom:28px;">
          <img src="/logo.svg" alt="Krix" style="width:44px;height:44px;margin-bottom:12px;" />
          <h2 style="font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">Welcome Back</h2>
          <p style="font-size: 13.5px; color: var(--text-secondary); margin-top: 4px;">Sign in to your Krix Control Center</p>
        </div>

        <form id="login-form" onsubmit="window.krix.handleLogin(event)">
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" name="email" class="form-input" placeholder="developer@domain.com" required />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" name="password" class="form-input" placeholder="••••••••" required />
          </div>
          <div id="totp-field" class="form-group" style="display:none;">
            <label class="form-label" style="color:var(--accent-amber);">Google Authenticator 2FA Code</label>
            <input type="text" name="totpToken" class="form-input" placeholder="6-digit code" maxlength="6" />
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;padding:12px;margin-top:8px;">Sign In</button>
        </form>

        <div style="text-align:center;font-size:13px;color:var(--text-tertiary);margin-top:24px;">
          Don't have an account? <a href="/signup" onclick="event.preventDefault(); window.krix.nav('/signup')" style="color:#ffffff;text-decoration:underline;">Create Account</a>
        </div>
      </div>
    </div>
  `;
}

function renderSignupView() {
  return `
    <div style="min-height: calc(100vh - 64px); display: flex; align-items: center; justify-content: center; padding: 24px;">
      <div class="glass-card" style="max-width: 420px; width: 100%; padding: 40px 36px;">
        <div style="text-align:center;margin-bottom:28px;">
          <img src="/logo.svg" alt="Krix" style="width:44px;height:44px;margin-bottom:12px;" />
          <h2 style="font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">Create Account</h2>
          <p style="font-size: 13.5px; color: var(--text-secondary); margin-top: 4px;">Initialize your fortified MCP gateway</p>
        </div>

        <form id="signup-form" onsubmit="window.krix.handleSignup(event)">
          <div class="form-group">
            <label class="form-label">Full Name</label>
            <input type="text" name="name" class="form-input" placeholder="Ada Lovelace" required />
          </div>
          <div class="form-group">
            <label class="form-label">Email Address</label>
            <input type="email" name="email" class="form-input" placeholder="developer@domain.com" required />
          </div>
          <div class="form-group">
            <label class="form-label">Password</label>
            <input type="password" name="password" class="form-input" placeholder="Min 10 chars (uppercase, number, symbol)" required minlength="10" />
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;padding:12px;margin-top:8px;">Create Developer Account</button>
        </form>

        <div style="text-align:center;font-size:13px;color:var(--text-tertiary);margin-top:24px;">
          Already registered? <a href="/login" onclick="event.preventDefault(); window.krix.nav('/login')" style="color:#ffffff;text-decoration:underline;">Sign In</a>
        </div>
      </div>
    </div>
  `;
}

function renderDashboardView() {
  const tab = state.currentPath.split('/')[2] || 'overview';
  return `
    <div style="display:flex;min-height:calc(100vh - 64px);">
      <!-- Glassmorphic Sidebar -->
      <aside class="sidebar">
        <div class="sidebar-title">Control Center</div>
        <a href="/dashboard" onclick="event.preventDefault(); window.krix.nav('/dashboard')" class="sidebar-item ${tab === 'overview' ? 'active' : ''}">
          <span>📊</span> Overview
        </a>
        <a href="/dashboard/keys" onclick="event.preventDefault(); window.krix.nav('/dashboard/keys')" class="sidebar-item ${tab === 'keys' ? 'active' : ''}">
          <span>🔑</span> API Keys & Quotas
        </a>
        <a href="/dashboard/console" onclick="event.preventDefault(); window.krix.nav('/dashboard/console')" class="sidebar-item ${tab === 'console' ? 'active' : ''}">
          <span>⚡</span> Live Playground
        </a>
        <a href="/dashboard/security" onclick="event.preventDefault(); window.krix.nav('/dashboard/security')" class="sidebar-item ${tab === 'security' ? 'active' : ''}">
          <span>🛡️</span> Security & 2FA
        </a>
        <a href="/dashboard/vault" onclick="event.preventDefault(); window.krix.nav('/dashboard/vault')" class="sidebar-item ${tab === 'vault' ? 'active' : ''}">
          <span>🔐</span> Integration Vault
        </a>
        <a href="/dashboard/audit" onclick="event.preventDefault(); window.krix.nav('/dashboard/audit')" class="sidebar-item ${tab === 'audit' ? 'active' : ''}">
          <span>📜</span> Forensic Audit Logs
        </a>
      </aside>

      <!-- Main Content Container -->
      <section style="flex:1;padding:40px 48px;overflow-y:auto;">
        ${tab === 'overview' ? renderDashboardOverview() : ''}
        ${tab === 'keys' ? renderDashboardKeys() : ''}
        ${tab === 'console' ? renderDashboardConsole() : ''}
        ${tab === 'security' ? renderDashboardSecurity() : ''}
        ${tab === 'vault' ? renderDashboardVault() : ''}
        ${tab === 'audit' ? renderDashboardAudit() : ''}
      </section>
    </div>
  `;
}

function renderDashboardOverview() {
  const tierColor = state.user?.securityTier === 'FORTRESS' ? 'badge-rose' : state.user?.securityTier === 'STRICT' ? 'badge-amber' : 'badge-emerald';
  return `
    <div>
      <div style="margin-bottom:32px;">
        <h2 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:6px;">System Overview</h2>
        <p style="font-size:14px;color:var(--text-secondary);">Real-time Model Context Protocol telemetry and isolated sandbox health.</p>
      </div>

      <!-- Telemetry Cards -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(240px, 1fr));gap:20px;margin-bottom:40px;">
        <div class="glass-card">
          <div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Security Tier</div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span class="badge ${tierColor}" style="font-size:14px;padding:4px 12px;">${state.user?.securityTier || 'STANDARD'}</span>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:8px;">Containment & Command Filtering</div>
        </div>

        <div class="glass-card">
          <div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Active API Keys</div>
          <div style="font-size:28px;font-weight:800;color:#ffffff;">${state.keys?.length || 0} <span style="font-size:14px;color:var(--text-tertiary);font-weight:500;">/ 3 max</span></div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;">One-way HMAC encrypted</div>
        </div>

        <div class="glass-card">
          <div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Two-Factor Auth</div>
          <div style="font-size:20px;font-weight:700;color:${state.user?.isTotpEnabled ? '#34d399' : '#f87171'};">
            ${state.user?.isTotpEnabled ? '🛡️ Enabled' : '⚠️ Disabled'}
          </div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:8px;">TOTP Google Authenticator</div>
        </div>

        <div class="glass-card">
          <div style="font-size:12px;font-weight:600;color:var(--text-tertiary);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:10px;">Multi-Runtime Sandbox</div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="pulse-dot"></span>
            <span style="font-size:15px;font-weight:700;color:#ffffff;">7 Runtimes Online</span>
          </div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:8px;">Python, Node, TS, Go, Java, C++, Bash</div>
        </div>
      </div>
    </div>
  `;
}

function renderDashboardKeys() {
  return `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;">
        <div>
          <h2 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:6px;">API Keys & Quotas</h2>
          <p style="font-size:14px;color:var(--text-secondary);">Manage one-way hashed API keys for Claude Desktop, Cursor IDE, and CLI agents.</p>
        </div>
        <button class="btn btn-primary" onclick="window.krix.showCreateKeyModal()">+ Create New Key</button>
      </div>

      <div class="glass-card" style="padding:0;overflow:hidden;">
        <table class="glass-table">
          <thead>
            <tr>
              <th>Key Name</th>
              <th>Prefix</th>
              <th>Rate Limit</th>
              <th>Total Requests</th>
              <th>Created</th>
              <th style="text-align:right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${(state.keys || []).length === 0 ? `
              <tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-tertiary);">No API keys generated yet. Create one to connect your AI client.</td></tr>
            ` : (state.keys || []).map(k => `
              <tr>
                <td style="font-weight:600;color:#ffffff;">${escapeHtml(k.name)}</td>
                <td><code>${escapeHtml(k.keyPrefix)}...</code></td>
                <td><span class="badge badge-blue">${escapeHtml(String(k.rateLimitPerMin))} req/min</span></td>
                <td>${escapeHtml(String(k.totalRequests || 0))}</td>
                <td>${new Date(k.createdAt).toLocaleDateString()}</td>
                <td style="text-align:right;">
                  <button class="btn btn-danger btn-sm" onclick="window.krix.deleteKey('${escapeHtml(k.id)}')">Revoke</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderDashboardConsole() {
  return `
    <div>
      <div style="margin-bottom:28px;">
        <h2 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:6px;">Live Playground & Sandbox Console</h2>
        <p style="font-size:14px;color:var(--text-secondary);">Execute test scripts directly in isolated ephemeral sandboxes.</p>
      </div>

      <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:24px;">
        <div class="glass-card">
          <form onsubmit="window.krix.runSandboxScript(event)">
            <div class="form-group">
              <label class="form-label">Runtime Environment</label>
              <select name="runtime" class="form-select">
                <option value="py">Python 3 (py)</option>
                <option value="js">Node.js (js)</option>
                <option value="ts">TypeScript / tsx (ts)</option>
                <option value="sh">Bash (sh)</option>
                <option value="go">Golang (go)</option>
                <option value="java">Java 17 (java)</option>
                <option value="cpp">C++ 17 / G++ (cpp)</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Script Code</label>
              <textarea name="code" class="form-textarea" rows="12" style="font-family:var(--font-mono);font-size:13px;" placeholder="# Enter code to execute in isolated sandbox...&#10;import sys&#10;print(f'Hello from Krix Sandbox running Python {sys.version}')"></textarea>
            </div>
            <button type="submit" class="btn btn-primary" ${state.consoleRunning ? 'disabled' : ''}>
              ${state.consoleRunning ? '⚡ Executing...' : '▶ Run in Sandbox'}
            </button>
          </form>
        </div>

        <div class="glass-card" style="display:flex;flex-direction:column;">
          <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
            <span>Terminal Output</span>
            <button class="btn btn-secondary btn-sm" onclick="state.consoleOutput = null; render();">Clear</button>
          </div>
          <pre style="flex:1;background:rgba(0,0,0,0.8);border:1px solid var(--border-glass);border-radius:var(--radius-md);padding:16px;font-size:12.5px;color:#34d399;overflow-y:auto;min-height:280px;white-space:pre-wrap;">${escapeHtml(state.consoleOutput || '// Output will render here...')}</pre>
        </div>
      </div>
    </div>
  `;
}

function renderDashboardSecurity() {
  return `
    <div>
      <div style="margin-bottom:28px;">
        <h2 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:6px;">Security Hardening & 2FA</h2>
        <p style="font-size:14px;color:var(--text-secondary);">Configure execution policies, multi-factor authentication, and password security.</p>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:24px;">
        <!-- Security Tier Selector -->
        <div class="glass-card">
          <h3 style="font-size:16px;font-weight:700;margin-bottom:12px;">Operational Security Tier</h3>
          <p style="font-size:13.5px;color:var(--text-secondary);margin-bottom:20px;">Controls sandbox containment and dangerous system command filtering.</p>

          <div style="display:flex;flex-direction:column;gap:12px;">
            <label class="glass-panel" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
              <div>
                <div style="font-weight:600;color:#ffffff;">STANDARD Tier</div>
                <div style="font-size:12px;color:var(--text-tertiary);">Blocks root mutations, subshell exploits & SSRF</div>
              </div>
              <input type="radio" name="securityTier" value="STANDARD" ${state.user?.securityTier === 'STANDARD' ? 'checked' : ''} onchange="window.krix.updateTier('STANDARD')" />
            </label>

            <label class="glass-panel" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
              <div>
                <div style="font-weight:600;color:#fbbf24;">STRICT Tier</div>
                <div style="font-size:12px;color:var(--text-tertiary);">Blocks sudo, systemctl, RFC1918 internal network egress</div>
              </div>
              <input type="radio" name="securityTier" value="STRICT" ${state.user?.securityTier === 'STRICT' ? 'checked' : ''} onchange="window.krix.updateTier('STRICT')" />
            </label>

            <label class="glass-panel" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
              <div>
                <div style="font-weight:600;color:#fb7185;">FORTRESS Tier</div>
                <div style="font-size:12px;color:var(--text-tertiary);">Blocks package installation, curl execution, raw sockets</div>
              </div>
              <input type="radio" name="securityTier" value="FORTRESS" ${state.user?.securityTier === 'FORTRESS' ? 'checked' : ''} onchange="window.krix.updateTier('FORTRESS')" />
            </label>
          </div>
        </div>

        <!-- 2FA Authenticator -->
        <div class="glass-card">
          <h3 style="font-size:16px;font-weight:700;margin-bottom:12px;">Google Two-Factor Authentication</h3>
          <p style="font-size:13.5px;color:var(--text-secondary);margin-bottom:20px;">Protect console logins with RFC 6238 TOTP authentication.</p>

          <div class="glass-panel" style="margin-bottom:20px;">
            <div style="font-size:13px;color:var(--text-secondary);">Status: <strong style="color:${state.user?.isTotpEnabled ? '#34d399' : '#f87171'};">${state.user?.isTotpEnabled ? '✅ Enabled' : '❌ Disabled'}</strong></div>
          </div>

          ${state.user?.isTotpEnabled ? `
            <button class="btn btn-danger" onclick="window.krix.disable2FA()">Disable 2FA</button>
          ` : `
            <button class="btn btn-primary" onclick="window.krix.setup2FA()">Set Up Google Authenticator</button>
          `}
        </div>
      </div>
    </div>
  `;
}

function renderDashboardVault() {
  return `
    <div>
      <div style="margin-bottom:28px;">
        <h2 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:6px;">Integration Vault</h2>
        <p style="font-size:14px;color:var(--text-secondary);">Securely store hardware-derived AES-256-GCM encrypted tokens for automated tool operations.</p>
      </div>

      <div class="glass-card" style="max-width:580px;">
        <form onsubmit="window.krix.saveIntegrations(event)">
          <div class="form-group">
            <label class="form-label">GitHub Personal Access Token (PAT)</label>
            <input type="password" name="githubPat" class="form-input" placeholder="ghp_... or github_pat_..." />
            <span style="font-size:11.5px;color:var(--text-tertiary);margin-top:4px;display:block;">Injected automatically into git and GitHub repo tools.</span>
          </div>

          <div class="form-group">
            <label class="form-label">Render Cloud API Key</label>
            <input type="password" name="renderKey" class="form-input" placeholder="rnd_..." />
            <span style="font-size:11.5px;color:var(--text-tertiary);margin-top:4px;display:block;">Enables Render cloud service deployment & database queries.</span>
          </div>

          <button type="submit" class="btn btn-primary">Encrypt & Save in Vault</button>
        </form>
      </div>
    </div>
  `;
}

function renderDashboardAudit() {
  return `
    <div>
      <div style="margin-bottom:28px;">
        <h2 style="font-size:28px;font-weight:800;letter-spacing:-0.03em;margin-bottom:6px;">Forensic Audit Logs</h2>
        <p style="font-size:14px;color:var(--text-secondary);">Immutable event stream tracking logins, API key usage, token rotations, and security triggers.</p>
      </div>

      <div class="glass-card" style="padding:0;overflow:hidden;">
        <table class="glass-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Action</th>
              <th>Status</th>
              <th>IP Address</th>
              <th>User Agent</th>
            </tr>
          </thead>
          <tbody>
            ${(state.logs || []).length === 0 ? `
              <tr><td colspan="5" style="text-align:center;padding:32px;color:var(--text-tertiary);">No audit logs recorded yet.</td></tr>
            ` : (state.logs || []).map(l => {
              const statusColor = l.status === 'SUCCESS' ? 'badge-emerald' : l.status === 'BLOCKED' ? 'badge-amber' : 'badge-rose';
              return `
                <tr>
                  <td style="font-size:12.5px;color:var(--text-tertiary);">${new Date(l.createdAt).toLocaleString()}</td>
                  <td style="font-weight:600;color:#ffffff;"><code>${escapeHtml(l.action)}</code></td>
                  <td><span class="badge ${statusColor}">${escapeHtml(l.status)}</span></td>
                  <td><code>${escapeHtml(l.ipAddress || '127.0.0.1')}</code></td>
                  <td style="font-size:12px;color:var(--text-tertiary);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.userAgent || 'API Gateway')}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderDocsView() {
  return `
    <div style="max-width:840px;margin:0 auto;padding:60px 24px;">
      <h1 style="font-size:42px;font-weight:800;letter-spacing:-0.04em;margin-bottom:12px;">Documentation</h1>
      <p style="color:var(--text-secondary);font-size:16px;margin-bottom:36px;">Connect your AI client to the Krix Enterprise Gateway.</p>

      <div class="glass-card" style="margin-bottom:24px;">
        <h3 style="font-size:18px;font-weight:700;margin-bottom:12px;">Streamable HTTP / SSE Endpoint</h3>
        <code style="background:rgba(0,0,0,0.6);padding:10px 14px;border-radius:var(--radius-md);display:block;margin-bottom:12px;">POST ${window.location.origin}/mcp</code>
        <p style="font-size:13.5px;color:var(--text-secondary);">Pass your generated API key via the <code>x-api-key</code> or <code>Authorization: Bearer</code> header.</p>
      </div>
    </div>
  `;
}

function renderPolicyView() {
  return `
    <div style="max-width:840px;margin:0 auto;padding:60px 24px;">
      <h1 style="font-size:42px;font-weight:800;letter-spacing:-0.04em;margin-bottom:12px;">Privacy Policy & Security Standards</h1>
      <p style="color:var(--text-secondary);font-size:14.5px;line-height:1.7;">
        Krix complies with Google OAuth Limited Use Requirements and SOC-2 standard controls. User data is never sold, leased, or utilized for AI training.
      </p>
    </div>
  `;
}

function renderNotFoundView() {
  return `
    <div style="text-align:center;padding:120px 24px;">
      <h1 style="font-size:56px;font-weight:800;margin-bottom:12px;">404</h1>
      <p style="color:var(--text-secondary);margin-bottom:24px;">The requested console page could not be located.</p>
      <a href="/" onclick="event.preventDefault(); window.krix.nav('/')" class="btn btn-primary">Return Home</a>
    </div>
  `;
}

function renderModal() {
  if (!state.modal) return '';

  if (state.modal.type === 'create_key') {
    return `
      <div class="modal-backdrop" onclick="if(event.target === this) window.krix.closeModal()">
        <div class="modal-content">
          <h3 style="font-size:18px;font-weight:700;margin-bottom:16px;">Create New API Key</h3>
          <form onsubmit="window.krix.handleCreateKey(event)">
            <div class="form-group">
              <label class="form-label">Key Name</label>
              <input type="text" name="name" class="form-input" placeholder="e.g. Claude Desktop Production" required />
            </div>
            <div class="form-group">
              <label class="form-label">Rate Limit (Requests / Minute)</label>
              <input type="number" name="rateLimitPerMin" class="form-input" value="60" min="1" max="1000" />
            </div>
            <div style="display:flex;justify-content:flex-end;gap:12px;margin-top:24px;">
              <button type="button" class="btn btn-secondary" onclick="window.krix.closeModal()">Cancel</button>
              <button type="submit" class="btn btn-primary">Generate Key</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  if (state.modal.type === 'view_key') {
    return `
      <div class="modal-backdrop" onclick="if(event.target === this) window.krix.closeModal()">
        <div class="modal-content">
          <h3 style="font-size:18px;font-weight:700;margin-bottom:8px;color:#34d399;">API Key Generated Successfully</h3>
          <p style="font-size:13.5px;color:var(--text-secondary);margin-bottom:20px;">
            Copy this key now. For your security, this key is mathematically hashed and will <strong>never be shown again</strong>.
          </p>
          <div style="background:rgba(0,0,0,0.8);border:1px solid var(--border-highlight);padding:14px;border-radius:var(--radius-md);font-family:var(--font-mono);font-size:13px;word-break:break-all;color:#ffffff;margin-bottom:20px;">
            ${escapeHtml(state.modal.data.rawKey)}
          </div>
          <div style="display:flex;justify-content:flex-end;gap:12px;">
            <button class="btn btn-primary" onclick="navigator.clipboard.writeText('${state.modal.data.rawKey}'); window.krix.toast('Copied to clipboard!'); window.krix.closeModal();">Copy & Done</button>
          </div>
        </div>
      </div>
    `;
  }

  if (state.modal.type === 'setup_2fa') {
    return `
      <div class="modal-backdrop" onclick="if(event.target === this) window.krix.closeModal()">
        <div class="modal-content" style="text-align:center;">
          <h3 style="font-size:18px;font-weight:700;margin-bottom:12px;">Scan Authenticator QR Code</h3>
          <p style="font-size:13px;color:var(--text-secondary);margin-bottom:20px;">Scan with Google Authenticator, Authy, or 1Password.</p>
          <img src="${state.modal.data.qrCode}" alt="2FA QR" style="width:180px;height:180px;border-radius:var(--radius-md);margin:0 auto 16px;background:#ffffff;padding:8px;" />
          <form onsubmit="window.krix.verify2FA(event)">
            <input type="text" name="token" class="form-input" placeholder="Enter 6-digit code" maxlength="6" style="text-align:center;font-size:16px;letter-spacing:0.2em;margin-bottom:16px;" required />
            <div style="display:flex;justify-content:center;gap:12px;">
              <button type="button" class="btn btn-secondary" onclick="window.krix.closeModal()">Cancel</button>
              <button type="submit" class="btn btn-primary">Verify & Activate</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  return '';
}

function attachViewListeners() {}

// Global Client Actions
window.krix = {
  nav: navigate,
  toast: showToast,
  closeModal: () => {
    state.modal = null;
    render();
  },
  showCreateKeyModal: () => {
    state.modal = { type: 'create_key' };
    render();
  },
  handleCreateKey: async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = Object.fromEntries(formData.entries());
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (res.ok) {
        state.modal = { type: 'view_key', data };
        await fetchKeys();
        render();
      } else {
        showToast(data.error || 'Failed to create key', 'error');
      }
    } catch {
      showToast('Network error creating key', 'error');
    }
  },
  deleteKey: async (id) => {
    if (!confirm('Are you sure you want to revoke this API key? Active connections using this key will immediately terminate.')) return;
    try {
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast('API Key revoked successfully', 'success');
        await fetchKeys();
        render();
      } else {
        showToast('Failed to revoke API key', 'error');
      }
    } catch {
      showToast('Network error revoking key', 'error');
    }
  },
  runSandboxScript: async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = Object.fromEntries(formData.entries());
    state.consoleRunning = true;
    state.consoleOutput = '⚡ Initializing isolated sandbox...\n';
    render();

    try {
      const res = await fetch('/api/sandbox/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      state.consoleRunning = false;
      if (res.ok) {
        state.consoleOutput = `[Exit Code: ${data.exitCode}]\n\n--- STDOUT ---\n${data.stdout || '(empty)'}\n\n--- STDERR ---\n${data.stderr || '(empty)'}`;
      } else {
        state.consoleOutput = `[Error]: ${data.error || 'Execution failed'}`;
      }
    } catch (err) {
      state.consoleRunning = false;
      state.consoleOutput = `[Network Error]: ${err.message}`;
    }
    render();
  },
  updateTier: async (tier) => {
    try {
      const res = await fetch('/api/settings/tier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ securityTier: tier })
      });
      if (res.ok) {
        showToast(`Operational Security Tier updated to ${tier}`, 'success');
        if (state.user) state.user.securityTier = tier;
        render();
      } else {
        showToast('Failed to update security tier', 'error');
      }
    } catch {
      showToast('Network error updating tier', 'error');
    }
  },
  setup2FA: async () => {
    try {
      const res = await fetch('/api/auth/2fa/setup', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        state.modal = { type: 'setup_2fa', data };
        render();
      } else {
        showToast(data.error || 'Failed to setup 2FA', 'error');
      }
    } catch {
      showToast('Network error initializing 2FA', 'error');
    }
  },
  verify2FA: async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const token = formData.get('token');
    try {
      const res = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (res.ok) {
        showToast('2FA Activated Successfully!', 'success');
        state.modal = null;
        if (state.user) state.user.isTotpEnabled = true;
        render();
      } else {
        showToast(data.error || 'Invalid 2FA verification token', 'error');
      }
    } catch {
      showToast('Network error verifying 2FA', 'error');
    }
  },
  disable2FA: async () => {
    if (!confirm('Disable Two-Factor Authentication?')) return;
    try {
      const res = await fetch('/api/auth/2fa/disable', { method: 'POST' });
      if (res.ok) {
        showToast('2FA Disabled', 'info');
        if (state.user) state.user.isTotpEnabled = false;
        render();
      }
    } catch {
      showToast('Network error', 'error');
    }
  },
  saveIntegrations: async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = Object.fromEntries(formData.entries());
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        showToast('Credentials safely encrypted in vault', 'success');
      } else {
        showToast('Failed to save credentials', 'error');
      }
    } catch {
      showToast('Network error', 'error');
    }
  },
  handleLogin: async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = Object.fromEntries(formData.entries());
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.ok) {
      if (data.require2FA) {
        const totpField = document.getElementById('totp-field');
        if (totpField) totpField.style.display = 'block';
        showToast('Please enter your 2FA token', 'info');
        return;
      }
      state.user = data.user;
      navigate('/dashboard');
    } else {
      showToast(data.error || 'Login failed', 'error');
    }
  },
  handleSignup: async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = Object.fromEntries(formData.entries());
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (res.ok) {
      state.user = data.user;
      navigate('/dashboard');
    } else {
      showToast(data.error || 'Registration failed', 'error');
    }
  },
  logout: async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    navigate('/login');
  }
};

// Initial bootstrap
fetchMe().then(() => render());
