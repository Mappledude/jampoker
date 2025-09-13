(function(){
  const maxEvents = 300;
  const buffer = [];
  const listeners = [];
  const meta = { projectId: '', build: 'dev', page: 'GLOBAL', uid: null, tableId: null, ua: navigator.userAgent, url: location.href };
  let active = false;

  function isDebug(){
    const params = new URLSearchParams(location.search);
    return params.get('debug') === '1' || localStorage.getItem('debug') === '1';
  }

  function sanitizeCtx(ctx){
    if (!ctx || typeof ctx !== 'object') return ctx;
    const out = {};
    for (const k in ctx){
      const v = ctx[k];
      if (v === null || v === undefined) continue;
      const t = Array.isArray(v) ? 'array' : typeof v;
      out[k] = t === 'object' ? 'object' : t;
    }
    return out;
  }

  function push(type, ctx){
    if (!active) return;
    const evt = { ts: new Date().toISOString(), page: meta.page || 'GLOBAL', type, uid: meta.uid, tableId: meta.tableId };
    if (ctx) evt.ctx = ctx;
    buffer.push(evt);
    if (buffer.length > maxEvents) buffer.shift();
    listeners.forEach(fn => fn(evt));
  }

  function init(opts){
    if (active || !isDebug()) return;
    active = true;
    meta.projectId = opts.projectId || '';
    meta.build = opts.build || 'dev';
    meta.page = opts.page || 'GLOBAL';
    if (opts.uid) meta.uid = opts.uid;
    createButton();
    push('app.start', { location: meta.url, ua: meta.ua });
    updateHeader();
  }

  function setUid(uid){ meta.uid = uid; updateHeader(); }
  function setTableId(tid){ meta.tableId = tid; }
  function getEvents(){ return buffer.slice(); }
  function clear(){ buffer.length = 0; if (logBody) logBody.innerHTML = ''; }

  function exportJSON(){
    return { meta: { ...meta, timestamp: new Date().toISOString() }, events: getEvents() };
  }

  function exportMarkdown(){
    const data = exportJSON();
    const lines = [
      '# JamPoker Debug Report',
      `- projectId: ${data.meta.projectId}`,
      `- build: ${data.meta.build}`,
      `- page: ${data.meta.page}`,
      `- url: ${data.meta.url}`,
      `- uid: ${data.meta.uid || 'none'}`,
      `- userAgent: ${data.meta.ua}`,
      `- timestamp: ${data.meta.timestamp}`,
      '',
      '## Recent Signals (last 30)'
    ];
    data.events.slice(-30).forEach(e => {
      const snippet = e.ctx && (e.ctx.code || e.ctx.message) ? ` ${[e.ctx.code, e.ctx.message].filter(Boolean).join(' ')}` : '';
      lines.push(`${e.ts} · ${e.type}${snippet}`);
    });
    lines.push('', '## Full Log (last 300)', '```json', JSON.stringify(data.events, null, 2), '```', '');
    return lines.join('\n');
  }

  function onEvent(fn){ listeners.push(fn); }

  // ---- UI ----
  let button, panel, logBody, headerEl;
  function createButton(){
    button = document.createElement('div');
    button.textContent = '🐞 Debug';
    button.style.position = 'fixed';
    button.style.bottom = '10px';
    button.style.right = '10px';
    button.style.background = '#0ea5e9';
    button.style.color = 'white';
    button.style.padding = '6px 10px';
    button.style.borderRadius = '8px';
    button.style.fontSize = '14px';
    button.style.cursor = 'pointer';
    button.style.zIndex = '9999';
    button.addEventListener('click', openPanel);
    document.body.appendChild(button);
  }

  function openPanel(){
    if (panel) { panel.style.display = 'block'; return; }
    panel = document.createElement('div');
    panel.style.position = 'fixed';
    panel.style.bottom = '0';
    panel.style.right = '0';
    panel.style.width = '360px';
    panel.style.maxHeight = '70%';
    panel.style.background = '#1f2937';
    panel.style.color = '#f1f5f9';
    panel.style.border = '1px solid #334155';
    panel.style.borderRadius = '8px 0 0 0';
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.zIndex = '9999';

    const header = document.createElement('div');
    header.style.padding = '8px';
    header.style.borderBottom = '1px solid #334155';
    header.style.display = 'flex';
    header.style.flexDirection = 'column';
    headerEl = document.createElement('div');
    headerEl.style.fontSize = '12px';
    headerEl.style.marginBottom = '6px';
    header.appendChild(headerEl);

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap = '6px';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy Report';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(exportMarkdown());
    });
    const dlBtn = document.createElement('button');
    dlBtn.textContent = 'Download JSON';
    dlBtn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(exportJSON(), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'jamlog.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const clrBtn = document.createElement('button');
    clrBtn.textContent = 'Clear';
    clrBtn.addEventListener('click', () => clear());
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(dlBtn);
    btnRow.appendChild(clrBtn);
    header.appendChild(btnRow);

    logBody = document.createElement('div');
    logBody.style.flex = '1';
    logBody.style.overflowY = 'auto';
    logBody.style.fontFamily = 'monospace';
    logBody.style.fontSize = '11px';
    logBody.style.padding = '8px';

    panel.appendChild(header);
    panel.appendChild(logBody);
    document.body.appendChild(panel);
    getEvents().forEach(appendRow);
  }

  function appendRow(evt){
    if (!logBody) return;
    const line = document.createElement('div');
    const ctxStr = evt.ctx ? ' ' + JSON.stringify(evt.ctx) : '';
    line.textContent = `${evt.ts} ${evt.type}${ctxStr}`;
    logBody.appendChild(line);
    logBody.scrollTop = logBody.scrollHeight;
  }

  function updateHeader(){
    if (!headerEl) return;
    headerEl.textContent = `projectId=${meta.projectId} build=${meta.build} page=${meta.page} uid=${meta.uid || 'none'}`;
  }

  onEvent(appendRow);

  window.jamlog = { init, push, exportJSON, exportMarkdown, clear, setUid, setTableId, onEvent, meta };
})();
