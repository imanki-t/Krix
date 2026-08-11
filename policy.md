# Privacy Policy and Terms of Service — Krix Enterprise

**Last Updated: August 2026**

## 1. Introduction & Scope
Krix ("we", "our", or "the Platform") provides an enterprise-grade Model Context Protocol (MCP) server gateway, execution sandbox, and developer API integration hub. This Policy outlines how we handle data, protect privacy, enforce security, and govern platform interactions when authenticating via Google Sign-In, utilizing developer tokens, or executing sandboxed tool operations.

---

## 2. Google OAuth & Account Authentication
When you sign in to Krix using **Google Sign-In** or connect your Google Account:
- **Data Accessed**: We request only standard basic profile information: your primary Google email address, verified account status, full name, and profile picture avatar.
- **Limited Use Policy**: We do **not** sell, rent, or transfer your Google user data to third parties. Data retrieved via Google APIs is strictly used to authenticate your session, personalize your dashboard, and deliver automated security alert transmissions.
- **Revocation**: You may disconnect your Google Account at any time via your [Google Account Permissions](https://myaccount.google.com/permissions) or through the Krix Security Dashboard.

---

## 3. Cryptographic Security & Vault Storage
- **Zero Plaintext Storage**: All external developer credentials (including GitHub Personal Access Tokens, Render API Keys, and TOTP 2FA Shared Secrets) are encrypted at rest using industry-standard **AES-256-GCM** authenticated encryption with hardware-derived keys.
- **API Key Hashing**: Custom Krix MCP API keys (`krix_live_...`) are hashed using cryptographic **SHA-256** prior to persistence. Secret keys are displayed to you only once upon generation.

---

## 4. Sandbox Isolation & Code Execution Policy
- **Isolated Ephemeral Environments**: Sandbox code execution (Python, Node.js, TypeScript, Bash, Go, Java, C++) runs inside isolated workspace directories with enforced memory quotas, execution timeouts, and automatic process termination.
- **Forbidden Operations**: The sandbox strictly blocks harmful system commands, root directory modifications, network sniffing, and unauthorized port bindings.

---

## 5. Security Alerts & Anomaly Forensics
To safeguard your account from unauthorized intrusions, Krix logs forensic session metadata (IP address and User-Agent device identifiers). If an unfamiliar IP address or device authenticates to your account, automated security alert emails are dispatched to your registered address via the Gmail API.

---

## 6. Data Retention & Account Deletion
You retain complete ownership over your account data. You may delete your API keys, wipe sandbox workspaces, or request complete account eradication at any time from the Settings Dashboard.

---

## 7. Contact & Support
For security inquiries, audit inquiries, or support, please contact the Krix Security Engineering Team or open an issue in the official repository.
