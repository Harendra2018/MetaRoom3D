// ---------------------------------------------------------------------------
// video-hotspot.js — YouTube panels anchored inside the panorama
//
// WHY THIS ISN'T A THREE.JS TEXTURE
// A YouTube iframe cannot be read into a WebGL texture. The player is
// cross-origin and DRM-protected, so drawing it to a canvas taints that
// canvas and texImage2D throws a SecurityError. (A self-hosted .mp4 CAN be
// used as a THREE.VideoTexture -- see createVideoPanel() at the bottom.)
//
// So the iframe is placed with CSS3DRenderer instead: a second, transparent
// DOM layer sitting over the WebGL canvas, driven by the SAME camera object.
// Because it shares the camera, FOV zoom, drag-look and every other camera
// change stay in sync automatically -- there is no per-frame math to keep
// the two in step, and no drift.
//
// TRADE-OFF: CSS3D content cannot be occluded by WebGL geometry. Inside a
// photo sphere nothing is in front of the panorama, so this doesn't matter
// here. It would matter in the dollhouse view, which is why show()/hide()
// are wired to panoramaActive below.
//
// three r163 (matches the import map in index.html).
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/examples/jsm/renderers/CSS3DRenderer.js';

/**
 * Convert the same phi/theta/radius used by hotspot-config.js into a world
 * position. Mirrors the x/z sign handling in HotspotManager.createPanoramaHotspots
 * (the photo sphere is scaled -1 on x, so the textbook formula is mirrored).
 */
export function sphericalToWorld(radius, phi, theta) {
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
    -radius * Math.sin(phi) * Math.sin(theta)
  );
}

