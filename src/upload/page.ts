// Self-contained HTML upload page served at GET /upload. No external assets.
// It POSTs the chosen file to /upload via fetch() (so it can set the auth
// header / send multipart). Auth modes:
//   - `?t=<signed token>` in the URL (Claude-minted link) → forwarded as a form
//     field; the page works with no setup. The server verifies the token and
//     passes `destination` so the page shows where the file will land, and
//     omits the folder fields (the link controls placement). An invalid/expired/
//     used link renders `linkError` instead of a form.
//   - otherwise → a long-lived bearer token entered once and kept in
//     localStorage (bookmarked-page use); the folder fields are shown.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif; margin: 0; padding: 1.25rem; max-width: 640px; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin: 0.75rem 0 0.25rem; }
  input[type=text], input[type=file] { width: 100%; box-sizing: border-box; padding: 0.6rem; font-size: 1rem; border: 1px solid #8884; border-radius: 8px; background: transparent; }
  button { margin-top: 1rem; padding: 0.7rem 1.2rem; font-size: 1rem; font-weight: 600; border: 0; border-radius: 8px; background: #6750f7; color: #fff; }
  button:disabled { opacity: 0.5; }
  .banner { margin: 0 0 1rem; padding: 0.7rem 0.9rem; border-radius: 8px; background: #6750f733; }
  .out { margin-top: 1.25rem; padding: 0.9rem; border-radius: 8px; background: #8881; white-space: pre-wrap; word-break: break-word; }
  .err { background: #f33a; }
  .muted { color: #8889; font-size: 0.85rem; }
  code { background: #8882; padding: 0.1rem 0.3rem; border-radius: 4px; }
</style>`;

export interface UploadPageOptions {
  /** When set (verified signed link), the exact path/folder the file lands in. */
  destination?: string;
  /** The target note the link is anchored to, if any. */
  targetNote?: string;
  /** When set, the link was invalid/expired/used — render a notice, no form. */
  linkError?: string;
  /**
   * Value for the file input's `accept` attribute, derived from the server's
   * extension allowlist (see `buildAcceptAttribute`). Omitted → the picker is
   * unrestricted (the server still enforces the allowlist). Never hardcode a
   * narrower list here: mobile browsers enforce `accept` and will grey out
   * allowed-but-unlisted types like `.pptx`.
   */
  accept?: string;
}

export function renderUploadPage(opts: UploadPageOptions = {}): string {
  if (opts.linkError) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload link unavailable</title>${STYLE}</head>
<body>
<h1>Upload to vault</h1>
<div class="banner err">This upload link is no longer usable (${escapeHtml(opts.linkError)}). Upload links expire and work only once — ask for a fresh link.</div>
</body></html>`;
  }

  const banner = opts.destination
    ? `<div class="banner">Uploading to <code>${escapeHtml(opts.destination)}</code>${
        opts.targetNote ? ` &middot; note <code>${escapeHtml(opts.targetNote)}</code>` : ""
      }</div>`
    : "";

  // A scoped link fixes the destination, so the folder inputs are hidden — the
  // user only chooses the file. The bare page keeps them editable.
  const fields = opts.destination
    ? ""
    : `  <label for="target_note">Target note <span class="muted">(optional — anchors the file's folder)</span></label>
  <input id="target_note" name="target_note" type="text" placeholder="Projects/Plan.md">
  <label for="subfolder">Subfolder <span class="muted">(optional)</span></label>
  <input id="subfolder" name="subfolder" type="text" placeholder="files">`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upload to vault</title>${STYLE}
</head>
<body>
<h1>Upload to vault</h1>
${banner}
<form id="f">
  <label for="file">File</label>
  <input id="file" name="file" type="file"${opts.accept ? ` accept="${escapeHtml(opts.accept)}"` : ""} required>
${fields}
  <button id="go" type="submit">Upload</button>
</form>
<div id="out" class="out" hidden></div>
<script>
  var params = new URLSearchParams(location.search);
  var linkToken = params.get('t');
  var multi = params.get('multi') === '1';
  var form = document.getElementById('f');
  var out = document.getElementById('out');
  var go = document.getElementById('go');
  var fileInput = document.getElementById('file');
  if (multi) fileInput.setAttribute('multiple', 'multiple');

  function show(text, isErr) {
    out.hidden = false;
    out.className = 'out' + (isErr ? ' err' : '');
    out.textContent = text;
  }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (!fileInput.files.length) { show('Pick a file first.', true); return; }
    var fd = new FormData();
    for (var i = 0; i < fileInput.files.length; i++) fd.append('file', fileInput.files[i]);
    var tnEl = document.getElementById('target_note');
    var sfEl = document.getElementById('subfolder');
    if (tnEl && tnEl.value.trim()) fd.append('target_note', tnEl.value.trim());
    if (sfEl && sfEl.value.trim()) fd.append('subfolder', sfEl.value.trim());

    var headers = {};
    if (linkToken) {
      fd.append('t', linkToken);
    } else {
      var tok = localStorage.getItem('obsv_upload_token');
      if (!tok) {
        tok = prompt('Enter your upload token (saved on this device):');
        if (tok) localStorage.setItem('obsv_upload_token', tok);
      }
      if (!tok) { show('An upload token is required.', true); return; }
      headers['Authorization'] = 'Bearer ' + tok;
    }

    go.disabled = true;
    show('Uploading…', false);
    try {
      var res = await fetch('/upload', { method: 'POST', headers: headers, body: fd });
      var json = await res.json();
      if (res.ok && json.ok) {
        var lines = (json.files || []).map(function (f) {
          return 'Stored: ' + f.path + '\\n  embed: ' + f.embed_markdown + '\\n  ' + f.content_type + ', ' + f.size + ' bytes';
        });
        show(lines.join('\\n\\n') || 'Uploaded.', false);
      } else {
        show('Upload failed: ' + (json.reason || res.status) + '\\n' + JSON.stringify(json), true);
      }
    } catch (err) {
      show('Network error: ' + err, true);
    } finally {
      go.disabled = false;
    }
  });
</script>
</body>
</html>`;
}
