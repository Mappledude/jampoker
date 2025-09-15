(function(){
  const MAX_EVENTS = 2000;
  const SIGNIFICANT_TYPES = new Set([
    'turn.snapshot',
    'hand.state.sub.ok',
    'hand.state.changed'
  ]);

  const bufferStore = {
    items: new Array(MAX_EVENTS),
    start: 0,
    length: 0,
  };

  const listeners = [];
  const handSnapshots = new Map();

  const meta = {
    projectId: '',
    build: 'dev',
    page: 'GLOBAL',
    uid: null,
    tableId: null,
    userAgent: navigator.userAgent,
    url: location.href,
  };

  let initialized = false;
  let panel, logBody, headerEl;

  function getDefaultTableId(){
    try {
      const params = new URLSearchParams(location.search);
      const id = params.get('id');
      return id || null;
    } catch (err) {
      console.warn('[jamlog] failed to derive tableId from URL', err);
      return null;
    }
  }

  meta.tableId = getDefaultTableId();

  function isDebug(){
    try {
      const params = new URLSearchParams(location.search);
      return params.get('debug') === '1' || localStorage.getItem('debug') === '1';
    } catch (err) {
      return false;
    }
  }

  function toNumber(val){
    if (val === null || val === undefined) return null;
    const num = typeof val === 'number' ? val : Number(val);
    return Number.isFinite(num) ? num : null;
  }

  function toSeatNumber(val){
    if (val === null || val === undefined) return null;
    if (typeof val === 'number' && Number.isInteger(val)) return val;
    if (typeof val === 'string' && /^-?\d+$/.test(val)) return Number(val);
    return null;
  }

  function normalizeCommits(commits){
    if (!commits || typeof commits !== 'object') return null;
    const out = {};
    Object.keys(commits).sort().forEach((key) => {
      const v = commits[key];
      const num = toNumber(v);
      if (num !== null) out[key] = num;
    });
    return Object.keys(out).length ? out : null;
  }

  function sumCommitValues(commits){
    if (!commits) return 0;
    return Object.values(commits).reduce((sum, v) => sum + (Number(v) || 0), 0);
  }

  function derivePot(commits, fallback){
    const street = sumCommitValues(commits);
    const hasFallback = typeof fallback === 'number' && Number.isFinite(fallback);
    if (!hasFallback && street === 0 && (fallback === null || fallback === undefined)) {
      return null;
    }
    const base = hasFallback ? Number(fallback) : 0;
    return base + street;
  }

  function normalizeStacksMap(raw){
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    Object.entries(raw).forEach(([key, value]) => {
      const idx = toSeatNumber(key);
      if (idx === null || idx < 0) return;
      if (value === undefined) {
        out[String(idx)] = null;
        return;
      }
      const cents = toNumber(value);
      out[String(idx)] = cents !== null ? cents : null;
    });
    return Object.keys(out).length ? out : null;
  }

  function normalizeWalletsMap(raw){
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    Object.keys(raw).forEach((key) => {
      if (!key) return;
      const value = raw[key];
      if (value === undefined) {
        out[key] = null;
        return;
      }
      const cents = toNumber(value);
      out[key] = cents !== null ? cents : null;
    });
    return Object.keys(out).length ? out : null;
  }

  function sanitizeContext(ctx){
    if (ctx === undefined) return {};
    if (ctx === null) return null;
    if (typeof ctx !== 'object') return ctx;
    const out = Array.isArray(ctx) ? [] : {};
    const entries = Array.isArray(ctx) ? ctx.entries() : Object.entries(ctx);
    for (const [key, value] of entries){
      const targetKey = Array.isArray(ctx) ? key : key;
      if (value === undefined) continue;
      if (typeof value === 'function') continue;
      if (value instanceof Date) {
        if (Array.isArray(ctx)) out.push(value.toISOString());
        else out[targetKey] = value.toISOString();
        continue;
      }
      if (value && typeof value.toDate === 'function') {
        try {
          const iso = value.toDate().toISOString();
          if (Array.isArray(ctx)) out.push(iso);
          else out[targetKey] = iso;
        } catch (err) {
          continue;
        }
        continue;
      }
      if (typeof value === 'bigint') {
        const safe = Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
        if (Array.isArray(ctx)) out.push(safe);
        else out[targetKey] = safe;
        continue;
      }
      if (value && typeof value === 'object') {
        try {
          const json = JSON.parse(JSON.stringify(value));
          if (Array.isArray(ctx)) out.push(json);
          else out[targetKey] = json;
        } catch (err) {
          if (Array.isArray(ctx)) out.push(null);
          else out[targetKey] = null;
        }
        continue;
      }
      if (Array.isArray(ctx)) out.push(value);
      else out[targetKey] = value;
    }
    return out;
  }

  function extractHandSnapshot(ctx){
    if (!ctx || typeof ctx !== 'object') return null;
    const candidate = (ctx.handState && typeof ctx.handState === 'object')
      ? ctx.handState
      : (ctx.state && typeof ctx.state === 'object')
        ? ctx.state
        : ctx;
    const commits = normalizeCommits(candidate.commits ?? ctx.commits ?? null);
    const potBankedRaw = toNumber(candidate.potCents ?? ctx.potCents ?? null);
    const potBankedCents = typeof potBankedRaw === 'number' && Number.isFinite(potBankedRaw) ? potBankedRaw : 0;
    const streetPotCents = sumCommitValues(commits);
    const stacks = normalizeStacksMap(candidate.stacks ?? ctx.stacks ?? null);
    const wallets = normalizeWalletsMap(candidate.wallets ?? ctx.wallets ?? null);
    const snapshot = {
      handNo: candidate.handNo ?? ctx.handNo ?? null,
      street: candidate.street ?? ctx.street ?? null,
      toActSeat: toSeatNumber(candidate.toActSeat ?? ctx.toActSeat ?? null),
      betToMatchCents: toNumber(candidate.betToMatchCents ?? ctx.betToMatchCents ?? null),
      potCents: derivePot(commits, potBankedRaw),
      potBankedCents,
      potDisplayCents: potBankedCents + streetPotCents,
      streetPotCents,
      commits,
      stacks,
      wallets,
    };
    const hasStacks = stacks && Object.keys(stacks).length > 0;
    const hasWallets = wallets && Object.keys(wallets).length > 0;
    const hasCommits = snapshot.commits && Object.keys(snapshot.commits).length > 0;
    const hasData = snapshot.handNo !== null || snapshot.street !== null || snapshot.toActSeat !== null ||
      snapshot.betToMatchCents !== null || snapshot.potCents !== null || hasCommits || hasStacks || hasWallets;
    return hasData ? snapshot : null;
  }

  function diffNumberMap(prev, next){
    const changes = {};
    const keys = new Set([
      ...Object.keys(prev || {}),
      ...Object.keys(next || {}),
    ]);
    let changed = false;
    keys.forEach((key) => {
      const before = toNumber(prev ? prev[key] : null);
      const after = toNumber(next ? next[key] : null);
      if (before !== after) {
        changed = true;
        changes[key] = { prev: before ?? null, next: after ?? null };
      }
    });
    return { changed, changes };
  }

  function diffCommits(prev, next){
    return diffNumberMap(prev, next);
  }

  function diffSnapshots(prev, next){
    if (!prev) {
      return { changed: true };
    }
    let changed = false;
    const details = {};
    ['handNo','street','toActSeat','betToMatchCents','potCents','potBankedCents','potDisplayCents','streetPotCents'].forEach((field) => {
      const before = prev[field] ?? null;
      const after = next[field] ?? null;
      if (before !== after) {
        changed = true;
        details[field] = { prev: before, next: after };
      }
    });
    const commitDiff = diffCommits(prev.commits, next.commits);
    if (commitDiff.changed) {
      changed = true;
      details.commits = commitDiff.changes;
    }
    const stackDiff = diffNumberMap(prev.stacks, next.stacks);
    if (stackDiff.changed) {
      changed = true;
      details.stacks = stackDiff.changes;
    }
    const walletDiff = diffNumberMap(prev.wallets, next.wallets);
    if (walletDiff.changed) {
      changed = true;
      details.wallets = walletDiff.changes;
    }
    return { changed, details };
  }

  function addToBuffer(evt){
    const index = (bufferStore.start + bufferStore.length) % MAX_EVENTS;
    bufferStore.items[index] = evt;
    if (bufferStore.length < MAX_EVENTS) {
      bufferStore.length += 1;
    } else {
      bufferStore.start = (bufferStore.start + 1) % MAX_EVENTS;
    }
  }

  function getEvents(){
    const events = [];
    for (let i = 0; i < bufferStore.length; i += 1) {
      const idx = (bufferStore.start + i) % MAX_EVENTS;
      const evt = bufferStore.items[idx];
      if (evt) events.push(evt);
    }
    return events;
  }

  function clear(){
    bufferStore.start = 0;
    bufferStore.length = 0;
    bufferStore.items.fill(undefined);
    handSnapshots.clear();
    if (logBody) logBody.innerHTML = '';
  }

  function onEvent(fn){
    if (typeof fn !== 'function') return;
    listeners.push(fn);
  }

  function notifyListeners(evt){
    listeners.forEach((fn) => {
      try { fn(evt); }
      catch (err) { console.warn('[jamlog] listener error', err); }
    });
  }

  function push(type, ctx){
    const tsISO = new Date().toISOString();
    const sanitizedCtx = sanitizeContext(ctx);
    const event = {
      tsISO,
      ts: tsISO,
      type,
      page: meta.page || 'GLOBAL',
      uid: meta.uid || null,
      tableId: meta.tableId || getDefaultTableId(),
      userAgent: meta.userAgent,
      build: meta.build,
      projectId: meta.projectId,
      ctx: sanitizedCtx,
    };
    if (SIGNIFICANT_TYPES.has(type)) {
      const snapshot = extractHandSnapshot(sanitizedCtx || {});
      if (snapshot) {
        const key = event.tableId || 'global';
        const prev = handSnapshots.get(key);
        const diff = diffSnapshots(prev, snapshot);
        if (!diff.changed) {
          if (event.ctx && typeof event.ctx === 'object') event.ctx.noop = true;
        } else if (event.ctx && typeof event.ctx === 'object' && diff.details && Object.keys(diff.details).length) {
          event.ctx.handDelta = diff.details;
        }
        handSnapshots.set(key, snapshot);
      }
    }
    addToBuffer(event);
    if (console && typeof console.debug === 'function') {
      console.debug('[jamlog]', event);
    }
    if (logBody) appendRow(event);
    notifyListeners(event);
    return event;
  }

  function updateMeta(partial){
    if (!partial || typeof partial !== 'object') return;
    if (partial.projectId) meta.projectId = partial.projectId;
    if (partial.build) meta.build = partial.build;
    if (partial.page) meta.page = partial.page;
    if (partial.uid !== undefined) meta.uid = partial.uid;
    if (partial.tableId !== undefined && partial.tableId !== null) meta.tableId = partial.tableId;
    if (partial.userAgent) meta.userAgent = partial.userAgent;
    if (partial.url) meta.url = partial.url;
  }

  function init(opts = {}){
    updateMeta({ url: location.href, userAgent: navigator.userAgent });
    updateMeta(opts);
    if (!meta.tableId) meta.tableId = getDefaultTableId();
    const firstInit = !initialized;
    initialized = true;
    if (firstInit) {
      if (isDebug()) createButton();
      push('app.start', { location: meta.url, ua: meta.userAgent });
    } else {
      updateHeader();
    }
  }

  function setUid(uid){
    meta.uid = uid || null;
    updateHeader();
  }

  function setTableId(tableId){
    meta.tableId = tableId || getDefaultTableId();
    updateHeader();
  }

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
      `- userAgent: ${data.meta.userAgent}`,
      `- timestamp: ${data.meta.timestamp}`,
      '',
      `## Recent Signals (last ${Math.min(30, data.events.length)})`
    ];
    data.events.slice(-30).forEach(e => {
      const ctxStr = e.ctx ? ` ${JSON.stringify(e.ctx)}` : '';
      lines.push(`${e.tsISO} · ${e.type}${ctxStr}`);
    });
    lines.push('', `## Full Log (last ${data.events.length})`, '```json', JSON.stringify(data.events, null, 2), '```', '');
    return lines.join('\n');
  }

  let button;
  function createButton(){
    if (button) return;
    button = document.createElement('div');
    button.textContent = '🐞 Debug';
    Object.assign(button.style, {
      position: 'fixed',
      bottom: '10px',
      right: '10px',
      background: '#0ea5e9',
      color: 'white',
      padding: '6px 10px',
      borderRadius: '8px',
      fontSize: '14px',
      cursor: 'pointer',
      zIndex: '9999',
    });
    button.addEventListener('click', openPanel);
    document.body.appendChild(button);
  }

  function openPanel(){
    if (panel) { panel.style.display = 'block'; updateHeader(); return; }
    panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      bottom: '0',
      right: '0',
      width: '360px',
      maxHeight: '70%',
      background: '#1f2937',
      color: '#f1f5f9',
      border: '1px solid #334155',
      borderRadius: '8px 0 0 0',
      display: 'flex',
      flexDirection: 'column',
      zIndex: '9999',
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      padding: '8px',
      borderBottom: '1px solid #334155',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
    });

    headerEl = document.createElement('div');
    headerEl.style.fontSize = '12px';
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
    Object.assign(logBody.style, {
      flex: '1',
      overflowY: 'auto',
      fontFamily: 'monospace',
      fontSize: '11px',
      padding: '8px',
    });

    panel.appendChild(header);
    panel.appendChild(logBody);
    document.body.appendChild(panel);
    getEvents().forEach(appendRow);
    updateHeader();
  }

  function appendRow(evt){
    if (!logBody || !evt) return;
    const line = document.createElement('div');
    const ctxStr = evt.ctx ? ' ' + JSON.stringify(evt.ctx) : '';
    line.textContent = `${evt.tsISO} ${evt.type}${ctxStr}`;
    logBody.appendChild(line);
    logBody.scrollTop = logBody.scrollHeight;
  }

  function updateHeader(){
    if (!headerEl) return;
    headerEl.textContent = `projectId=${meta.projectId} build=${meta.build} page=${meta.page} uid=${meta.uid || 'none'} tableId=${meta.tableId || 'none'}`;
  }

  onEvent(appendRow);

  let firestorePromise = null;
  async function getFirestore(){
    if (!firestorePromise) {
      firestorePromise = Promise.all([
        import('/common.js'),
        import('https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js'),
      ]).then(([common, firestore]) => ({
        db: common.db,
        doc: firestore.doc,
        getDoc: firestore.getDoc,
        collection: firestore.collection,
        query: firestore.query,
        orderBy: firestore.orderBy,
        limit: firestore.limit,
        getDocs: firestore.getDocs,
      })).catch((err) => {
        console.warn('[jamlog] firestore load failed', err);
        return null;
      });
    }
    return firestorePromise;
  }

  function timestampToISO(value){
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') return new Date(value).toISOString();
    if (value && typeof value.toDate === 'function') {
      try { return value.toDate().toISOString(); }
      catch (err) { return null; }
    }
    return null;
  }

  function buildHandLine(tableId, data, extras = {}){
    const stacksExtra = extras.stacks && typeof extras.stacks === 'object' ? extras.stacks : {};
    const seatUidsExtra = extras.seatUids && typeof extras.seatUids === 'object' ? extras.seatUids : {};
    const walletsExtra = extras.wallets && typeof extras.wallets === 'object' ? extras.wallets : null;
    if (!data) {
      const line = { section: 'hand', tableId, error: 'not-found' };
      if (Object.keys(stacksExtra).length > 0) line.stacks = { ...stacksExtra };
      if (Object.keys(seatUidsExtra).length > 0) line.seatUids = { ...seatUidsExtra };
      if (walletsExtra && Object.keys(walletsExtra).length > 0) line.wallets = { ...walletsExtra };
      return line;
    }
    const commits = normalizeCommits(data.commits || null);
    const potBankedRaw = toNumber(data.potCents ?? null);
    const potBankedCents = typeof potBankedRaw === 'number' && Number.isFinite(potBankedRaw) ? potBankedRaw : 0;
    const streetPotCents = sumCommitValues(commits);
    const line = {
      section: 'hand',
      tableId,
      handNo: data.handNo ?? null,
      street: data.street ?? null,
      toActSeat: toSeatNumber(data.toActSeat ?? null),
      betToMatchCents: toNumber(data.betToMatchCents ?? null),
      potCents: derivePot(commits, potBankedRaw),
      potBankedCents,
      potDisplayCents: potBankedCents + streetPotCents,
      streetPotCents,
      commits: commits || {},
      lastAggressorSeat: toSeatNumber(data.lastAggressorSeat ?? null),
      lastRaiseSizeCents: toNumber(data.lastRaiseSizeCents ?? null),
      lastRaiseToCents: toNumber(data.lastRaiseToCents ?? null),
      updatedAtISO: timestampToISO(data.updatedAt ?? data.updatedAtISO ?? null),
    };
    line.stacks = { ...stacksExtra };
    line.seatUids = { ...seatUidsExtra };
    if (walletsExtra && Object.keys(walletsExtra).length > 0) {
      line.wallets = { ...walletsExtra };
    }
    return line;
  }

  async function fetchHandSnapshot(tableId){
    const firestore = await getFirestore();
    if (!firestore || !firestore.db || !tableId) {
      return { section: 'hand', tableId: tableId || null, error: tableId ? 'firestore-unavailable' : 'missing-tableId' };
    }
    try {
      const handRef = firestore.doc(firestore.db, `tables/${tableId}/handState/current`);
      const seatsRef = firestore.collection(firestore.db, `tables/${tableId}/seats`);
      const seatsQuery = firestore.query(seatsRef, firestore.orderBy('seatIndex', 'asc'));
      const [handSnap, seatsSnap] = await Promise.all([
        firestore.getDoc(handRef),
        firestore.getDocs(seatsQuery),
      ]);
      const handData = handSnap.exists() ? handSnap.data() : null;
      const commits = handData ? normalizeCommits(handData.commits || null) : {};
      const seatIndexSet = new Set();
      const seatDocs = seatsSnap?.docs || [];
      seatDocs.forEach((docSnap, idx) => {
        const data = docSnap.data() || {};
        const seatIndex = toSeatNumber(data?.seatIndex ?? docSnap.id ?? idx);
        if (seatIndex !== null && seatIndex >= 0) seatIndexSet.add(seatIndex);
      });
      Object.keys(commits || {}).forEach((key) => {
        const seatIndex = toSeatNumber(key);
        if (seatIndex !== null && seatIndex >= 0) seatIndexSet.add(seatIndex);
      });
      const seatIndexList = Array.from(seatIndexSet.values()).sort((a, b) => a - b);
      const stacks = {};
      const seatUids = {};
      seatIndexList.forEach((idx) => {
        const key = String(idx);
        stacks[key] = null;
        seatUids[key] = null;
      });
      seatDocs.forEach((docSnap, idx) => {
        const data = docSnap.data() || {};
        const seatIndex = toSeatNumber(data?.seatIndex ?? docSnap.id ?? idx);
        if (seatIndex === null || seatIndex < 0) return;
        const key = String(seatIndex);
        const stackValue = toNumber(data?.stackCents ?? null);
        stacks[key] = stackValue !== null ? stackValue : null;
        const uidValue = typeof data?.occupiedBy === 'string' ? data.occupiedBy
          : typeof data?.uid === 'string' ? data.uid
          : null;
        seatUids[key] = uidValue ?? null;
      });
      let wallets = null;
      const walletUids = Array.from(new Set(Object.values(seatUids).filter((uid) => typeof uid === 'string' && uid)));
      if (walletUids.length > 0) {
        try {
          const walletSnaps = await Promise.all(walletUids.map((uid) => firestore.getDoc(firestore.doc(firestore.db, `users/${uid}`))));
          const walletMap = {};
          walletUids.forEach((uid, idx) => {
            const snap = walletSnaps[idx];
            if (!snap || !snap.exists()) {
              walletMap[uid] = null;
              return;
            }
            const data = snap.data() || {};
            const cents = toNumber(data?.walletCents ?? null);
            walletMap[uid] = cents !== null ? cents : null;
          });
          wallets = walletMap;
        } catch (err) {
          console.warn('[jamlog] wallet read failed', err);
        }
      }
      return buildHandLine(tableId, handData, {
        stacks,
        seatUids,
        wallets,
      });
    } catch (err) {
      console.warn('[jamlog] failed to read hand state', err);
      return { section: 'hand', tableId, error: err?.code || 'hand-read-failed', message: err?.message };
    }
  }

  async function fetchRecentActions(tableId){
    const firestore = await getFirestore();
    if (!firestore || !firestore.db || !tableId) {
      return { section: 'actions', tableId: tableId || null, items: [], error: tableId ? 'firestore-unavailable' : 'missing-tableId' };
    }
    try {
      const ref = firestore.collection(firestore.db, `tables/${tableId}/actions`);
      const q = firestore.query(ref, firestore.orderBy('createdAt', 'desc'), firestore.limit(10));
      const snap = await firestore.getDocs(q);
      const items = snap.docs.map((docSnap) => {
        const data = docSnap.data() || {};
        return {
          id: docSnap.id,
          createdAtISO: timestampToISO(data.createdAt ?? data.createdAtISO ?? null),
          type: data.type ?? null,
          seat: toSeatNumber(data.seat ?? null),
          handNo: data.handNo ?? null,
          amountCents: toNumber(data.amountCents ?? null),
          createdByUid: data.createdByUid ?? null,
          actorUid: data.actorUid ?? null,
          applied: data.applied ?? null,
          invalid: data.invalid ?? null,
          reason: data.reason ?? null,
        };
      });
      return { section: 'actions', tableId, items };
    } catch (err) {
      console.warn('[jamlog] failed to read recent actions', err);
      return { section: 'actions', tableId, items: [], error: err?.code || 'actions-read-failed', message: err?.message };
    }
  }

  function eventsForExport(raw){
    const events = getEvents();
    if (raw) return events;
    return events.filter((evt) => !(evt?.ctx && typeof evt.ctx === 'object' && evt.ctx.noop === true));
  }

  function chunkPacket(baseLines, eventLines){
    const MAX_SIZE = 400 * 1024;
    const headerTemplate = '=== JAMPOKER DEBUG PACKET v2 BEGIN 1/1 ===';
    const footerLine = '=== JAMPOKER DEBUG PACKET v2 END ===';

    function linesSize(lines){
      return lines.reduce((sum, line) => sum + line.length + 1, 0);
    }

    const baseSize = linesSize(baseLines) + headerTemplate.length + footerLine.length + 2;
    const slices = [];
    let current = [];
    let currentSize = baseSize;

    const flush = () => {
      if (current.length === 0 && slices.length > 0) return;
      slices.push(current);
      current = [];
      currentSize = baseSize;
    };

    if (eventLines.length === 0) {
      slices.push([]);
    } else {
      eventLines.forEach((line) => {
        const lineSize = line.length + 1;
        if (current.length > 0 && currentSize + lineSize > MAX_SIZE) {
          flush();
        }
        current.push(line);
        currentSize += lineSize;
      });
      if (current.length > 0) flush();
    }

    const total = slices.length;
    return slices.map((slice, index) => {
      const header = `=== JAMPOKER DEBUG PACKET v2 BEGIN ${index + 1}/${total} ===`;
      const lines = [header, ...baseLines, ...slice, footerLine];
      return lines.join('\n');
    });
  }

  async function exportPacket(options = {}){
    const { raw = false } = options || {};
    const tableId = meta.tableId || getDefaultTableId();
    const tsISO = new Date().toISOString();
    const metaLine = {
      section: 'meta',
      projectId: meta.projectId || window.__FIREBASE_PROJECT_ID__ || null,
      build: meta.build,
      page: meta.page,
      url: meta.url || location.href,
      userAgent: meta.userAgent,
      uid: meta.uid || null,
      tableId,
      tsISO,
    };

    const [handLine, actionsLine] = await Promise.all([
      fetchHandSnapshot(tableId),
      fetchRecentActions(tableId),
    ]);

    const baseLines = [
      JSON.stringify(metaLine),
      JSON.stringify(handLine),
      JSON.stringify(actionsLine),
    ];

    const eventLines = eventsForExport(raw).map((evt) => JSON.stringify({ section: 'event', ...evt }));
    const chunks = chunkPacket(baseLines, eventLines);
    return chunks.join('\n');
  }

  const jamlog = {
    init,
    push,
    exportJSON,
    exportMarkdown,
    clear,
    setUid,
    setTableId,
    onEvent,
    meta,
    export: exportPacket,
  };

  Object.defineProperty(jamlog, 'buffer', {
    get: () => getEvents(),
  });

  window.jamlog = jamlog;
})();
