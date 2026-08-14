// Krix Enterprise Single-Page Application & Routing Engine

const state = {
  user: null,
  keys: [],
  systemPolicy: null,
  userOverrides: [],
  logs: [],
  serverStatus: null,
  currentPath: window.location.pathname || '/'
};

// Toast notification helper
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  const icon = type === 'error' ? '❌' : type === 'success' ? '✅' : '⚡';
  const iconSpan = document.createElement('span');
  iconSpan.textContent = icon;
  const msgSpan = document.createElement('span');
  msgSpan.textContent = message;
  toast.appendChild(iconSpan);
  toast.appendChild(msgSpan);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

// Router & State Hydration
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

// Render Root
export async function render() {
  const app = document.getElementById('app');
  if (!app) return;

  const p = state.currentPath;

  // Protected route check
  if (p.startsWith('/dashboard') && !state.user) {
    await fetchMe();
    if (!state.user) {
      navigate('/login');
      return;
    }
  }

  app.innerHTML = `
    ${renderNavbar()}
    <main>
      ${renderRouteView()}
    </main>
  `;

  attachViewListeners();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function renderNavbar() {
  const isAuth = Boolean(state.user);
  return `
    <nav class="navbar">
      <div class="nav-brand">
        <a href="/" onclick="event.preventDefault(); window.krix.nav('/')" style="display:flex;align-items:center;gap:10px;">
          <img src="/logo.svg" alt="Krix Logo" class="brand-logo-img" />
          <span>KRIX</span>
          <span class="badge badge-purple" style="font-size:10px;">v2.0</span>
        </a>
      </div>
      <div class="nav-links" style="display:flex;align-items:center;gap:18px;">
        <a href="/docs" onclick="event.preventDefault(); window.krix.nav('/docs')" class="nav-link">Docs</a>
        <a href="/policy" onclick="event.preventDefault(); window.krix.nav('/policy')" class="nav-link">Policy</a>
        ${isAuth ? `
          <a href="/dashboard" onclick="event.preventDefault(); window.krix.nav('/dashboard')" class="nav-link">Console</a>
          <div class="user-menu" style="display:flex;align-items:center;gap:12px;">
            <span style="font-size:13px;color:#a1a1aa;">${escapeHtml(state.user.email)}</span>
            <button class="btn btn-secondary btn-sm" onclick="window.krix.logout()">Sign Out</button>
          </div>
        ` : `
          <a href="/login" onclick="event.preventDefault(); window.krix.nav('/login')" class="btn btn-secondary btn-sm">Sign In</a>
          <a href="/signup" onclick="event.preventDefault(); window.krix.nav('/signup')" class="btn btn-primary btn-sm">Get Started</a>
        `}
      </div>
    </nav>
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
    <div class="hero-section" style="padding: 80px 24px; text-align: center; max-width: 960px; margin: 0 auto;">
      <div style="display:inline-flex;align-items:center;gap:8px;padding:6px 16px;border-radius:999px;background:#18181b;border:1px solid #27272a;font-size:12px;margin-bottom:24px;">
        <span class="pulse-dot"></span> Model Context Protocol v1.30.0 Streamable HTTP
      </div>
      <h1 style="font-size: 56px; font-weight: 800; letter-spacing: -0.04em; line-height: 1.1; margin-bottom: 20px;">
        The Autonomous Agent Gateway
      </h1>
      <p style="font-size: 18px; color: #a1a1aa; max-width: 680px; margin: 0 auto 36px; line-height: 1.6;">
        Production-grade MCP server giving AI agents full, secure control over GitHub repositories, Render Cloud infrastructure, and multi-runtime execution sandboxes.
      </p>
      <div style="display: flex; justify-content: center; gap: 14px; margin-bottom: 60px;">
        <a href="/signup" onclick="event.preventDefault(); window.krix.nav('/signup')" class="btn btn-primary" style="padding: 12px 28px; font-size: 15px;">Launch Console</a>
        <a href="/docs" onclick="event.preventDefault(); window.krix.nav('/docs')" class="btn btn-secondary" style="padding: 12px 28px; font-size: 15px;">Read Documentation</a>
      </div>

      <div class="card" style="text-align: left; background: #0c0c0e; border: 1px solid #222225; padding: 24px; border-radius: 16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <div style="font-size:13px;font-weight:600;color:#ededed;">Claude Desktop Quick Connect</div>
          <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText('http://localhost:3000/mcp'); window.krix.toast('Copied URL!')">Copy URL</button>
        </div>
        <pre style="background:#000000;border:1px solid #1c1c1f;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;color:#a1a1aa;overflow-x:auto;">
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
    <div style="min-height: calc(100vh - 80px); display: flex; align-items: center; justify-content: center; padding: 24px;">
      <div class="card" style="max-width: 400px; width: 100%; padding: 36px 32px; border-radius: 16px;">
        <div style="text-align:center;margin-bottom:28px;">
          <img src="/logo.svg" alt="Krix" style="width:48px;height:48px;margin-bottom:12px;" />
          <h2 style="font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">Welcome Back</h2>
          <p style="font-size: 13.5px; color: #a1a1aa; margin-top: 4px;">Sign in to your Krix Control Center</p>
        </div>

        <form id="login-form" onsubmit="window.krix.handleLogin(event)">
          <div class="form-group" style="margin-bottom:16px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#a1a1aa;margin-bottom:6px;">Email Address</label>
            <input type="email" name="email" class="form-input" placeholder="developer@domain.com" required />
          </div>
          <div class="form-group" style="margin-bottom:20px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#a1a1aa;margin-bottom:6px;">Password</label>
            <input type="password" name="password" class="form-input" placeholder="••••••••" required />
          </div>
          <div id="totp-field" class="form-group" style="display:none;margin-bottom:20px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#f59e0b;margin-bottom:6px;">Google Authenticator 2FA Code</label>
            <input type="text" name="totpToken" class="form-input" placeholder="6-digit code" maxlength="6" />
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;padding:11px;font-size:14px;margin-bottom:16px;">Sign In</button>
        </form>

        <div style="text-align:center;font-size:13px;color:#71717a;">
          Don't have an account? <a href="/signup" onclick="event.preventDefault(); window.krix.nav('/signup')" style="color:#ffffff;text-decoration:underline;">Create Account</a>
        </div>
      </div>
    </div>
  `;
}

function renderSignupView() {
  return `
    <div style="min-height: calc(100vh - 80px); display: flex; align-items: center; justify-content: center; padding: 24px;">
      <div class="card" style="max-width: 400px; width: 100%; padding: 36px 32px; border-radius: 16px;">
        <div style="text-align:center;margin-bottom:28px;">
          <img src="/logo.svg" alt="Krix" style="width:48px;height:48px;margin-bottom:12px;" />
          <h2 style="font-size: 22px; font-weight: 700; letter-spacing: -0.02em;">Create Developer Account</h2>
          <p style="font-size: 13.5px; color: #a1a1aa; margin-top: 4px;">Initialize your enterprise MCP server</p>
        </div>

        <form id="signup-form" onsubmit="window.krix.handleSignup(event)">
          <div class="form-group" style="margin-bottom:16px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#a1a1aa;margin-bottom:6px;">Full Name</label>
            <input type="text" name="name" class="form-input" placeholder="Grace Hopper" required />
          </div>
          <div class="form-group" style="margin-bottom:16px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#a1a1aa;margin-bottom:6px;">Email Address</label>
            <input type="email" name="email" class="form-input" placeholder="developer@domain.com" required />
          </div>
          <div class="form-group" style="margin-bottom:24px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#a1a1aa;margin-bottom:6px;">Password</label>
            <input type="password" name="password" class="form-input" placeholder="Minimum 8 characters" required minlength="8" />
          </div>
          <button type="submit" class="btn btn-primary" style="width:100%;padding:11px;font-size:14px;margin-bottom:16px;">Create Account</button>
        </form>

        <div style="text-align:center;font-size:13px;color:#71717a;">
          Already registered? <a href="/login" onclick="event.preventDefault(); window.krix.nav('/login')" style="color:#ffffff;text-decoration:underline;">Sign In</a>
        </div>
      </div>
    </div>
  `;
}

function renderDashboardView() {
  const tab = state.currentPath.split('/')[2] || 'overview';
  return `
    <div style="display:flex;min-height:calc(100vh - 65px);">
      <!-- Sidebar -->
      <aside style="width:240px;background:#09090b;border-right:1px solid #1f1f23;padding:24px 16px;">
        <div style="font-size:11px;font-weight:700;color:#71717a;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px;padding-left:12px;">Control Center</div>
        <nav style="display:flex;flex-direction:column;gap:4px;">
          <a href="/dashboard" onclick="event.preventDefault(); window.krix.nav('/dashboard')" class="sidebar-item ${tab === 'overview' ? 'active' : ''}">Overview</a>
          <a href="/dashboard/keys" onclick="event.preventDefault(); window.krix.nav('/dashboard/keys')" class="sidebar-item ${tab === 'keys' ? 'active' : ''}">API Keys & Quotas</a>
          <a href="/dashboard/tools" onclick="event.preventDefault(); window.krix.nav('/dashboard/tools')" class="sidebar-item ${tab === 'tools' ? 'active' : ''}">Tool Policies</a>
          <a href="/dashboard/security" onclick="event.preventDefault(); window.krix.nav('/dashboard/security')" class="sidebar-item ${tab === 'security' ? 'active' : ''}">Security & 2FA</a>
          <a href="/dashboard/integrations" onclick="event.preventDefault(); window.krix.nav('/dashboard/integrations')" class="sidebar-item ${tab === 'integrations' ? 'active' : ''}">Integrations</a>
        </nav>
      </aside>

      <!-- Main Content Area -->
      <section style="flex:1;padding:36px 40px;background:#000000;overflow-y:auto;">
        ${tab === 'overview' ? renderDashboardOverview() : ''}
        ${tab === 'keys' ? renderDashboardKeys() : ''}
        ${tab === 'tools' ? renderDashboardTools() : ''}
        ${tab === 'security' ? renderDashboardSecurity() : ''}
        ${tab === 'integrations' ? renderDashboardIntegrations() : ''}
      </section>
    </div>
  `;
}

function renderDashboardOverview() {
  return `
    <div>
      <h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;margin-bottom:8px;">System Overview</h2>
      <p style="font-size:14px;color:#a1a1aa;margin-bottom:28px;">Real-time Model Context Protocol runtime telemetry and infrastructure status.</p>

      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:16px;margin-bottom:32px;">
        <div class="card">
          <div style="font-size:12.5px;color:#71717a;font-weight:600;margin-bottom:8px;">Active Security Tier</div>
          <div style="font-size:24px;font-weight:800;color:#10b981;">${state.user?.securityTier || 'STANDARD'}</div>
        </div>
        <div class="card">
          <div style="font-size:12.5px;color:#71717a;font-weight:600;margin-bottom:8px;">Active API Keys</div>
          <div style="font-size:24px;font-weight:800;color:#ffffff;">${state.keys?.length || 0} / 3</div>
        </div>
        <div class="card">
          <div style="font-size:12.5px;color:#71717a;font-weight:600;margin-bottom:8px;">Sandbox Runtime</div>
          <div style="font-size:24px;font-weight:800;color:#3b82f6;">Isolated No-Bwrap</div>
        </div>
      </div>
    </div>
  `;
}

function renderDashboardKeys() {
  return `
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
        <div>
          <h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;margin-bottom:6px;">API Keys & Quotas</h2>
          <p style="font-size:14px;color:#a1a1aa;">Manage custom MCP client keys (Max 3 keys per account).</p>
        </div>
        <button class="btn btn-primary" onclick="window.krix.showCreateKeyModal()">+ Create New Key</button>
      </div>

      <div id="keys-list" class="card" style="padding:0;overflow:hidden;">
        <div style="padding:16px 20px;border-bottom:1px solid #1f1f23;font-size:13px;font-weight:600;color:#71717a;display:grid;grid-template-columns:2fr 1.5fr 1fr 1fr 80px;">
          <div>Key Name</div>
          <div>Prefix</div>
          <div>Rate Limit</div>
          <div>Requests</div>
          <div>Action</div>
        </div>
        ${(state.keys || []).map(k => `
          <div style="padding:16px 20px;border-bottom:1px solid #1f1f23;font-size:13.5px;display:grid;grid-template-columns:2fr 1.5fr 1fr 1fr 80px;align-items:center;">
            <div style="font-weight:600;color:#ffffff;">${escapeHtml(k.name)}</div>
            <div><code>${escapeHtml(k.keyPrefix)}...</code></div>
            <div>${escapeHtml(String(k.rateLimitPerMin))} req/min</div>
            <div>${escapeHtml(String(k.totalRequests || 0))}</div>
            <div><button class="btn btn-secondary btn-sm" style="color:#ef4444;" onclick="window.krix.deleteKey('${escapeHtml(k.id)}')">Revoke</button></div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderDashboardTools() {
  return `
    <div>
      <h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;margin-bottom:6px;">Tool Policy Engine</h2>
      <p style="font-size:14px;color:#a1a1aa;margin-bottom:24px;">Toggle granular permissions across 60+ agentic tools.</p>
      <div class="card" style="padding:20px;">
        <p style="color:#a1a1aa;font-size:14px;">All 60+ tools across <code>core</code>, <code>github_issues_prs</code>, <code>github_admin</code>, <code>render</code>, and <code>sandbox</code> are synchronized with <code>config/allowedTools.json</code>.</p>
      </div>
    </div>
  `;
}

function renderDashboardSecurity() {
  return `
    <div>
      <h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;margin-bottom:6px;">Security Hardening & 2FA</h2>
      <p style="font-size:14px;color:#a1a1aa;margin-bottom:28px;">Configure operational tiers and two-factor authentication.</p>
      <div class="card" style="margin-bottom:24px;">
        <div style="font-weight:600;margin-bottom:12px;">Two-Factor Authentication (Google Authenticator)</div>
        <p style="font-size:13.5px;color:#a1a1aa;margin-bottom:16px;">Status: <strong>${state.user?.isTotpEnabled ? '✅ Enabled' : '❌ Disabled'}</strong></p>
        ${state.user?.isTotpEnabled ? `
          <button class="btn btn-secondary" onclick="window.krix.disable2FA()">Disable 2FA</button>
        ` : `
          <button class="btn btn-primary" onclick="window.krix.setup2FA()">Enable Google 2FA</button>
        `}
      </div>
    </div>
  `;
}

function renderDashboardIntegrations() {
  return `
    <div>
      <h2 style="font-size:24px;font-weight:700;letter-spacing:-0.03em;margin-bottom:6px;">Integration Vault</h2>
      <p style="font-size:14px;color:#a1a1aa;margin-bottom:28px;">Hardware-derived AES-256-GCM encrypted developer tokens.</p>
      <div class="card">
        <form onsubmit="window.krix.saveIntegrations(event)">
          <div class="form-group" style="margin-bottom:16px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#a1a1aa;margin-bottom:6px;">GitHub Personal Access Token (PAT)</label>
            <input type="password" name="githubPat" class="form-input" placeholder="ghp_... or github_pat_..." />
          </div>
          <div class="form-group" style="margin-bottom:24px;">
            <label style="display:block;font-size:12.5px;font-weight:600;color:#a1a1aa;margin-bottom:6px;">Render API Key</label>
            <input type="password" name="renderKey" class="form-input" placeholder="rnd_..." />
          </div>
          <button type="submit" class="btn btn-primary">Encrypt & Save Credentials</button>
        </form>
      </div>
    </div>
  `;
}

function renderDocsView() {
  return `
    <div style="max-width:800px;margin:0 auto;padding:60px 24px;">
      <h1 style="font-size:36px;font-weight:800;letter-spacing:-0.03em;margin-bottom:12px;">Documentation</h1>
      <p style="color:#a1a1aa;font-size:16px;margin-bottom:36px;">Connect your favorite AI agent to the Krix Enterprise Gateway.</p>
      <div class="card" style="margin-bottom:24px;">
        <h3 style="font-size:18px;margin-bottom:12px;">Streamable HTTP / SSE Endpoint</h3>
        <code style="background:#111;padding:8px 12px;border-radius:6px;display:block;">POST ${window.location.origin}/mcp</code>
      </div>
    </div>
  `;
}

function renderPolicyView() {
  return `
    <div style="max-width:800px;margin:0 auto;padding:60px 24px;">
      <h1 style="font-size:36px;font-weight:800;letter-spacing:-0.03em;margin-bottom:12px;">Privacy Policy & Terms</h1>
      <p style="color:#a1a1aa;font-size:14px;line-height:1.7;">Krix enforces strict Google OAuth Limited Use Compliance. Your user data is never sold, transferred, or used for model training.</p>
    </div>
  `;
}

function renderNotFoundView() {
  return `
    <div style="text-align:center;padding:120px 24px;">
      <h1 style="font-size:48px;font-weight:800;margin-bottom:12px;">404</h1>
      <p style="color:#a1a1aa;margin-bottom:24px;">The requested console view could not be located.</p>
      <a href="/" onclick="event.preventDefault(); window.krix.nav('/')" class="btn btn-primary">Return Home</a>
    </div>
  `;
}

function attachViewListeners() {}

// Global Client Actions
window.krix = {
  nav: navigate,
  toast: showToast,
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
        document.getElementById('totp-field').style.display = 'block';
        showToast('Please enter your 2FA code', 'info');
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
    await fetch('/api/auth/logout', { method: 'POST' });
    state.user = null;
    navigate('/');
  },
  showCreateKeyModal: async () => {
    const name = prompt('Enter a name for this API key:');
    if (!name) return;
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    if (res.ok) {
      alert(`API Key Created! Copy it now:\n\n${data.apiKey.rawKey}`);
      window.krix.loadKeys();
    } else {
      showToast(data.error || 'Key creation failed', 'error');
    }
  },
  deleteKey: async (id) => {
    if (!confirm('Are you sure you want to revoke this API key?')) return;
    const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Key revoked', 'success');
      window.krix.loadKeys();
    }
  },
  loadKeys: async () => {
    const res = await fetch('/api/keys');
    if (res.ok) {
      const data = await res.json();
      state.keys = data.keys;
      render();
    }
  },
  saveIntegrations: async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const body = Object.fromEntries(formData.entries());
    const res = await fetch('/api/settings/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) showToast('Credentials encrypted and saved!', 'success');
  },
  setup2FA: async () => {
    const res = await fetch('/api/auth/2fa/setup', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      const token = prompt(`Scan QR or enter key: ${data.secret}\n\nEnter 6-digit code:`);
      if (!token) return;
      const verifyRes = await fetch('/api/auth/2fa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      if (verifyRes.ok) {
        showToast('2FA Enabled!', 'success');
        await fetchMe();
        render();
      }
    }
  },
  disable2FA: async () => {
    const token = prompt('Enter 6-digit 2FA code to confirm:');
    if (!token) return;
    const res = await fetch('/api/auth/2fa/disable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    if (res.ok) {
      showToast('2FA Disabled', 'info');
      await fetchMe();
      render();
    }
  }
};

// Auto-boot router
fetchMe().then(() => {
  if (state.user && state.currentPath.startsWith('/dashboard')) {
    window.krix.loadKeys();
  }
  render();
});
