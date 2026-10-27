# Security Policy

> This project was written largely with AI assistance and has not had an independent security audit. See [AI_DISCLOSURE.md](AI_DISCLOSURE.md).

## Supported versions

Only the latest release gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Use GitHub's **Report a vulnerability** button (Security › Advisories) on this repository instead. Include:
- what an attacker can do;
- the steps to reproduce;
- the SheetsToOBS version.

## How the app is designed to protect you

- The local server (`http://localhost:4587`) listens on `127.0.0.1` only, unless the experimental network dashboard is switched on.
- Requests from other websites are blocked (no CORS, Origin check), and so are DNS-rebinding Host headers.
- Pages are served with a strict Content-Security-Policy (`script-src 'self'`), and sheet content is escaped before display.
- `config.json` (API key, OBS password, Apps Script token) lives in your user data folder, not the program folder. Shared profile exports never contain the OBS password or Apps Script token. The Sheet ID and Google API key are only included when you tick "Include Sheet ID & Google API key".
- With the experimental network dashboard on, other devices need an access code, are throttled after repeated wrong codes, and can only reach the control-sheet endpoints.

## Your part

- **Google API key:** in the Google Cloud Console, restrict it to the Google Sheets API only.
- **OBS WebSocket:** enable authentication with a strong password, and don't expose port 4455 to the internet.
- **Sheet edit access:** anyone who can edit your sheet controls what appears on stream. Share edit access carefully.
- **Credentials:** never commit or send `config.json`. If you did, rotate the API key, the OBS password and the Apps Script token (`rotateControlToken()`).
- **Live screens:** use the show/hide toggles in Settings when your screen is captured.
