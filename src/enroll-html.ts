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

export function landingPage(publicHost: string): string {
  const mcpUrl = `https://${publicHost}/mcp`;
  return `<!doctype html><html><head><meta charset="utf-8">
<title>Turno MCP</title><style>${baseCss}
  ol { padding-left: 1.2rem; }
  ol > li { margin-top: 1.2rem; }
  ol > li > strong { font-size: 1.05rem; }
  .step-body { margin-top: 0.4rem; }
  .pill { display: inline-block; padding: 0.5rem 1rem; background: #EF5B25;
          color: white; text-decoration: none; border-radius: 6px;
          font-weight: 600; }
  .tabs { margin-top: 0.6rem; border-bottom: 1px solid #ddd; }
  .tabs button { all: unset; cursor: pointer; padding: 0.4rem 0.8rem;
          font-size: 0.9rem; color: #555; border-bottom: 2px solid transparent;
          margin-right: 0.4rem; }
  .tabs button.active { color: #EF5B25; border-bottom-color: #EF5B25; }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }
</style></head><body>
<h1>Turno MCP</h1>
<p class="muted">A multi-tenant Model Context Protocol server for the
<a href="https://apidocs.turnoverbnb.com/">Turno (TurnoverBnB) v2 API</a>.
Lets any MCP-enabled assistant — Claude Desktop, claude.ai, Cursor, ChatGPT,
etc. — call all 49 Turno API tools on your behalf.</p>

<h2>Setup — 4 steps</h2>
<ol>
  <li>
    <strong>Get your Secret Key from Turno</strong>
    <div class="step-body">
      In the Turno dashboard, go to <em>API → Tokens → "Create New Token"</em>.
      The <strong>Secret Key</strong> is the long <code>eyJ…</code> JWT shown
      <strong>once</strong> on creation. Copy it before leaving the page.
    </div>
  </li>
  <li>
    <strong>Get your Partner ID</strong>
    <div class="step-body">
      Same page — scroll to the bottom for the line
      <em>"Here is your Partner ID:"</em> followed by a UUID. Copy that too.
      Both are required on every API call.
    </div>
  </li>
  <li>
    <strong>Enroll</strong>
    <div class="step-body">
      <a class="pill" href="/enroll">Open the enrollment form &rarr;</a>
      <p class="muted">You'll receive a one-time <code>trn_…</code> bearer
      token. The Secret Key is encrypted at rest with AES-256-GCM; the
      Partner ID is stored as plain UUID metadata.</p>
    </div>
  </li>
  <li>
    <strong>Wire the bearer into your MCP client</strong>
    <div class="step-body">
      Endpoint: <code>${escapeHtml(mcpUrl)}</code>
      <div class="tabs">
        <button class="active" data-tab="claudeai">claude.ai</button>
        <button data-tab="desktop">Claude Desktop</button>
        <button data-tab="claudecode">Claude Code</button>
        <button data-tab="cursor">Cursor</button>
        <button data-tab="curl">mcp-remote / curl</button>
      </div>
      <div class="tab-pane active" id="tab-claudeai">
        <p class="muted">Settings &rarr; Connectors &rarr; Add custom connector.
        Paste the URL with the bearer in the path:</p>
        <pre>${escapeHtml(mcpUrl)}?token=trn_YOUR_BEARER_HERE</pre>
        <p class="muted">(claude.ai's web UI doesn't expose custom headers, so
        the bearer rides as a <code>?token=</code> query param. The server
        accepts either form.)</p>
      </div>
      <div class="tab-pane" id="tab-desktop">
        <p class="muted">In <code>~/.claude_desktop_config.json</code> (Mac) or
        <code>%APPDATA%\\Claude\\claude_desktop_config.json</code> (Windows):</p>
        <pre>{
  "mcpServers": {
    "turno": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${escapeHtml(mcpUrl)}",
        "--header",
        "Authorization: Bearer trn_YOUR_BEARER_HERE"
      ]
    }
  }
}</pre>
      </div>
      <div class="tab-pane" id="tab-claudecode">
        <p class="muted">In <code>~/.claude/settings.json</code> under
        <code>mcpServers</code>:</p>
        <pre>"turno": {
  "type": "http",
  "url": "${escapeHtml(mcpUrl)}",
  "headers": {
    "Authorization": "Bearer trn_YOUR_BEARER_HERE"
  }
}</pre>
        <p class="muted">Restart Claude Code after saving.</p>
      </div>
      <div class="tab-pane" id="tab-cursor">
        <p class="muted">In <code>.cursor/mcp.json</code> at your project root
        (or <code>~/.cursor/mcp.json</code> globally):</p>
        <pre>{
  "mcpServers": {
    "turno": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "${escapeHtml(mcpUrl)}",
        "--header",
        "Authorization: Bearer trn_YOUR_BEARER_HERE"
      ]
    }
  }
}</pre>
      </div>
      <div class="tab-pane" id="tab-curl">
        <p class="muted">For testing or non-MCP-aware tooling:</p>
        <pre>npx mcp-remote ${escapeHtml(mcpUrl)} \\
  --header "Authorization: Bearer trn_YOUR_BEARER_HERE"</pre>
      </div>
    </div>
  </li>
</ol>

<h2>Status</h2>
<p class="muted">
  Endpoint: <a href="${escapeHtml(mcpUrl)}"><code>${escapeHtml(mcpUrl)}</code></a> ·
  Health: <a href="/health"><code>/health</code></a>
</p>

<script>
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'tab-' + target));
    });
  });
</script>
</body></html>`;
}

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
