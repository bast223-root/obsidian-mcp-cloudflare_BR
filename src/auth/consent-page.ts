export function renderConsent(opts: { error?: string; clientName: string; oauthReqInfo: string }): string {
  const err = opts.error ? `<p class="err">${opts.error}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorize MCP</title>
<style>body{font-family:system-ui;max-width:420px;margin:4rem auto;padding:1rem}
form{display:flex;flex-direction:column;gap:0.5rem}.err{color:#b00}</style></head>
<body><h1>Authorize ${opts.clientName}</h1>
<p>Grant access to your Obsidian vault.</p>${err}
<form method="POST">
<input type="hidden" name="oauthReqInfo" value="${opts.oauthReqInfo}">
<label>Password<input type="password" name="password" autofocus required></label>
<button type="submit">Authorize</button>
</form></body></html>`;
}
