const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const baseCss = `
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 640px;
         margin: 3rem auto; padding: 0 1.5rem; color: #222; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; color: #555; font-weight: 500; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input, select, textarea { width: 100%; box-sizing: border-box; padding: 0.6rem;
         font-size: 1rem; border: 1px solid #ccc; border-radius: 6px; }
  button { margin-top: 1.5rem; padding: 0.7rem 1.2rem; font-size: 1rem;
         background: #EF5B25; color: white; border: 0; border-radius: 6px;
         cursor: pointer; }
  pre { background: #f5f5f5; padding: 1rem; border-radius: 6px; overflow-x: auto;
        font-size: 0.85rem; }
  .muted { color: #777; font-size: 0.9rem; }
  .err { background: #fee; color: #900; padding: 0.6rem 0.9rem;
         border-radius: 6px; margin-bottom: 1rem; }
  .ok { background: #efe; color: #050; padding: 0.6rem 0.9rem;
        border-radius: 6px; margin-bottom: 1rem; }
`;

export function enrollForm(err?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Turno MCP — enroll</title><style>${baseCss}</style></head><body>
<h1>Turno MCP enrollment</h1>
<p class="muted">Paste your Turno <strong>Secret Key</strong> (the JWT shown in
<em>Turno &gt; API &gt; Tokens &gt; Create New Token</em>). It's encrypted at rest
with AES-256-GCM and only decrypted in memory when the server makes API calls
on your behalf.</p>
${err ? `<div class="err">${escapeHtml(err)}</div>` : ""}
<form method="post" action="/enroll">
  <label for="label">Label <span class="muted">(a name for this tenant, e.g. your company)</span></label>
  <input id="label" name="label" required maxlength="100" autocomplete="organization">

  <label for="api_token">Secret Key <span class="muted">(the long <code>eyJ…</code> JWT from the Turno Tokens page)</span></label>
  <textarea id="api_token" name="api_token" required rows="4" autocomplete="off" spellcheck="false" style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:0.85rem"></textarea>

  <label for="partner_id">Partner ID <span class="muted">(required — UUID labeled "Here is your Partner ID:" at the bottom of the Turno Tokens page)</span></label>
  <input id="partner_id" name="partner_id" required pattern="[0-9a-fA-F-]{36}" autocomplete="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">

  <label for="base_url">Base URL</label>
  <select id="base_url" name="base_url">
    <option value="https://api.turnoverbnb.com/v2" selected>Production — https://api.turnoverbnb.com/v2</option>
    <option value="https://sandbox.turnoverbnb.com/v2">Sandbox — https://sandbox.turnoverbnb.com/v2</option>
  </select>

  <button type="submit">Create tenant &amp; issue bearer</button>
</form>
</body></html>`;
}

export function enrollSuccess(bearer: string, publicHost: string): string {
  const mcpUrl = `https://${publicHost}/mcp`;
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Turno MCP — enrolled</title><style>${baseCss}</style></head><body>
<h1>You're enrolled</h1>
<div class="ok">Save this bearer token now — it will not be shown again.</div>

<h2>Bearer token</h2>
<pre>${escapeHtml(bearer)}</pre>

<h2>MCP endpoint</h2>
<pre>${escapeHtml(mcpUrl)}</pre>

<h2>Wire up an MCP client</h2>
<p class="muted">Add an <code>mcp-remote</code> connection pointing at the MCP endpoint with this bearer in the <code>Authorization</code> header, e.g.:</p>
<pre>mcp-remote ${escapeHtml(mcpUrl)} --header "Authorization: Bearer ${escapeHtml(bearer)}"</pre>
</body></html>`;
}

export function enrollError(msg: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Turno MCP — error</title><style>${baseCss}</style></head><body>
<h1>Enrollment failed</h1>
<div class="err">${escapeHtml(msg)}</div>
<p><a href="/enroll">Try again</a></p>
</body></html>`;
}
