<p align="center">
  <a href="https://github.com/imanki-t/Krix">
    <img src="https://raw.githubusercontent.com/imanki-t/Krix/live/public/logo.svg" alt="Krix Logo" width="130" height="130" />
  </a>
</p>

<h1 align="center">Krix</h1>

<p align="center">
  <strong>The Enterprise-Grade Model Context Protocol (MCP) Server, OAuth 2.1 Gateway, and Multi-Runtime Execution Sandbox for Autonomous AI Agents</strong>
</p>

<p align="center">
  <a href="https://github.com/imanki-t/Krix/blob/live/LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge" alt="License" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20.x%20%7C%2022.x-339933.svg?style=for-the-badge&logo=node.js&logoColor=white" alt="Node Version" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.x%20%7C%207.x-3178C6.svg?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://modelcontextprotocol.io/"><img src="https://img.shields.io/badge/MCP%20SDK-v1.30.0-7950F2.svg?style=for-the-badge" alt="MCP SDK" /></a>
  <a href="https://oauth.net/2.1/"><img src="https://img.shields.io/badge/OAuth-2.1%20%2B%20PKCE-black.svg?style=for-the-badge" alt="OAuth 2.1" /></a>
  <a href="https://github.com/imanki-t/Krix/tree/live"><img src="https://img.shields.io/badge/Security-10_Layer_Defense-059669.svg?style=for-the-badge" alt="Security Defense" /></a>
  <a href="https://render.com/"><img src="https://img.shields.io/badge/Deploy-Render-46E3B7.svg?style=for-the-badge&logo=render&logoColor=black" alt="Render Ready" /></a>
</p>

---

## ⚡ Overview

**Krix** is an enterprise-grade Model Context Protocol (MCP) server, OAuth 2.1 gateway, and multi-tier execution sandbox engineered to provide autonomous AI agents (Claude Desktop, Cursor, Gemini, and custom LLM agents) full, secure control over **GitHub repositories**, **Render Cloud infrastructure**, and **sandboxed code execution** with 10-layer defense-in-depth security.

---

## 🏛️ System Architecture

```
                                  ┌─────────────────────────────────────────┐
                                  │           Autonomous AI Hosts           │
                                  │ (Claude Desktop / Cursor / Gemini / UI) │
                                  └────────────────────┬────────────────────┘
                                                       │ (OAuth 2.1 PKCE / Bearer / x-api-key)
                                                       ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                          KRIX ENTERPRISE GATEWAY                                          │
├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│  [Layer 1] Helmet Security Headers            │  [Layer 6] Two-Factor Authentication (TOTP 2FA)           │
│  [Layer 2] CORS Cross-Origin Isolation        │  [Layer 7] MongoDB Mongoose + Resilient Memory Fallback   │
│  [Layer 3] Token-Bucket Multi-Tier Limiter    │  [Layer 8] AES-256-GCM Hardware-Derived Credential Vault  │
│  [Layer 4] Google reCAPTCHA v3 Bot Shield     │  [Layer 9] Gmail API Forensic Anomaly Alert Engine        │
│  [Layer 5] JWT Access & Refresh Rotation      │  [Layer 10] Dynamic Resource Quotas (Max 3 Keys / User)   │
└──────────────────────────────────────┬────────────────────────────────────┬───────────────────────────────┘
                                       │                                    │
                                       ▼                                    ▼
                     ┌──────────────────────────────────┐ ┌───────────────────────────────────┐
                     │    MCP Streamable HTTP / SSE     │ │    Minimalist Web Console & APIs   │
                     │             (/mcp)               │ │      (/, /dashboard, /oauth)      │
                     └─────────────────┬────────────────┘ └───────────────────────────────────┘
                                       │
               ┌───────────────────────┼────────────────────────┐
               ▼                       ▼                        ▼
      ┌─────────────────┐    ┌───────────────────┐    ┌───────────────────┐
      │  GitHub Engine  │    │   Render Cloud    │    │ Multi-Runtime Sbx │
      │ (Repos, PRs,    │    │ (Deploys, Logs,   │    │ (Python, Node, Go,│
      │  Issues, AST)   │    │  Metrics, DBs)    │    │  TS, C++, Java)   │
      └─────────────────┘    └───────────────────┘    └───────────────────┘
```

---

## 📜 Compliance & Policies

- **Privacy Policy & Terms**: See [policy.md](policy.md) for Google OAuth Limited Use Compliance and security policies.
- **Brand Assets**: Logos, vector icons, and favicon files are served from [`public/`](public/).

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE).
