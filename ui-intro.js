/* MetaRoom3D — interactive software intro.
   Timeline: crest video plays big & centred -> camera zooms out while Frame 24
   (window + wordmark) is revealed outward from the crest -> hold on Frame 24 ->
   crossfade into a clickable replica of the software UI. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var sec = $('ui-intro'); if (!sec) return;
  var stage = $('uiStage'), cam = $('uiCam'), vid = $('uiCrest'), f24 = $('uiF24'),
      ring = $('uiRing'), bg = $('uiBg'), win = $('uiWin'), cap = $('uiCap'), tip = $('uiTip'), tt = $('uiTT'),
      skip = $('uiSkip'), replay = $('uiReplay');

  var FX = 0.272, FY = 0.382;                 // crest centre inside Frame 24 (fractions)
  var S0 = 2.3;                               // starting zoom
  var BASE = 3300;                            // opening clip plays first (~3.9s), crest starts at BASE
  var ZOOM_AT = BASE + 3800, ZOOM_DUR = 2400, // ms on the timeline
      REV_AT = BASE + 4200, REV_DUR = 2400,
      VFADE_AT = BASE + 5200, VFADE_DUR = 1000,
      HOLD_UNTIL = BASE + 7800;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var clamp = function (x) { return Math.max(0, Math.min(1, x)); };
  var easeIO = function (x) { return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
  var easeO = function (x) { return 1 - Math.pow(1 - x, 3); };

  /* ---------- intro animation ---------- */
  var raf = 0, t0 = 0, live = false, started = false, crestOn = false;

  function setCam(e) {
    var s = S0 - (S0 - 1) * e, qx = .5 + (FX - .5) * e, qy = .5 + (FY - .5) * e;
    cam.style.transform = 'translate(' + ((qx - s * FX) * 100) + '%,' + ((qy - s * FY) * 100) + '%) scale(' + s + ')';
  }
  function setReveal(p) {
    var W = stage.clientWidth, H = stage.clientHeight || W * 849 / 2000;
    var f = W * 0.11, R = Math.hypot(Math.max(FX, 1 - FX) * W, Math.max(FY, 1 - FY) * H) + f + 40;
    var r = easeO(p) * R;
    f24.style.setProperty('--f', f + 'px');
    f24.style.setProperty('--r', r + 'px');
    ring.style.width = ring.style.height = (2 * r) + 'px';
    ring.style.opacity = p > 0 && p < 1 ? (1 - p) * .9 : 0;
  }
  function resetIntro() {
    setCam(0); setReveal(0); vid.style.opacity = 0; bg.style.opacity = 1; crestOn = false;
    try { vid.currentTime = 0; bg.currentTime = 0; } catch (e) {}
  }
  function tick() {
    var t = performance.now() - t0;
    setCam(easeIO(clamp((t - ZOOM_AT) / ZOOM_DUR)));
    setReveal(clamp((t - REV_AT) / REV_DUR));
    if (!crestOn && t >= BASE) { crestOn = true; var q = vid.play(); if (q && q.catch) q.catch(function () {}); }
    vid.style.opacity = clamp((t - BASE) / 600) * (1 - clamp((t - VFADE_AT) / VFADE_DUR));
    bg.style.opacity = 1 - clamp((t - (BASE - 200)) / 700);
    if (t >= HOLD_UNTIL) { goLive(); return; }
    raf = requestAnimationFrame(tick);
  }
  function start() {
    cancelAnimationFrame(raf);
    started = true; live = false;
    stage.classList.remove('is-live');
    resetIntro();
    setCaption('');
    skip.hidden = false; replay.hidden = true;
    var p = bg.play(); if (p && p.catch) p.catch(function () {});
    t0 = performance.now();
    raf = requestAnimationFrame(tick);
  }
  function goLive() {
    cancelAnimationFrame(raf);
    live = true;
    setCam(1); setReveal(1); vid.style.opacity = 0; vid.pause(); bg.pause();
    stage.classList.add('is-live');
    skip.hidden = true; replay.hidden = false;
    resetUI();
  }

  /* ---------- interactive UI ---------- */
  var st = { view: 'ws', built: false, loaded: false, selected: false, toolsSeen: false, leveled: false }, tipTimer = 0, ttTimer = 0;

  /* flow: open folder -> details -> pick a panorama -> Panorama Room Editor -> Build -> explore tools */
  function nextTarget() {
    switch (st.view) {
      case 'folder': return 'select';
      case 'details': return 'ok';
      case 'editor': return st.leveled ? 'build' : 'level';
      default:
        if (st.built) return st.toolsSeen ? '' : 'tools';
        if (!st.loaded) return 'open';
        return st.selected ? 'editor' : 'thumb';
    }
  }
  var CAPS = {
    open: 'Step 1 \u2014 click the glowing Open Panorama Folder button (top-left of the toolbar).',
    select: 'Step 2 \u2014 panoramas loaded. Click the glowing panorama in the list to select it.',
    editor: 'Step 3 \u2014 panorama selected. Now click Panorama Room Editor.',
    folder: 'Pick the folder that holds your equirectangular panoramas, then click Select Folder.',
    details: 'Capture details are set once for the whole house. Click OK.',
    level: 'Step 4 \u2014 the panorama leans (Roll +10.3\u00b0). Click the glowing Click-to-level button to straighten it.',
    build: 'Panorama levelled and the layout is detected. Hover Align, Roll and Tilt if you like, then click the glowing Build button.',
    tools: 'Room built! Hover (or tap) the tools on the left: Move, Rotate, Fast Move, Stitch Face, Ceiling Reference, plus AI Align, Auto Build, Match Ceilings and Auto Hotspots.',
    done: 'Every tool is one hover away. Open the folder or the editor again to keep exploring.'
  };
  function setCaption(k) { cap.textContent = k ? (CAPS[k] || k) : ''; }

  function render() {
    win.dataset.view = st.view;
    win.dataset.built = st.built ? '1' : '0';
    win.dataset.sel = st.selected ? '1' : '0';
    win.dataset.lvl = st.leveled ? '1' : '0';
    var n = nextTarget();
    Array.prototype.forEach.call(win.querySelectorAll('.hs'), function (b) {
      b.classList.toggle('is-next', !!n && (b.dataset.id === n || b.dataset.group === n));
    });
    var k;
    if (st.view !== 'ws') k = st.view === 'editor' ? (st.leveled ? 'build' : 'level') : st.view;
    else if (st.built) k = st.toolsSeen ? 'done' : 'tools';
    else if (!st.loaded) k = 'open';
    else k = st.selected ? 'editor' : 'select';
    setCaption(k);
  }
  function resetUI() {
    st = { view: 'ws', built: false, loaded: false, selected: false, toolsSeen: false, leveled: false };
    hideTT(); clearActive(); render();
  }

  function showTip(msg) {
    tip.textContent = msg; tip.classList.add('show');
    clearTimeout(tipTimer); tipTimer = setTimeout(function () { tip.classList.remove('show'); }, 2600);
  }

  /* ---- tooltip that points at the hovered / tapped tool ---- */
  function showTT(el, hold) {
    tt.textContent = '';
    var b = document.createElement('b'), d = document.createElement('span');
    if (el.dataset.ttIcon) {
      var ic = document.createElement('img'); ic.className = 'ui-tt-ic'; ic.src = el.dataset.ttIcon; ic.alt = ''; b.appendChild(ic);
    }
    b.appendChild(document.createTextNode(el.dataset.ttTitle || '')); d.textContent = el.dataset.tt || '';
    tt.appendChild(b); tt.appendChild(d);
    if (el.dataset.ttImg) {
      var im = document.createElement('img'); im.className = 'ui-tt-img'; im.src = el.dataset.ttImg; im.alt = ''; tt.appendChild(im);
    }
    tt.classList.toggle('has-img', !!el.dataset.ttImg);
    var w = win.getBoundingClientRect(), r = el.getBoundingClientRect(), tw = tt.offsetWidth, th = tt.offsetHeight;
    var x = r.left - w.left + r.width / 2 - tw / 2;
    x = Math.max(8, Math.min(x, w.width - tw - 8));
    var y = r.bottom - w.top + 10;
    if (y + th > w.height - 8) y = r.top - w.top - th - 10;   /* no room below -> show above (editor toolbar) */
    y = Math.max(8, y);
    tt.style.left = x + 'px';
    tt.style.top = y + 'px';
    tt.classList.add('show');
    clearTimeout(ttTimer);
    if (hold) ttTimer = setTimeout(hideTT, 5000);
    if (el.dataset.group === 'tools' && !st.toolsSeen) { st.toolsSeen = true; render(); }
  }
  function hideTT() { clearTimeout(ttTimer); tt.classList.remove('show'); }
  function clearActive() {
    Array.prototype.forEach.call(win.querySelectorAll('.hs.is-active'), function (b) { b.classList.remove('is-active'); });
  }

  function act(a, el) {
    switch (a) {
      case 'open': st.view = 'folder'; break;
      case 'select': st.view = 'details'; break;
      case 'ok': st.loaded = true; st.selected = false; st.built = false; st.toolsSeen = false; clearActive(); st.view = 'ws'; break;
      case 'thumb':
        if (!st.loaded) { showTip('Open a panorama folder first (top-left button).'); return; }
        if (el.dataset.pick !== '1') { showTip('For this demo, pick \u201cPrimary Bathroom\u201d (the glowing one).'); return; }
        st.selected = true; break;
      case 'editor':
        if (!st.loaded) { showTip('Open a panorama folder first (top-left button).'); return; }
        if (!st.selected) { showTip('Select a panorama from the list first.'); return; }
        st.leveled = false; st.view = 'editor'; break;
      case 'level': st.leveled = true; break;
      case 'build':
        if (!st.leveled) { showTip('Level the panorama first: click Click-to-level (glowing).'); return; }
        st.built = true; st.toolsSeen = false; clearActive(); st.view = 'ws'; break;
      case 'dismiss': st.view = 'ws'; break;
      case 'tool':
        clearActive(); el.classList.add('is-active'); showTT(el, true); return;
      case 'field': showTT(el, true); return;
      case 'tip': showTip(el.dataset.tip); return;
    }
    tip.classList.remove('show'); hideTT();
    render();
    /* phones: the window is wider than the screen, so bring dialogs into view */
    var sc = stage.parentNode;
    if (sc.scrollWidth > sc.clientWidth + 4 && sc.scrollTo)
      sc.scrollTo({ left: st.view === 'ws' ? 0 : (sc.scrollWidth - sc.clientWidth) / 2, behavior: 'smooth' });
  }
  win.addEventListener('mouseover', function (e) { var b = e.target.closest('[data-tt]'); if (b && win.contains(b)) showTT(b); });
  win.addEventListener('mouseout', function (e) { var b = e.target.closest('[data-tt]'); if (b && !b.contains(e.relatedTarget)) hideTT(); });
  win.addEventListener('focusin', function (e) { var b = e.target.closest('[data-tt]'); if (b) showTT(b); });
  win.addEventListener('focusout', hideTT);
  win.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (b && win.contains(b)) act(b.dataset.act, b);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && live && st.view !== 'ws') act('dismiss');
  });

  /* ---------- controls + trigger ---------- */
  skip.addEventListener('click', function () { if (!live) goLive(); });
  stage.addEventListener('click', function () { if (started && !live) goLive(); });
  replay.addEventListener('click', start);
  window.addEventListener('resize', function () { if (live) { setCam(1); setReveal(1); } });

  setCam(0); setReveal(0);
  if (reduce) { f24.style.setProperty('--r', '9999px'); goLive(); return; }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      if (es[0].isIntersecting && !started) { io.disconnect(); start(); }
    }, { threshold: 0.35 });
    io.observe(stage);
  } else { start(); }
})();
