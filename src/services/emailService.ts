import { google } from 'googleapis';
import { loadSettings } from '../config/settings.js';

interface SendMailParams {
  to: string;
  subject: string;
  htmlContent: string;
}

function getOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || 'https://developers.google.com/oauthplayground';
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

export const sendSecurityEmail = async ({ to, subject, htmlContent }: SendMailParams): Promise<boolean> => {
  const settings = loadSettings();
  if (!settings.email.alertsEnabled) {
    return false;
  }

  const oauth2Client = getOAuth2Client();
  const gmailUser = process.env.GMAIL_USER;

  if (!oauth2Client || !gmailUser) {
    console.log(`[Email] Gmail credentials not configured. Security notification simulated for ${to}: "${subject}"`);
    return false;
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    const messageParts = [
      `From: Krix Security Engine <${gmailUser}>`,
      `To: <${to}>`,
      `Subject: ${utf8Subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      htmlContent
    ];
    const message = messageParts.join('\n');
    const raw = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });

    console.log(`[Email] Security notification delivered to ${to}: "${subject}"`);
    return true;
  } catch (err: any) {
    console.error(`[Email] Failed delivery to ${to}:`, err?.message || err);
    return false;
  }
};

const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 100 100">
  <rect x="2" y="2" width="96" height="96" rx="22" fill="#000000" stroke="#27272a" stroke-width="2"/>
  <g transform="translate(50, 50) scale(0.28)" fill="#ffffff">
    <path d="M 0 -170 L 60 -65 L -40 -35 L -75 -100 C -60 -150 -30 -170 0 -170 Z" fill="#ffffff" />
    <path d="M 60 -65 L 140 -40 C 170 -10 160 35 125 55 L 25 15 Z" fill="#e4e4e7" />
    <path d="M 125 55 L 25 105 L 10 0 L 75 -40 C 115 -30 145 10 125 55 Z" fill="#d4d4d8" />
    <path d="M 25 105 L -55 150 C -95 170 -130 140 -135 100 L -65 15 Z" fill="#a1a1aa" />
    <path d="M -135 100 L -85 -10 L 30 0 L -15 75 C -55 100 -105 110 -135 100 Z" fill="#71717a" />
    <path d="M -85 -10 L -85 -110 C -75 -155 -30 -170 0 -170 L -40 -65 Z" fill="#52525b" />
    <polygon points="0,-40 35,20 -35,20" fill="#000000" stroke="#27272a" stroke-width="3" />
    <circle cx="0" cy="0" r="10" fill="#ffffff" />
  </g>
</svg>`;

const shell = ({ subtitle, body }: { subtitle: string; body: string }): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Krix Security Alert</title>
</head>
<body style="margin: 0; padding: 0; background-color: #09090b; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #ededed;">
  <div style="max-width: 580px; margin: 40px auto; background: #121215; border: 1px solid #27272a; border-radius: 12px; overflow: hidden;">
    <div style="padding: 24px 32px; border-bottom: 1px solid #27272a; display: flex; align-items: center; gap: 12px; background: #18181b;">
      ${logoSvg}
      <div>
        <div style="font-size: 16px; font-weight: 700; color: #ffffff;">Krix Enterprise</div>
        <div style="font-size: 12px; color: #a1a1aa;">${subtitle}</div>
      </div>
    </div>
    <div style="padding: 32px;">
      ${body}
    </div>
    <div style="padding: 16px 32px; background: #18181b; border-top: 1px solid #27272a; font-size: 12px; color: #71717a; text-align: center;">
      This is an automated security transmission from your Krix Enterprise Gateway.
    </div>
  </div>
</body>
</html>`;

export async function sendNewIpLoginAlert({
  email,
  name,
  ipAddress,
  userAgent,
  timestamp
}: {
  email: string;
  name: string;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
}): Promise<void> {
  const settings = loadSettings();
  if (!settings.email.alertOnNewIpLogin) return;

  const html = shell({
    subtitle: 'Security Alert: New IP Login Detected',
    body: `
      <h2 style="margin-top: 0; font-size: 18px; color: #ffffff;">Unfamiliar Sign-in Detected</h2>
      <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6;">
        Hello ${name || 'Developer'},<br><br>
        Your Krix Enterprise account was just accessed from a new IP address:
      </p>
      <div style="background: #09090b; border: 1px solid #27272a; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 13px; font-family: monospace;">
        <div><strong>IP Address:</strong> ${ipAddress}</div>
        <div><strong>Device / User-Agent:</strong> ${userAgent}</div>
        <div><strong>Timestamp:</strong> ${timestamp.toUTCString()}</div>
      </div>
      <p style="color: #a1a1aa; font-size: 14px;">
        If this was you, no action is needed. If you did not perform this login, please immediately revoke your API keys and update your credentials.
      </p>
    `
  });

  await sendSecurityEmail({
    to: email,
    subject: '⚠️ [Krix Security] New Sign-in from ' + ipAddress,
    htmlContent: html
  });
}

export async function sendApiKeyCreatedAlert({
  email,
  keyName,
  keyPrefix,
  ipAddress
}: {
  email: string;
  keyName: string;
  keyPrefix: string;
  ipAddress: string;
}): Promise<void> {
  const settings = loadSettings();
  if (!settings.email.alertOnApiKeyCreation) return;

  const html = shell({
    subtitle: 'Audit Alert: New API Key Issued',
    body: `
      <h2 style="margin-top: 0; font-size: 18px; color: #ffffff;">New MCP API Key Generated</h2>
      <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6;">
        A new Model Context Protocol API Key was issued for your account:
      </p>
      <div style="background: #09090b; border: 1px solid #27272a; border-radius: 8px; padding: 16px; margin: 20px 0; font-size: 13px; font-family: monospace;">
        <div><strong>Key Name:</strong> ${keyName}</div>
        <div><strong>Prefix:</strong> <code>${keyPrefix}...</code></div>
        <div><strong>Issued By IP:</strong> ${ipAddress}</div>
      </div>
    `
  });

  await sendSecurityEmail({
    to: email,
    subject: '🔑 [Krix Audit] New API Key Created: ' + keyName,
    htmlContent: html
  });
}