// ---------------------------------------------------------------------------
// YouTube IFrame API loader (shared across every panel; the script + the
// window.onYouTubeIframeAPIReady callback are both singletons).
//
// WHY WE NEED THIS AT ALL
// YouTube's native player chrome (play button, mute icon, scrub bar) lives
// INSIDE a cross-origin iframe. Chrome renders cross-origin iframes as a
// separate process (an "OOPIF"), and when that iframe sits inside a
// CSS-3D-transformed ancestor -- which CSS3DObject always is, because of the
// perspective matrix3d() chain CSS3DRenderer builds -- Chrome's hit-testing
// only approximates the transform for OOPIFs rather than solving it exactly.
// Large targets (click-anywhere-to-toggle-play) land close enough to often
// register; small precise ones (the scrub bar, the mute icon) usually don't.
// There's no CSS fix: it's a hit-testing gap in how the browser maps a 2D
// click back through a 3D transform into another process's iframe.
//
// The IFrame API sidesteps the problem entirely: player.play()/pause()/
// mute()/seekTo() talk to the iframe over postMessage, which doesn't need
// the click to land anywhere in particular. So controls=0 turns off
// YouTube's own (unreliable-to-click) chrome, and addYouTube() below draws
// its own play/mute/seek buttons as plain same-document DOM elements --
// which, unlike OOPIF content, DO hit-test correctly under a 3D transform,
// because that hit-testing happens entirely within one process/document.
// ---------------------------------------------------------------------------
let _ytApiPromise = null;
function loadYouTubeIframeAPI() {
  if (_ytApiPromise) return _ytApiPromise;
  _ytApiPromise = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) { resolve(window.YT); return; }
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevReady === 'function') prevReady();
      resolve(window.YT);
    };

    // If this never fires, the request for the script itself failed --
    // most commonly an ad blocker or privacy extension blocking
    // www.youtube.com/iframe_api specifically (note: this is the plain
    // youtube.com domain, a DIFFERENT host from the youtube-nocookie.com
    // the embeds use, so it gets blocked independently of whether the
    // video itself plays).
    let settled = false;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Request for https://www.youtube.com/iframe_api failed to load (network error or blocked by an extension).'));
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      document.head.appendChild(tag);
    }

    // Belt-and-braces: some blockers silently drop the request (no
    // network error event at all) rather than rejecting it outright, so
    // onerror alone isn't reliable -- fall back to a timeout.
    window.setTimeout(() => {
      if (settled || (window.YT && window.YT.Player)) return;
      settled = true;
      reject(new Error(
        'https://www.youtube.com/iframe_api did not become ready within 6s. ' +
        'This is almost always an ad blocker, tracking-protection list, or ' +
        'browser privacy mode blocking that script (it is on the youtube.com ' +
        'domain, separate from the youtube-nocookie.com domain the video embed ' +
        'itself uses, so the video can play fine while this stays blocked). ' +
        'Check the Network tab for a blocked/failed request to youtube.com/iframe_api.'
      ));
    }, 6000);
  });
  return _ytApiPromise;
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class VideoHotspotManager {
  /**
   * @param {HTMLElement}            container  same element the WebGLRenderer is in
   * @param {THREE.PerspectiveCamera} camera    the viewer's active camera
   */
  constructor(container, camera) {
    this.camera = camera;
    this.panels = [];
    this.scene = new THREE.Scene();

    // Global mute state, applied to every panel (present and future) until
    // toggled again. Starts true because addYouTube()'s autoplay path always
    // starts muted (browsers block unmuted autoplay) -- this just keeps the
    // manager's own idea of "current state" consistent with that from the
    // first frame, instead of finding out only once a player reports in.
    this.muted = true;
    this._muteListeners = [];

    // container is document.body in main.js, which reports clientHeight 0 when
    // the WebGL canvas is absolutely positioned -- the same trap initScene()
    // already guards against with `|| window.innerHeight`. Without the same
    // fallback here, the CSS3D layer is created at zero height and renders
    // nothing, while the iframe inside it loads and runs normally -- so the
    // console stays clean and it just looks like the video never appeared.
    this.renderer = new CSS3DRenderer();
    this.renderer.setSize(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight
    );

    // Sits over the WebGL canvas. pointerEvents none on the layer, auto on
    // the panels themselves, so dragging the panorama still works everywhere
    // except directly on a video.
    Object.assign(this.renderer.domElement.style, {
      position: 'fixed',   // not 'absolute': body may not be a positioned ancestor
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: '1',
    });
    container.appendChild(this.renderer.domElement);
    this.container = container;

    // ------------------------------------------------------------------
    // FLAT 2D CONTROL LAYER
    //
    // Nothing interactive lives inside the CSS3D layer any more. Chrome's
    // hit-testing through a matrix3d chain into a cross-origin iframe's
    // process is unreliable, and how unreliable depends on how far the
    // panel is rotated away from screen-parallel -- which is what made the
    // buttons work only inside a narrow theta window.
    //
    // So the controls are ordinary, untransformed, absolutely-positioned
    // DOM in this layer instead. Every frame we project the panel's four
    // corners with the same camera and move the controls to match (see
    // _updateHud). Hit-testing is then plain 2D and exact at any angle.
    //
    // zIndex 15 puts it over the WebGL canvas (1) and the CSS3D layer (1)
    // but under the viewer's own UI -- carousel, header, buttons all sit
    // at 20+ in styles.css and must stay clickable on top of a video.
    // ------------------------------------------------------------------
    this.hudLayer = document.createElement('div');
    Object.assign(this.hudLayer.style, {
      position: 'fixed',
      top: '0', left: '0', width: '100%', height: '100%',
      pointerEvents: 'none',
      zIndex: '15',
    });
    container.appendChild(this.hudLayer);

    this._onResize = () => {
      this.renderer.setSize(
        container.clientWidth || window.innerWidth,
        container.clientHeight || window.innerHeight
      );
    };
    window.addEventListener('resize', this._onResize);
  }

  /**
   * Register a callback fired with the new muted boolean whenever mute
   * state changes -- from setMuted()/toggleMuted() directly, or indirectly
   * via a panel's own in-panel mute button (_attachCustomControls keeps
   * this.muted in sync with whichever button the visitor actually clicked).
   * Used by panorama.js to keep an external toggle button's icon in sync.
   */
  onMuteChange(callback) {
    this._muteListeners.push(callback);
  }

  _notifyMuteChange() {
    for (const cb of this._muteListeners) cb(this.muted);
  }

  /**
   * Mute or unmute every panel's player. Applies immediately to players
   * that already exist; players that become ready later (addYouTube() is
   * async -- see loadYouTubeIframeAPI) pick up the current value of
   * this.muted in their onReady handler, so a toggle made before a video
   * finishes loading still takes effect once it does.
   */
  setMuted(muted) {
    this.muted = muted;
    for (const p of this.panels) {
      const player = p.userData.player;
      if (player) {
        if (muted) player.mute(); else player.unMute();
      }
      if (typeof p.userData._syncMuteIcon === 'function') p.userData._syncMuteIcon(muted);
    }
    this._notifyMuteChange();
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /**
   * Anchor a YouTube video in the panorama.
   *
   * @param {object} cfg
   * @param {string} cfg.videoId          e.g. 'dQw4w9WgXcQ'
   * @param {number} cfg.radius           same units as your hotspot config
   * @param {number} cfg.phi
   * @param {number} cfg.theta
   * @param {number} [cfg.width=520]      panel width in world units
   * @param {number} [cfg.aspect=16/9]
   * @param {boolean}[cfg.autoplay=true]  autoplay requires mute -- see below
   * @param {boolean}[cfg.loop=true]
   * @param {number} [cfg.yawDeg=0]       horizontal swivel (yaw), around the
   *        vertical axis -- like a door hinge. Turns the panel to face
   *        partway into a corner instead of straight at the camera. Try one
   *        sign, check with .debug(), flip if backwards.
   * @param {number} [cfg.tiltDeg=0]      vertical tilt (pitch). Positive
   *        leans the top of the panel back/away from you (screen mounted
   *        high, angled down); negative leans it toward you (mounted low,
   *        angled up). Try one sign, check with .debug(), flip if backwards.
   * @param {number} [cfg.rollDeg=0]      in-plane tilt (roll), for screens
   *        that are level with the camera but crooked
   * @param {boolean}[cfg.customControls=true]  draw our own play/mute/seek
   *        bar and drive playback via the IFrame API instead of YouTube's
   *        native controls. Leave this on unless you've confirmed native
   *        controls are actually clickable for your panel's angle -- see
   *        the loadYouTubeIframeAPI() comment above for why they usually
   *        aren't once the panel has any real rotation.
   * @returns {CSS3DObject}
   */
  addYouTube(cfg) {
    const width = cfg.width ?? 520;
    const aspect = cfg.aspect ?? 16 / 9;
    const height = width / aspect;
    const customControls = cfg.customControls !== false;

    // CSS3D works in CSS pixels, so build the iframe at a comfortable pixel
    // size and scale it down into world units. Rendering at ~2x the world
    // size keeps text in the video crisp when the user zooms in.
    const pxW = 960;
    const pxH = Math.round(pxW / aspect);
    const scale = width / pxW;

    const autoplay = cfg.autoplay !== false;
    const loop = cfg.loop !== false;
    const panelId = `mr3d-video-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // Browsers only permit autoplay when muted -- an unmuted autoplay is
    // blocked and the panel would sit on a frozen poster frame.
    const params = new URLSearchParams({
      autoplay: autoplay ? '1' : '0',
      mute: autoplay ? '1' : '0',
      controls: customControls ? '0' : '1',
      rel: '0',
      playsinline: '1',
      modestbranding: '1',
      enablejsapi: '1',
      // Without this, captions can come on by default -- either because
      // the video's uploader set that as the default, or because the
      // visitor's browser previously had captions on for some other
      // embed (YouTube remembers that preference per-browser, not
      // per-video). '0' forces them off unless customControls is off and
      // the visitor turns them on manually via YouTube's own CC button.
      cc_load_policy: '0',
      origin: window.location.origin,
      ...(loop ? { loop: '1', playlist: cfg.videoId } : {}),
    });

    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      width: `${pxW}px`,
      height: `${pxH}px`,
      // With customControls the whole CSS3D panel is display-only: every
      // click is handled by the flat HUD layer instead (see the constructor
      // and _updateHud). Taking the panel out of hit-testing entirely is
      // what makes this work at any theta -- nothing interactive is left
      // behind a matrix3d transform for Chrome to approximate.
      pointerEvents: customControls ? 'none' : 'auto',
      background: '#000',
      border: '3px solid rgba(47,107,255,.85)',
      borderRadius: '6px',
      overflow: 'hidden',
      boxShadow: '0 0 60px rgba(47,107,255,.45)',
      position: 'relative',
    });

    const iframe = document.createElement('iframe');
    iframe.id = panelId;
    iframe.src = `https://www.youtube-nocookie.com/embed/${cfg.videoId}?${params}`;
    // POINTER EVENTS: OFF when we draw our own controls.
    //
    // This is the fix for "the buttons only respond at some thetas". The
    // iframe is cross-origin, so Chrome runs it as an out-of-process frame
    // and registers a compositor hit-test region for it. When an OOPIF sits
    // under a CSS-3D transform, the compositor only APPROXIMATES that
    // transform; if it can't resolve a click confidently it hands the whole
    // region to the iframe's process, and our same-document control bar --
    // even though it paints on top -- never sees the event. How far off the
    // approximation is depends on how strongly the panel is rotated relative
    // to the screen, which is why it looked angle-dependent: near the
    // camera's default facing the panel is close to screen-parallel and the
    // fast path resolves; swing theta round and it stops.
    //
    // pointer-events:none removes the iframe from hit-testing altogether, so
    // the region belongs to this document and normal (exact) same-document
    // hit-testing applies at every angle. We lose nothing: with
    // customControls the iframe is driven over postMessage by the IFrame
    // API, never by clicks. The catch() fallback below turns this back to
    // 'auto' if we end up on YouTube's native chrome after all.
    iframe.style.cssText =
      'width:100%;height:100%;border:0;display:block;' +
      (customControls ? 'pointer-events:none;' : '');
    iframe.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    wrap.appendChild(iframe);

    const obj = new CSS3DObject(wrap);
    obj.position.copy(sphericalToWorld(cfg.radius, cfg.phi, cfg.theta));
    obj.scale.setScalar(scale);

    // Face the camera at the origin, then apply any yaw/tilt/roll on top of
    // that. yawDeg is horizontal swivel (vertical/Y axis) -- turns the
    // panel like a door hinge, e.g. to angle it into a corner. tiltDeg is
    // pitch (local X axis) -- leans the TOP of the panel back (positive) or
    // forward toward the viewer (negative), for screens mounted above or
    // below eye level that aren't perpendicular to the view. rollDeg is
    // in-plane rotation (local Z axis), for screens that are level-with-
    // the-camera but crooked, like a picture frame hung slightly off.
    // Order matters: yaw, then tilt, then roll, so each later rotation
    // twists around the panel's own already-rotated face rather than the
    // original world axes.
    obj.lookAt(0, 0, 0);
    if (cfg.yawDeg) obj.rotateY(THREE.MathUtils.degToRad(cfg.yawDeg));
    if (cfg.tiltDeg) obj.rotateX(THREE.MathUtils.degToRad(cfg.tiltDeg));
    if (cfg.rollDeg) obj.rotateZ(THREE.MathUtils.degToRad(cfg.rollDeg));

    obj.userData.cfg = cfg;
    obj.userData.player = null;
    // Half-extents in the object's LOCAL space, used by _updateHud to
    // project the panel's four corners into screen pixels. The element is
    // pxW x pxH and CSS3DObject centres it on the object's origin, so the
    // corners are (+-pxW/2, +-pxH/2, 0); obj.scale carries them into world
    // units.
    obj.userData.halfW = pxW / 2;
    obj.userData.halfH = pxH / 2;
    this.scene.add(obj);
    this.panels.push(obj);

    // CSS3DRenderer only inserts a panel's DOM element into the live
    // document lazily, inside its own render() call -- scene.add() alone
    // doesn't do it. main.js only calls our render() from its animation
    // loop, on the frame after this returns. That's normally invisible,
    // EXCEPT: new YT.Player(panelId) below needs the target element to
    // already be in the live DOM, or it fails to bind at all (no error --
    // onReady just never fires, silently). The first video on a page
    // always has enough of a head start (loadYouTubeIframeAPI has to fetch
    // and parse a script over the network) that an animation frame -- and
    // therefore our render() -- happens first, so it works. Every video
    // after that hits _ytApiPromise already resolved, so its .then()
    // fires as a microtask BEFORE the next animation frame, i.e. before
    // the element is in the DOM at all -- which is exactly why this only
    // ever breaks on the second+ video (e.g. leaving a video panorama and
    // coming back). Rendering once here, synchronously, guarantees the
    // element exists no matter how the API promise resolves.
    this.renderer.render(this.scene, this.camera);

    if (customControls) this._attachCustomControls(obj, wrap, panelId, loop);

    return obj;
  }

  /**
   * Build a play/pause button, mute button and click-to-seek bar for one
   * panel, as plain untransformed DOM in the HUD layer, plus a transparent
   * "hit quad" clipped to the panel's projected outline so clicking the
   * video itself still toggles playback. _updateHud() moves both to follow
   * the panel every frame.
   */
  _attachCustomControls(obj, wrap, panelId, loop) {
    const hud = document.createElement('div');
    Object.assign(hud.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'none', display: 'none',
    });

    // Transparent overlay clipped (clip-path) to the panel's four projected
    // corners. clip-path clips hit-testing as well as painting, so this
    // catches clicks over the video and nowhere else -- dragging to look
    // around still works everywhere outside the panel.
    const quad = document.createElement('div');
    Object.assign(quad.style, {
      position: 'absolute', left: '0', top: '0', width: '100%', height: '100%',
      pointerEvents: 'auto', cursor: 'pointer', background: 'transparent',
    });

    const bar = document.createElement('div');
    Object.assign(bar.style, {
      position: 'absolute',
      display: 'flex', alignItems: 'center', gap: '10px',
      padding: '8px 12px',
      boxSizing: 'border-box',
      background: 'linear-gradient(transparent, rgba(0,0,0,.75) 60%)',
      opacity: '0', transition: 'opacity .15s ease',
      font: '600 20px/1 Arial, sans-serif', color: '#fff',
      pointerEvents: 'auto',
      transform: 'translateY(-100%)',   // sit on the panel's bottom edge
    });

    let hoverTimer = null;
    const showBar = () => {
      bar.style.opacity = '1';
      if (hoverTimer) window.clearTimeout(hoverTimer);
      hoverTimer = null;
    };
    const hideBarSoon = () => {
      if (hoverTimer) window.clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => { bar.style.opacity = '0'; }, 400);
    };
    quad.addEventListener('mouseenter', showBar);
    quad.addEventListener('mouseleave', hideBarSoon);
    bar.addEventListener('mouseenter', showBar);
    bar.addEventListener('mouseleave', hideBarSoon);
    // Touch has no hover, so a tap reveals the bar.
    quad.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') showBar(); });

    const mkBtn = (label) => {
      const b = document.createElement('button');
      b.textContent = label;
      Object.assign(b.style, {
        border: 'none', background: 'none', color: '#fff', cursor: 'pointer',
        font: 'inherit', padding: '2px 4px', lineHeight: '1',
      });
      return b;
    };
    const playBtn = mkBtn('\u23F8');   // pause glyph while playing
    const muteBtn = mkBtn('\u{1F50A}'); // speaker
    const time = document.createElement('span');
    time.style.cssText = 'font:600 13px/1 Arial, sans-serif; opacity:.85; white-space:nowrap;';
    time.textContent = '0:00 / 0:00';

    const track = document.createElement('div');
    Object.assign(track.style, {
      flex: '1', height: '5px', background: 'rgba(255,255,255,.3)',
      borderRadius: '3px', position: 'relative', cursor: 'pointer',
    });
    const fill = document.createElement('div');
    Object.assign(fill.style, {
      position: 'absolute', left: '0', top: '0', bottom: '0', width: '0%',
      background: 'rgba(47,107,255,.95)', borderRadius: '3px', pointerEvents: 'none',
    });
    track.appendChild(fill);

    bar.append(playBtn, muteBtn, track, time);
    hud.append(quad, bar);
    this.hudLayer.appendChild(hud);

    obj.userData._hud = hud;
    obj.userData._hudQuad = quad;
    obj.userData._hudBar = bar;

    let player = null;
    let pollId = null;
    let seeking = false;
    // True only once onReady has fired -- a YT.Player object exists
    // (truthy) as soon as `new YT.Player()` returns, but its methods
    // (mute, isMuted, getPlayerState, ...) aren't attached until the
    // iframe finishes loading and onReady fires. Guarding on "player is
    // truthy" instead of this flag is exactly the bug that produced
    // "player.mute is not a function" when a click landed in that gap --
    // most easily hit by leaving and re-entering the panorama, since the
    // panel (and its player) rebuilds every time.
    let ready = false;

    const seekFromEvent = (e) => {
      const r = track.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (player && player.getDuration) player.seekTo(frac * player.getDuration(), true);
      fill.style.width = `${frac * 100}%`;
    };
    track.addEventListener('mousedown', (e) => { seeking = true; seekFromEvent(e); });
    window.addEventListener('mousemove', (e) => { if (seeking) seekFromEvent(e); });
    window.addEventListener('mouseup', () => { seeking = false; });

    const togglePlay = () => {
      if (!ready) return;
      const s = player.getPlayerState();
      if (s === window.YT.PlayerState.PLAYING) player.pauseVideo();
      else player.playVideo();
    };
    playBtn.addEventListener('click', togglePlay);
    // Click-anywhere-on-the-video to pause, like YouTube's own behaviour --
    // this used to come from the click landing inside the iframe, which
    // only worked at some angles. Now it is ours and always works.
    quad.addEventListener('click', togglePlay);
    // Routed through the manager rather than toggling this player alone,
    // so the external mute button next to fullscreenBtn (see panorama.js)
    // and every other panel's own mute button stay in sync with whichever
    // one the visitor actually clicked.
    obj.userData._syncMuteIcon = (muted) => {
      muteBtn.textContent = muted ? '\u{1F507}' : '\u{1F50A}';
    };
    muteBtn.addEventListener('click', () => {
      if (!ready) return;
      this.setMuted(!player.isMuted());
    });

    // Buttons do nothing until the API confirms a player exists -- make
    // that state visible instead of leaving clicks silently do nothing.
    [playBtn, muteBtn].forEach((b) => { b.style.opacity = '.35'; b.style.cursor = 'default'; });
    track.style.cursor = 'default';

    loadYouTubeIframeAPI().then((YT) => {
      player = new YT.Player(panelId, {
        events: {
          onReady: () => {
            ready = true;
            [playBtn, muteBtn].forEach((b) => { b.style.opacity = ''; b.style.cursor = 'pointer'; });
            track.style.cursor = 'pointer';
            // Belt-and-braces on top of cc_load_policy=0 in the embed URL --
            // that param doesn't always stick (e.g. if the visitor's
            // browser has a stored per-viewer caption preference from
            // another embed), so explicitly unload the captions module too.
            if (typeof player.unloadModule === 'function') {
              player.unloadModule('captions');
            }
            // NOTE: we deliberately do NOT try to restore a previous
            // "unmuted" preference here by calling player.unMute(). This
            // handler runs off the IFrame API's own async load/postMessage
            // chain, not off a user gesture, and browsers only honor a
            // programmatic unmute when it's a direct response to one. A
            // non-gesture unMute() call is silently ignored by the
            // autoplay policy -- isMuted() still reports false and the icon
            // would still say "sound on", but no audio actually plays. That
            // desyncs this.muted from reality, and the next tap of the
            // toggle just flips the (wrong) flag back to muted instead of
            // ever issuing a fresh, gesture-backed unMute() -- so the video
            // looks permanently stuck silent no matter how many times you
            // tap. (This is exactly what happens leaving and re-entering a
            // panorama, since clear()/addYouTube() rebuilds the player and
            // re-runs this onReady.) So every freshly-built player always
            // starts muted and reports itself muted; setMuted()/
            // toggleMuted() -- both only ever invoked from real click
            // handlers -- are the sole path back to actually unmuted audio.
            player.mute();
            this.muted = true;
            this._notifyMuteChange();
            muteBtn.textContent = '\u{1F507}';
            // Only exposed to the manager (setMuted() et al.) once the API
            // is actually ready -- see the `ready` flag comment above for
            // why doing this any earlier reintroduces the same bug.
            obj.userData.player = player;
            pollId = window.setInterval(() => {
              if (seeking) return;
              const dur = player.getDuration() || 0;
              const cur = player.getCurrentTime() || 0;
              fill.style.width = dur ? `${(cur / dur) * 100}%` : '0%';
              time.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
            }, 500);
            obj.userData._pollId = pollId;
          },
          onStateChange: (e) => {
            playBtn.textContent = e.data === YT.PlayerState.PLAYING ? '\u23F8' : '\u25B6';
            if (loop && e.data === YT.PlayerState.ENDED) {
              player.seekTo(0, true);
              player.playVideo();
            }
            // cc_load_policy=0 and the unloadModule('captions') call in
            // onReady only cover the initial load -- YouTube can silently
            // reload the captions module on its own whenever playback
            // (re)starts (e.g. an auto-captions default, or a per-viewer
            // caption preference stored from another embed), which is why
            // subtitles were creeping back in after pause/play. Re-issuing
            // unloadModule on every state change, not just once at ready,
            // catches that.
            if (typeof player.unloadModule === 'function') {
              player.unloadModule('captions');
            }
          },
        },
      });
    }).catch((err) => {
      // The API script never loaded -- almost always an ad blocker or
      // tracking-protection list blocking www.youtube.com/iframe_api (see
      // the comment on loadYouTubeIframeAPI above). Our custom buttons
      // have nothing to control in this case, so hide them and fall back
      // to YouTube's native controls instead of leaving dead buttons on
      // screen. Native controls will have the same click-precision issue
      // described earlier for panels with real rotation, but that's still
      // strictly better than buttons that do nothing at all.
      console.warn('[video-hotspot] custom controls unavailable, falling back to native controls:', err.message);
      hud.remove();
      obj.userData._hud = null;
      const iframe = wrap.querySelector('iframe');
      if (iframe) {
        // Native chrome lives inside the iframe, so it has to be clickable
        // again -- undo the pointer-events:none set in addYouTube().
        wrap.style.pointerEvents = 'auto';
        iframe.style.pointerEvents = 'auto';
        const url = new URL(iframe.src);
        url.searchParams.set('controls', '1');
        iframe.src = url.toString();
      }
    });

    obj.userData._stopControls = () => {
      if (pollId) window.clearInterval(pollId);
      if (player && typeof player.destroy === 'function') {
        try { player.destroy(); } catch (e) { /* iframe already gone */ }
      }
    };
  }

  /** Remove every panel. Call this on panorama change, like clearPanoramaHotspots(). */
  clear() {
    for (const p of this.panels) {
      if (typeof p.userData._stopControls === 'function') p.userData._stopControls();
      // Nulling src stops playback; without it audio keeps running after the
      // element is detached.
      const iframe = p.element.querySelector('iframe');
      if (iframe) iframe.src = '';
      this.scene.remove(p);
      if (p.element.parentNode) p.element.parentNode.removeChild(p.element);
      if (p.userData._hud) p.userData._hud.remove();
      p.userData._hud = null;
    }
    this.panels.length = 0;
  }

  /**
   * Log where each panel is relative to the camera. Call from the console as
   * viewer.videoHotspots.debug() when a panel doesn't appear -- it separates
   * "never created" from "created but you're not looking at it".
   */
  debug() {
    const el = this.renderer.domElement;
    console.log('CSS3D layer:', el.clientWidth + 'x' + el.clientHeight,
                'display:', el.style.display || '(visible)',
                'panels:', this.panels.length);
    console.log('HUD layer:', this.hudLayer.clientWidth + 'x' + this.hudLayer.clientHeight,
                'display:', this.hudLayer.style.display || '(visible)',
                'huds:', this.hudLayer.childElementCount);
    const v = new THREE.Vector3();
    this.panels.forEach((p, i) => {
      v.copy(p.position).project(this.camera);
      const onScreen = v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
      console.log(`  panel ${i} (${p.userData.cfg.videoId}):`,
        onScreen ? 'ON SCREEN' : 'off screen',
        `screen x=${v.x.toFixed(2)} y=${v.y.toFixed(2)}`,
        onScreen ? '' : '-> adjust theta/phi in video-config.js');
    });
  }

  show() {
    this.renderer.domElement.style.display = '';
    this.hudLayer.style.display = '';
  }

  hide() {
    this.renderer.domElement.style.display = 'none';
    this.hudLayer.style.display = 'none';
  }

  /**
   * Move each panel's flat controls to sit on top of where that panel
   * actually projects this frame. The quad is clipped to the panel's four
   * projected corners (so it follows the perspective exactly, including
   * yaw/tilt/roll), while the bar stays axis-aligned along the bottom edge
   * -- an unrotated bar is what keeps its buttons reliably clickable.
   */
  _updateHud() {
    if (!this.panels.length) return;

    const w = this.hudLayer.clientWidth || window.innerWidth;
    const h = this.hudLayer.clientHeight || window.innerHeight;
    const cam = this.camera;
    cam.updateMatrixWorld();

    const v = new THREE.Vector3();
    // Local order: bottom-left, bottom-right, top-right, top-left. The
    // clip-path polygon must be wound consistently, and the bottom pair is
    // reused to place the bar.
    const LOCAL = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

    for (const p of this.panels) {
      const hud = p.userData._hud;
      if (!hud) continue;

      const halfW = p.userData.halfW;
      const halfH = p.userData.halfH;
      const pts = [];
      let visible = true;

      for (const [sx, sy] of LOCAL) {
        v.set(sx * halfW, sy * halfH, 0).applyMatrix4(p.matrixWorld);
        // Camera-space z >= 0 means the corner is level with or behind the
        // camera; project() would fold it back onto the screen mirrored, so
        // bail out rather than draw a nonsense quad.
        const cz = v.clone().applyMatrix4(cam.matrixWorldInverse).z;
        if (cz > -0.01) { visible = false; break; }
        v.project(cam);
        pts.push([(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h]);
      }

      if (!visible) { hud.style.display = 'none'; continue; }
      hud.style.display = '';

      const quad = p.userData._hudQuad;
      quad.style.clipPath =
        'polygon(' + pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',') + ')';

      // Bar spans the bottom edge (corners 0 and 1) and sits just above it.
      const [blx, bly] = pts[0];
      const [brx, bry] = pts[1];
      const barW = Math.hypot(brx - blx, bry - bly);
      const midX = (blx + brx) / 2;
      const midY = (bly + bry) / 2;
      // Scale the bar's type with the panel so it doesn't look oversized
      // when the video is far away or tiny when zoomed in.
      const s = Math.min(2, Math.max(0.45, barW / (halfW * 2)));
      const bar = p.userData._hudBar;
      bar.style.width = `${barW.toFixed(1)}px`;
      bar.style.left = `${(midX - barW / 2).toFixed(1)}px`;
      bar.style.top = `${midY.toFixed(1)}px`;
      bar.style.fontSize = `${(20 * s).toFixed(1)}px`;
      bar.style.padding = `${(8 * s).toFixed(1)}px ${(12 * s).toFixed(1)}px`;
      bar.style.gap = `${(10 * s).toFixed(1)}px`;
    }
  }

  /** Call once per frame, right after renderer.render(). */
  render() {
    this.renderer.render(this.scene, this.camera);
    this._updateHud();
  }

  dispose() {
    this.clear();
    window.removeEventListener('resize', this._onResize);
    if (this.renderer.domElement.parentNode) {
      this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    }
    if (this.hudLayer.parentNode) {
      this.hudLayer.parentNode.removeChild(this.hudLayer);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-hosted video alternative.
//
// If you host the clip yourself (an .mp4 in the task folder) rather than
// using YouTube, it CAN be a real WebGL texture. That buys you correct
// occlusion, real depth sorting and no DOM layer -- at the cost of hosting
// and bandwidth, and no YouTube analytics or recommendations.
// ---------------------------------------------------------------------------

/**
 * @param {object} cfg  { src, radius, phi, theta, width, aspect, muted }
 * @returns {{ mesh: THREE.Mesh, video: HTMLVideoElement }}
 */
export function createVideoPanel(cfg) {
  const video = document.createElement('video');
  video.src = cfg.src;
  video.loop = true;
  video.muted = cfg.muted !== false;  // autoplay needs muted
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  video.play().catch(() => { /* blocked until a user gesture; ignore */ });

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;

  const width = cfg.width ?? 520;
  const height = width / (cfg.aspect ?? 16 / 9);

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false })
  );
  mesh.position.copy(sphericalToWorld(cfg.radius, cfg.phi, cfg.theta));
  mesh.lookAt(0, 0, 0);
  mesh.renderOrder = 9;

  return { mesh, video };
}