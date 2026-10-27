// Zeron element picker. Injected only while the user annotates; the host
// polls `take(nonce)` for picks. The overlay lives in closed shadow roots with
// pointer-events disabled, so page styles and hit testing stay untouched.
//
// This runs in the page's own world, so everything it returns is page data:
// the host bounds, numbers and labels it as untrusted. Only real (trusted)
// input picks, and secrets the page shows in attributes or the URL are
// scrubbed before they leave.
(() => {
  if (window.__zeronAnnotator) return;
  const MAX_HTML = 2000, MAX_ATTRS = 12, MAX_VALUE = 120, MAX_TEXT = 200;
  const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr']);
  const SECRET = /pass|secret|token|api[-_]?key|auth|session|csrf|nonce|signature|credential/i;
  // Query and fragment keys that carry credentials (OAuth codes, signed URLs).
  const SECRET_PARAM = /pass|secret|token|key|auth|session|csrf|sig|code|state|credential|jwt|ticket/i;
  // Values that look like a credential whatever their attribute is called.
  const OPAQUE = /^(?:eyJ[\w-]+\.[\w-]+\.[\w-]*|[A-Za-z0-9+/_=-]{40,})$/;
  const URL_ATTRS = new Set(['href','src','action','formaction','poster','cite','data','ping']);
  const STYLES = ['display','position','width','height','margin','padding','gap','flex-direction',
    'justify-content','align-items','grid-template-columns','font-family','font-size','font-weight',
    'line-height','color','background-color','background-image','border','border-radius','box-shadow',
    'opacity','z-index','overflow'];
  const DEFAULTS = new Set(['none','normal','auto','0px','0px 0px','rgba(0, 0, 0, 0)','static','visible','1','0px none rgb(0, 0, 0)']);
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path stroke-linejoin="round" d="M14.86 16.5l-2.46-2.46-.75.75c-.77.77-1.16 1.15-1.57 1.06-.41-.09-.6-.6-.98-1.62L7.85 10.83c-.75-2.04-1.13-3.06-.6-3.59.52-.52 1.54-.15 3.58.6l3.4 1.26c1.02.38 1.53.56 1.62.98.09.41-.29.8-1.06 1.57l-.75.75 2.46 2.46c.25.25.38.38.44.52.08.19.08.4 0 .59-.06.14-.19.27-.44.52s-.38.38-.52.44a.78.78 0 0 1-.59 0c-.14-.06-.27-.19-.52-.44z"/><path d="M2 12c0-4.71 0-7.07 1.46-8.54C4.93 2 7.29 2 12 2s7.07 0 8.54 1.46C22 4.93 22 7.29 22 12s0 7.07-1.46 8.54C19.07 22 16.71 22 12 22s-7.07 0-8.54-1.46C2 19.07 2 16.71 2 12z"/></svg>';
  let state = 'idle', nonce = 0, picks = [], taken = 0, target = null, frame = 0, theme = {};
  let host = null, ui = null, marks = new Map(), seq = 0, layer = null, markFrame = 0, resizes = null, mutations = null;

  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const squash = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const scrubParams = (params) => {
    let changed = false;
    for (const key of [...params.keys()]) {
      if (SECRET_PARAM.test(key) || OPAQUE.test(params.get(key) || '')) { params.set(key, 'redacted'); changed = true; }
    }
    return changed;
  };
  // Credentials in a URL's userinfo, query or fragment read as `…`.
  const scrubUrl = (value) => {
    let url;
    try { url = new URL(value, location.href); } catch { return value; }
    if (!/^(https?|wss?):$/.test(url.protocol)) return value;
    url.username = ''; url.password = '';
    scrubParams(url.searchParams);
    if (url.hash.includes('=')) {
      const params = new URLSearchParams(url.hash.slice(1));
      if (scrubParams(params)) url.hash = params.toString();
    }
    return url.href;
  };
  const describe = (el) => {
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    for (const c of [...el.classList].slice(0, 3)) out += '.' + c;
    return out;
  };
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const selector = (el) => {
    if (el.id && unique('#' + esc(el.id))) return '#' + esc(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node !== el && node.id && unique('#' + esc(node.id))) { parts.unshift('#' + esc(node.id)); break; }
      let part = node.tagName.toLowerCase();
      const testid = node.getAttribute('data-testid');
      if (testid) part += `[data-testid="${testid.replace(/"/g, '\\"')}"]`;
      else part += [...node.classList].slice(0, 2).map((c) => '.' + esc(c)).join('');
      const parent = node.parentElement;
      if (parent && !testid) {
        const same = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      if (unique(parts.join(' > '))) break;
    }
    return parts.join(' > ');
  };
  const IMPLICIT = { a: 'link', button: 'button', img: 'img', nav: 'navigation', main: 'main', header: 'banner',
    footer: 'contentinfo', form: 'form', table: 'table', ul: 'list', ol: 'list', li: 'listitem', select: 'combobox',
    textarea: 'textbox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', article: 'article', section: 'region' };
  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const name = el.tagName.toLowerCase();
    if (name === 'input') return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider' })[el.type] || 'textbox';
    return IMPLICIT[name] || '';
  };
  const accessibleName = (el) => {
    const label = el.getAttribute('aria-label');
    if (label) return label;
    const by = el.getAttribute('aria-labelledby');
    if (by) return squash(by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' '));
    if (el.labels && el.labels.length) return squash(el.labels[0].innerText);
    const alt = el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder');
    if (alt) return alt;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? '' : clip(squash(el.innerText), 80);
  };
  const safeAttrs = (el) => {
    const out = [];
    for (const attr of [...el.attributes]) {
      if (out.length >= MAX_ATTRS) break;
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'value' || SECRET.test(name)) continue;
      if (name === 'style' && attr.value.length > MAX_VALUE) continue;
      let value = attr.value;
      if (URL_ATTRS.has(name)) value = scrubUrl(value);
      else if (OPAQUE.test(value.trim())) value = '…';
      out.push(`${name}="${clip(value, MAX_VALUE).replace(/"/g, '&quot;')}"`);
    }
    return out.length ? ' ' + out.join(' ') : '';
  };
  const sensitive = (el) => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  const render = (el, depth, lines, indent) => {
    const name = el.tagName.toLowerCase();
    const open = `<${name}${safeAttrs(el)}>`;
    if (VOID.has(name)) { lines.push(indent + open); return; }
    if (name === 'script' || name === 'style' || name === 'svg' && depth > 0) { lines.push(`${indent}${open}…</${name}>`); return; }
    const children = [...el.childNodes].filter((n) => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()));
    const elements = children.filter((n) => n.nodeType === 1);
    if (!elements.length) {
      const text = sensitive(el) ? '' : clip(squash(el.textContent), MAX_VALUE);
      lines.push(`${indent}${open}${text}</${name}>`);
      return;
    }
    if (depth >= 2) { lines.push(`${indent}${open}…</${name}>`); return; }
    lines.push(indent + open);
    let shown = 0;
    for (const child of children) {
      if (shown === 10) { lines.push(`${indent}  <!-- ${children.length - shown} more -->`); break; }
      if (child.nodeType === 3) lines.push(indent + '  ' + clip(squash(child.textContent), 80));
      else render(child, depth + 1, lines, indent + '  ');
      shown += 1;
    }
    lines.push(`${indent}</${name}>`);
  };
  const html = (el) => { const lines = []; render(el, 0, lines, ''); return clip(lines.join('\n'), MAX_HTML); };
  const styles = (el) => {
    const computed = getComputedStyle(el), out = [];
    for (const name of STYLES) {
      const value = computed.getPropertyValue(name).trim();
      if (!value || (name !== 'display' && DEFAULTS.has(value))) continue;
      out.push([name, clip(value, MAX_VALUE)]);
      if (out.length >= 20) break;
    }
    return out;
  };
  const capture = (el) => {
    const rect = el.getBoundingClientRect();
    const path = [];
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) path.unshift(describe(node));
    return {
      url: scrubUrl(location.href), title: document.title, element: describe(el), selector: selector(el),
      path: path.slice(-8), role: role(el), name: clip(squash(accessibleName(el)), 120),
      text: sensitive(el) ? '' : clip(squash(el.innerText || el.textContent), MAX_TEXT), html: html(el),
      rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      viewport: [innerWidth, innerHeight], styles: styles(el),
    };
  };

  // Shared look: Zeron's palette and UI font, handed over by the host.
  const vars = () => {
    const t = theme, on = contrast(t.accent || '#7c6cf2');
    return `:host{all:initial;--accent:${t.accent};--on-accent:${on};--surface:${t.surface};--border:${t.border};` +
      `--text:${t.text};--muted:${t.muted};--faint:${t.faint};--chip:${t.chip};` +
      `--shadow:${t.dark ? '0 8px 24px rgba(0,0,0,.45),0 1px 2px rgba(0,0,0,.3)' : '0 8px 24px rgba(15,20,30,.16),0 1px 2px rgba(15,20,30,.12)'};` +
      `--font:${JSON.stringify(t.font || 'system-ui')},system-ui,-apple-system,"Segoe UI",sans-serif}` +
      `*{box-sizing:border-box}`;
  };
  // Black or white text on the accent, whichever reads better.
  const contrast = (hex) => {
    const n = parseInt(hex.slice(1, 7), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b0d12' : '#ffffff';
  };
  const radius = (el) => {
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return Math.min(r, 16) + 'px';
  };
  const shadowHost = (tag, z, css) => {
    const node = document.createElement(tag);
    node.style.cssText = `position:fixed;inset:0;z-index:${z};pointer-events:none;`;
    const root = node.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${vars()}${css}</style>`;
    document.documentElement.appendChild(node);
    return [node, root];
  };
  const BADGE = '.badge{position:fixed;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--accent);color:var(--on-accent);' +
    'font:600 11px/18px var(--font);text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px var(--surface),var(--shadow)}';

  const mount = () => {
    let root;
    [host, root] = shadowHost('zeron-annotator', 2147483647, `
      .box{position:fixed;border:1.5px solid var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent);display:none;
        transition:left 70ms ease-out,top 70ms ease-out,width 70ms ease-out,height 70ms ease-out,border-radius 70ms ease-out}
      .tag{position:fixed;display:none;align-items:center;gap:6px;height:24px;padding:0 8px 0 4px;border-radius:7px;background:var(--surface);
        border:1px solid var(--border);box-shadow:var(--shadow);font:500 12px/1 var(--font);white-space:nowrap;max-width:min(60vw,420px);overflow:hidden}
      .tag .well{display:grid;place-items:center;width:18px;height:18px;border-radius:5px;background:var(--chip);color:var(--muted);flex:none}
      .tag .well svg{width:12px;height:12px}
      .tag .well.n{background:var(--accent);color:var(--on-accent);font:600 11px/1 var(--font);width:auto;min-width:18px;padding:0 4px}
      .tag .name{display:flex;min-width:0;overflow:hidden}
      .tag b{color:var(--text);font-weight:600;flex:none}
      .tag .cls{color:var(--muted);overflow:hidden;text-overflow:ellipsis}
      .tag .dim{color:var(--faint);font-variant-numeric:tabular-nums;flex:none}
      .hint{position:fixed;left:50%;bottom:16px;display:flex;align-items:center;gap:10px;height:34px;padding:0 12px 0 8px;border-radius:12px;
        background:color-mix(in srgb,var(--surface) 96%,transparent);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);
        border:1px solid var(--border);box-shadow:var(--shadow);font:500 12.5px/1 var(--font);color:var(--text);white-space:nowrap;
        transform:translate(-50%,0);opacity:1;transition:opacity 140ms ease-out,transform 140ms ease-out,top 140ms ease-out,bottom 140ms ease-out}
      .hint.enter{opacity:0;transform:translate(-50%,6px)}
      .hint.top{bottom:auto;top:16px}
      .hint .icon{display:grid;place-items:center;width:22px;height:22px;border-radius:6px;background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
      .hint .icon svg{width:14px;height:14px}
      .hint .sep{width:1px;height:14px;background:var(--border)}
      .hint .keys{display:flex;align-items:center;gap:6px;color:var(--muted);font-weight:400}
      .hint kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:5px;background:var(--chip);
        color:var(--text);font:500 11px/1 var(--font)}
      @media (prefers-reduced-motion:reduce){.box,.hint{transition:none}}
    `);
    root.innerHTML += `<div class="box"></div><div class="tag"></div>
      <div class="hint enter"><span class="icon">${ICON}</span><span class="title">Click an element to annotate</span><span class="sep"></span>
      <span class="keys"><kbd>⇧</kbd>Add more<kbd>Esc</kbd>Done</span></div>`;
    ui = { box: root.querySelector('.box'), tag: root.querySelector('.tag'), hint: root.querySelector('.hint'), title: root.querySelector('.title') };
    requestAnimationFrame(() => ui && ui.hint.classList.remove('enter'));
    const cursor = document.createElement('style');
    cursor.id = 'zeron-annotator-cursor';
    cursor.textContent = '*{cursor:crosshair!important}';
    document.documentElement.appendChild(cursor);
  };
  const markOf = (el) => { for (const m of marks.values()) if (m.el === el && m.n) return m.n; return 0; };
  const label = (el, r) => {
    const n = markOf(el);
    const name = el.tagName.toLowerCase();
    const rest = describe(el).slice(name.length);
    const well = n ? `<span class="well n">${n}</span>` : `<span class="well">${ICON}</span>`;
    ui.tag.innerHTML = `${well}<span class="name"><b></b><span class="cls"></span></span><span class="dim"></span>`;
    ui.tag.querySelector('b').textContent = name;
    ui.tag.querySelector('.cls').textContent = rest;
    ui.tag.querySelector('.dim').textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  };
  const paint = () => {
    frame = 0;
    if (!target || !ui) return;
    const r = target.getBoundingClientRect();
    Object.assign(ui.box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', borderRadius: radius(target) });
    label(target, r);
    ui.tag.style.display = 'flex';
    const h = 24, gap = 6;
    const above = r.top - h - gap;
    ui.tag.style.left = Math.max(6, Math.min(r.left, innerWidth - ui.tag.offsetWidth - 6)) + 'px';
    ui.tag.style.top = (above >= 6 ? above : Math.min(r.bottom + gap, innerHeight - h - 6)) + 'px';
    // Keep the hint off the element being pointed at.
    ui.hint.classList.toggle('top', r.bottom > innerHeight - 64 && r.top > 64);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el !== host && el !== layer && el !== document.documentElement ? el : null;
  };

  // Picked elements stay outlined with their number until their chip leaves
  // the draft. Repaints run only when something moves (scroll, resize,
  // layout or DOM changes), never on a timer.
  const paintMarks = () => {
    markFrame = 0;
    for (const mark of marks.values()) {
      const r = mark.el.isConnected ? mark.el.getBoundingClientRect() : null;
      const shown = r && r.width + r.height > 0 && r.bottom > 0 && r.top < innerHeight;
      mark.box.style.display = mark.badge.style.display = shown ? 'block' : 'none';
      if (!shown) continue;
      Object.assign(mark.box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      // The badge sits on the top-left corner but never leaves the viewport.
      const bw = mark.badge.offsetWidth || 18;
      mark.badge.style.left = Math.max(4, Math.min(r.left - 8, innerWidth - bw - 4)) + 'px';
      mark.badge.style.top = Math.max(4, Math.min(r.top - 8, innerHeight - 22)) + 'px';
    }
  };
  const scheduleMarks = () => { if (!markFrame) markFrame = requestAnimationFrame(paintMarks); };
  const watchMarks = (on) => {
    if (on && !layer) {
      let root;
      [layer, root] = shadowHost('zeron-annotations', 2147483646, `
        .mark{position:fixed;border:1.5px solid var(--accent);background:color-mix(in srgb,var(--accent) 6%,transparent);display:none}
        ${BADGE}
        .badge:empty{visibility:hidden}
        .mark.new{animation:settle 260ms ease-out}
        .badge.new{animation:pop 260ms cubic-bezier(.2,1.4,.4,1)}
        .mark.focus{background:color-mix(in srgb,var(--accent) 16%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}
        @keyframes settle{from{background:color-mix(in srgb,var(--accent) 28%,transparent)}}
        @keyframes pop{from{transform:scale(.4);opacity:0}}
        @media (prefers-reduced-motion:reduce){.mark.new,.badge.new{animation:none}}
      `);
      layer.root = root;
      resizes = new ResizeObserver(scheduleMarks);
      mutations = new MutationObserver(scheduleMarks);
      mutations.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      addEventListener('scroll', scheduleMarks, { capture: true, passive: true });
      addEventListener('resize', scheduleMarks, { passive: true });
    } else if (!on && layer) {
      resizes.disconnect(); mutations.disconnect();
      removeEventListener('scroll', scheduleMarks, { capture: true });
      removeEventListener('resize', scheduleMarks);
      if (markFrame) cancelAnimationFrame(markFrame);
      layer.remove();
      layer = resizes = mutations = null; markFrame = 0;
    }
  };
  const mark = (el) => {
    watchMarks(true);
    const box = document.createElement('div');
    box.className = 'mark new';
    box.style.borderRadius = radius(el);
    const badge = document.createElement('div');
    badge.className = 'badge';
    layer.root.append(box, badge);
    resizes.observe(el);
    marks.set(++seq, { el, box, badge, n: 0 });
    scheduleMarks();
    return seq;
  };
  const swallow = (e) => { if (state === 'active') { e.preventDefault(); e.stopImmediatePropagation(); } };
  // Synthetic events come from the page, not the user: they never pick.
  const onMove = (e) => { if (!e.isTrusted) return; const el = at(e.clientX, e.clientY); if (el && el !== target) { target = el; schedule(); } };
  const onClick = (e) => {
    swallow(e);
    if (!e.isTrusted) return;
    const el = at(e.clientX, e.clientY) || target;
    if (!el) return;
    picks.push({ ...capture(el), marker: mark(el) });
    if (!e.shiftKey) stop('done');
    else if (ui) ui.title.textContent = `${picks.length + taken} added · Click the last one`;
  };
  const onKey = (e) => { if (e.isTrusted && e.key === 'Escape') { swallow(e); stop('cancelled'); } };
  const LISTEN = [['mousemove', onMove], ['click', onClick], ['mousedown', swallow], ['mouseup', swallow],
    ['pointerdown', swallow], ['pointerup', swallow], ['auxclick', swallow], ['contextmenu', swallow], ['keydown', onKey],
    ['scroll', schedule], ['resize', schedule]];
  const stop = (next) => {
    if (state !== 'active') return;
    state = next;
    for (const [type, fn] of LISTEN) window.removeEventListener(type, fn, true);
    if (frame) cancelAnimationFrame(frame);
    host?.remove();
    document.getElementById('zeron-annotator-cursor')?.remove();
    host = ui = target = null;
  };
  const api = {
    start(id, palette) {
      stop('cancelled');
      nonce = id; picks = []; taken = 0; state = 'active'; theme = palette || {};
      mount();
      for (const [type, fn] of LISTEN) window.addEventListener(type, fn, true);
    },
    stop() { stop('cancelled'); },
    take(id) {
      if (id !== nonce) return null;
      const out = JSON.stringify({ state, picks });
      taken += picks.length;
      picks = [];
      return out;
    },
    label(id, n) {
      const found = marks.get(id);
      if (!found) return;
      found.n = n;
      found.badge.textContent = String(n);
      found.badge.classList.add('new');
      scheduleMarks();
    },
    keep(numbers) {
      for (const [id, found] of marks) {
        if (!numbers.includes(found.n)) { resizes.unobserve(found.el); found.box.remove(); found.badge.remove(); marks.delete(id); }
      }
      if (!marks.size) watchMarks(false);
    },
    // Hovering a chip in the composer points at its element.
    focus(n) {
      for (const found of marks.values()) found.box.classList.toggle('focus', found.n === n);
    },
  };
  // Fixed once defined, so a page cannot swap the picker out mid-session.
  Object.defineProperty(window, '__zeronAnnotator', { value: Object.freeze(api), configurable: false, writable: false });
})();
