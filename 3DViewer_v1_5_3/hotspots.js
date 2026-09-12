import * as THREE from 'three';
import { createGlowHotspot, updateGlowHotspots, disposeGlowHotspot } from './glow-hotspot.js';
// Hotspot config placeholders
let roomConnections = [];
let hotspotData = [];
let modelToPanoramaMapping = [];
let availablePanoramas = [];
let videoHotspotData = [];

/**
 * Dynamically load hotspot-config.js and video-config.js from the task's
 * pano folder.
 *
 * The two are loaded INDEPENDENTLY. video-config.js used to be read only
 * after hotspot-config.js had loaded, so a tour without hotspot-config.js
 * -- every housebin tour, whose door hotspots come from h1_HOTSPOT_V.json
 * instead -- silently lost its video panels too.
 */
export async function loadHotspotConfig(panoramaManager = null) {
  const basePath = window.PANO_BASE_PATH || './panos/';

  // 1. Door hotspots + room mapping. Written by the GLB export; a housebin
  //    tour has none and main.js fills these in from h1_HOTSPOT_V.json.
  let configVideos = [];
  try {
    const module = await import(`${basePath}hotspot-config.js`);
    roomConnections = module.roomConnections || [];
    hotspotData = module.hotspotData || [];
    modelToPanoramaMapping = module.modelToPanoramaMapping || [];
    availablePanoramas = module.availablePanoramas || [];
    // Optional. hotspot-config.js is auto-generated and won't normally
    // contain this, which is why video-config.js exists (below).
    configVideos = module.videoHotspotData || [];

    if (panoramaManager && typeof panoramaManager.setHotspotData === 'function') {
      panoramaManager.setHotspotData(hotspotData);
    }
    console.log(`✅ Hotspot config loaded from: ${basePath}hotspot-config.js`);
  } catch (err) {
    console.warn(`No hotspot-config.js in ${basePath} -- expected for a housebin tour ` +
                 '(door hotspots then come from h1_HOTSPOT_V.json).', err?.message || err);
  }

  // 2. Video panels. Hand-edited, never touched by the exporter, and
  //    independent of which model format the tour uses.
  videoHotspotData = configVideos;
  if (!videoHotspotData.length) {
    try {
      const vid = await import(`${basePath}video-config.js`);
      videoHotspotData = vid.videoHotspotData || [];
      console.log(`✅ Video config loaded from: ${basePath}video-config.js (${videoHotspotData.length} panel(s))`);
    } catch (e) {
      // No video-config.js in this task folder -- perfectly normal.
    }
  }
  if (panoramaManager && typeof panoramaManager.setVideoHotspotData === 'function') {
    panoramaManager.setVideoHotspotData(videoHotspotData);
  }
}

/**
 * Installs a hotspot configuration that was built in code -- the housebin
 * path derives one from h1_HOTSPOT_V.json when the task folder has no
 * hotspot-config.js. Only fills in what the file didn't provide, so an
 * exported hotspot-config.js (exact u/v from the editor) always wins.
 *
 * @returns {boolean} true if the fallback was used for the pano hotspots
 */
export function applyHotspotConfigFallback(cfg, panoramaManager = null) {
  if (!cfg) return false;
  let usedForPanos = false;
  if (!hotspotData.length && cfg.hotspotData?.length) {
    hotspotData = cfg.hotspotData;
    roomConnections = cfg.roomConnections || roomConnections;
    usedForPanos = true;
    if (panoramaManager && typeof panoramaManager.setHotspotData === 'function') {
      panoramaManager.setHotspotData(hotspotData);
    }
  }
  if (!modelToPanoramaMapping.length && cfg.modelToPanoramaMapping?.length) {
    modelToPanoramaMapping = cfg.modelToPanoramaMapping;
  }
  if (!availablePanoramas.length && cfg.availablePanoramas?.length) {
    availablePanoramas = cfg.availablePanoramas;
  }
  return usedForPanos;
}

/**
 * Which pano a dollhouse hotspot opens. Exact roomId match first, then the
 * LONGEST pattern contained in the node name. The old first-substring match
 * sent "landing-2" to Landing ('landing-2'.includes('landing')), and the
 * same for bathroom-2 / hallway-1-style names, whenever the shorter name
 * happened to be listed first.
 */
export function findPanoramaMapping(nodeName) {
  const name = String(nodeName || '').toLowerCase();
  let best = null, bestLen = -1;
  for (const config of modelToPanoramaMapping) {
    for (const raw of config.nodeNamePatterns || []) {
      const pattern = String(raw).toLowerCase();
      if (!pattern) continue;
      if (pattern === name) return config;
      if (name.includes(pattern) && pattern.length > bestLen) { best = config; bestLen = pattern.length; }
    }
  }
  return best;
}

// Export getters for configs
export function getHotspotConfig() {
  return { roomConnections, hotspotData, modelToPanoramaMapping, availablePanoramas, videoHotspotData };
}

export class HotspotManager {
  constructor(scene, panoramaManager = null) {
    this.scene = scene;
    this.rotHotspots = [];
    this.labels = [];
    this.hotspots = [];
    this.panoramaManager = panoramaManager;
    this.alphaMap = null; // Preloaded alpha map texture
    this.hoveredHotspot = null; // set by setHoveredHotspot() for the hover glow
    this._lastHotspotTime = 0;  // frame timer for updateGlowHotspots()

    // Load hotspot configuration. Kept as a promise so main.js can wait
    // for it before mapping dollhouse hotspots to panoramas -- building them
    // first silently fell back to availablePanoramas[index % 0].
    this.configReady = this.loadConfig();
  }

  async loadConfig() {
    await loadHotspotConfig(this.panoramaManager);
  }

  setAlphaMap(texture) {
    this.alphaMap = texture;
  }

  // Create blue circle texture with white arrow
  createArrowTexture(size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.clearRect(0, 0, size, size);

    // Blue circle
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
    ctx.fillStyle = '#1249ff';
    ctx.fill();
    ctx.strokeStyle = '#2E5D8F';
    ctx.lineWidth = 3;
    ctx.stroke();

    // White arrow
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const centerX = size / 2;
    const centerY = size / 2;
    const arrowSize = size / 4;

    ctx.beginPath();
    ctx.moveTo(centerX, centerY + arrowSize / 2);
    ctx.lineTo(centerX, centerY - arrowSize / 2);
    ctx.moveTo(centerX - arrowSize / 3, centerY - arrowSize / 6);
    ctx.lineTo(centerX, centerY - arrowSize / 2);
    ctx.lineTo(centerX + arrowSize / 3, centerY - arrowSize / 6);
    ctx.stroke();

    return new THREE.CanvasTexture(canvas);
  }

  // Cylinder hotspots at ROT empties with HTML labels
  createRotHotspots(rotNodes) {
    this.rotHotspots.forEach(h => {
      if (h.parent) h.parent.remove(h);
      h.geometry.dispose();
      h.material.dispose();
    });
    this.rotHotspots = [];

    this.labels.forEach(label => {
      if (label.element?.parentNode) {
        label.element.parentNode.removeChild(label.element);
      }
    });
    this.labels = [];

    let alphaMap;
    if (this.alphaMap) {
      alphaMap = this.alphaMap;
    } else {
      const loader = new THREE.TextureLoader();
      alphaMap = loader.load('textures/transparent.png');
    }

    rotNodes.forEach((node, index) => {
      const geometry = new THREE.CylinderGeometry(0.3, 0.3, 2.0, 16, 1, true);
      const material = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        emissive: 0xffffff,
        alphaMap: alphaMap
      });

      const cylinder = new THREE.Mesh(geometry, material);
      node.add(cylinder);
      // FIX: was a hardcoded position.set(0, 0, 0.28) (then briefly 1.0,
      // then -1.0 while chasing the wrong theory). The real issue: this
      // anchor node is NOT at floor level -- per housebin.js's buildRoom()
      // (and the matching GLBExporter::exportGLB() convention it mirrors),
      // "room_hotspot" anchors sit at CAMERA HEIGHT above the floor, with
      // a baked-in +90deg X rotation that makes the anchor's own local +Z
      // point DOWN toward the floor. A single hardcoded constant could
      // only ever approximate one room's camera height, which is why it
      // was "a little below" on rooms shot slightly taller than 0.28+1.0
      // implied, and why guessing bigger/smaller/negative constants just
      // moved the same mismatch around instead of fixing it.
      //
      // The cylinder is 2.0 tall, so its local Z span is offset +/- 1.0.
      // Its lowest edge (offset + 1.0, since +Z is down here) needs to
      // land exactly `cameraHeight` further down the anchor than the
      // anchor itself -- i.e. offset = cameraHeight - 1.0 -- so it sits
      // flush with the floor regardless of that room's actual camera
      // height. cameraHeight lives on the parent Room node's userData
      // (see housebin.js's buildRoom()); 1.28 is only a last-resort
      // fallback for a node that somehow lacks it.
      const cameraHeight = (node.parent && node.parent.userData &&
        typeof node.parent.userData.cameraHeight === 'number')
        ? node.parent.userData.cameraHeight
        : 1.28;
      cylinder.position.set(0, 0, cameraHeight - 1.0);
      cylinder.rotation.set(-Math.PI / 2, 0, 0);
      cylinder.name = `rot-hotspot-${index}`;
      cylinder.userData.floor = node.userData.floor;

      // Match against the stable roomId embedded in the GLB's extras
      // (exposed by GLTFLoader as node.userData.roomId), e.g. "Bedroom-2",
      // "Front-Door" -- NOT node.name. node.name is the human-readable
      // display name ("Bedroom 2", "Front Door"), which GLBExporter.h
      // deliberately converts hyphens to spaces for. hotspot-config.js's
      // nodeNamePatterns are hyphenated ('bedroom-2', 'front-door') to
      // match roomId, so comparing them against the space-separated
      // display name always failed silently and fell through to the
      // availablePanoramas[index % length] guess below -- which is why
      // clicking a room opened an unrelated, seemingly random panorama.
      const roomId = node.userData && node.userData.roomId;
      const nodeName = (roomId || node.name).toLowerCase();
      const displayName = node.name.replace(/_/g, ' ');
      let panoramaImagePath = '';

      const mapping = findPanoramaMapping(nodeName);

      if (mapping) {
        panoramaImagePath = mapping.panoramaImage;
      } else {
        const fallback = modelToPanoramaMapping.find(config => config.fallbackIndex === index);
        if (fallback) {
          panoramaImagePath = fallback.panoramaImage;
        } else {
          panoramaImagePath = availablePanoramas.length
            ? availablePanoramas[index % availablePanoramas.length]
            : '';
        }
      }

      cylinder.userData.panoramaImage = panoramaImagePath;
      this.rotHotspots.push(cylinder);

      // HTML label
      const div = document.createElement('div');
      div.className = 'hotspot-label';
      // Name line + an (initially empty) size line under it, filled in by
      // setRoomDimensions() once the rooms have been measured.
      const nameLine = document.createElement('div');
      nameLine.className = 'hotspot-label-name';
      nameLine.textContent = displayName;
      const dimsLine = document.createElement('div');
      dimsLine.className = 'hotspot-label-dims';
      Object.assign(dimsLine.style, {
        fontSize: '10px',
        fontWeight: '600',
        opacity: '0.9',
        marginTop: '2px',
        display: 'none'
      });
      div.appendChild(nameLine);
      div.appendChild(dimsLine);
      Object.assign(div.style, {
        position: 'absolute',
        background: 'rgba(0, 0, 0, 0.4)',
        backdropFilter: 'blur(10px)',
        padding: '0.5rem 1rem',
        borderRadius: '0.5rem',
        boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
        color: 'white',
        fontSize: '12px',
        fontWeight: 'bold',
        textAlign: 'center',
        whiteSpace: 'nowrap',
        transform: 'translate(-50%, -50%)',
        pointerEvents: 'none',
        zIndex: '100',
        transition: 'opacity 0.2s ease, visibility 0.2s ease'
      });
      document.body.appendChild(div);

      const labelPosition = new THREE.Vector3(0, 1, 0);
      const referencePoint = new THREE.Object3D();
      referencePoint.position.copy(labelPosition);
      cylinder.add(referencePoint);

      this.labels.push({
        position: labelPosition,
        element: div,
        dimsElement: dimsLine,
        roomId: roomId || null,
        parent: cylinder,
        floor: node.userData.floor
      });
    });
  }

  updateRotTextFacing(camera, isFloorPlanView = false) {
    if (!this.labels.length) return;
    const tempVector = new THREE.Vector3();

    this.labels.forEach(label => {
      if (!label.element || !label.parent) return;
      if (label.element.style.display === 'none') return;

      const worldPosition = new THREE.Vector3();
      label.parent.getWorldPosition(worldPosition);
      worldPosition.add(label.position);

      const distance = camera.position.distanceTo(worldPosition);
      let scaleFactor;

      if (isFloorPlanView) {
        scaleFactor = 0.9;
      } else {
        const baseDistance = 10;
        const minScale = 0.3;
        const maxScale = 2.0;
        scaleFactor = baseDistance / distance;
        scaleFactor = Math.max(minScale, Math.min(maxScale, scaleFactor));

        // 3D view: the W x L / area line only earns its place once you've
        // zoomed in close enough to actually want it -- see
        // setZoomDimsThreshold(). Floor plan view is untouched here; there
        // dims are governed entirely by hover/tap (setHoveredRoom()).
        if (!this._floorPlanHoverMode && label.dimsElement) {
          const text = label.roomId ? (this._roomDimText || {})[label.roomId] : null;
          const threshold = this._zoomDimsThreshold;
          const show = !!text && (threshold == null || distance <= threshold);
          if (label.dimsElement.textContent !== (text || '')) label.dimsElement.textContent = text || '';
          label.dimsElement.style.display = show ? 'block' : 'none';
          label.dimsElement.style.opacity = show ? '1' : '0';
        }
      }

      tempVector.copy(worldPosition);
      tempVector.project(camera);

      const x = (tempVector.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-tempVector.y * 0.5 + 0.5) * window.innerHeight;

      const isBehindCamera = tempVector.z > 1;
      const isOutsideScreen =
        x < -100 || x > window.innerWidth + 100 || y < -100 || y > window.innerHeight + 100;

      if (isBehindCamera || isOutsideScreen) {
        label.element.style.visibility = 'hidden';
      } else {
        label.element.style.visibility = 'visible';
        label.element.style.left = `${x}px`;
        label.element.style.top = `${y}px`;
        label.element.style.transform = `translate(-50%, -50%) scale(${scaleFactor})`;
      }
    });
  }

  /**
   * Distance (in world units, i.e. camera-to-room) at or under which the
   * W x L / area line appears under a room's name in the 3D view. Pass
   * null to go back to always showing it. See RoomViewer.adjustCameraFor-
   * FloorView() in main.js, which sets this from the default camera
   * distance so it scales with whatever units the model is built in.
   * @param {number|null} distance
   */
  setZoomDimsThreshold(distance) {
    this._zoomDimsThreshold = (typeof distance === 'number') ? distance : null;
  }

  clearPanoramaHotspots() {
    if (this.hotspots) {
      this.hotspots.forEach(group => {
        // Frees the two per-hotspot ShaderMaterials. The ring/pulse/chevron
        // geometry is shared across every hotspot by glow-hotspot.js, so it
        // is deliberately NOT disposed here.
        disposeGlowHotspot(group);

        // The name label lives in the scene rather than in the group (see
        // createPanoramaHotspots), so it has to be removed separately.
        const label = group.userData.textMesh;
        if (label) {
          if (label.material) {
            if (label.material.map) label.material.map.dispose();
            label.material.dispose();
          }
          if (label.geometry) label.geometry.dispose();
          this.scene.remove(label);
        }

        this.scene.remove(group);
      });
    }
    this.hotspots = [];
    this.hoveredHotspot = null;
  }

  createPanoramaHotspots(hotspotData) {
    this.clearPanoramaHotspots();

    // ------------------------------------------------------------------
    // Marker sizing. Three independent blocks -- ring, badge, label -- all
    // in WORLD UNITS, so each can be changed without touching the others.
    // (For reference: the panorama sphere has radius 500 and the hotspots
    // sit at radius ~480, so 40 units is roughly a doorway-sized marker.)
    //
    // They are only related by geometry, not by code: the badge's visible
    // top is
    //     BADGE.height + BADGE.size * BADGE.halo / 2
    // because glow-hotspot.js draws the soft halo at BADGE.halo times the
    // logo's size, and that glow -- not the logo -- is what the label has
    // to clear. With the values below that is 22 + 20 * 2.3 / 2 = 45, so
    // LABEL.height of 65 leaves a 20-unit gap.
    // ------------------------------------------------------------------
    const RING = {
      size: 40,          // diameter of the glow ring on the floor
      // Offsets from the hotspot point, in world units. forward/side are
      // relative to the marker as you face it: +forward pushes it deeper
      // into the room, +side slides it right. The badge and label are
      // measured from the hotspot point too, so moving the ring does NOT
      // drag them along -- and since the ring quad is what the raycaster
      // hits, moving it moves the clickable area.
      height: -10,
      forward: 0,
      side: 0,
    };
    const BADGE = {
      size: 32,          // logo's largest dimension
      height: 22,        // logo's centre, above the ring
      halo: 2.3,         // glow spread, as a multiple of size
      glow: 0.55,        // halo + edge-shell brightness
      yaw: 180,            // degrees; 180 shows the back face
      tilt: 0,           // + leans the top away from you, - toward you
      roll: 180,
    };
    const LABEL = {
      height: 65,        // text centre, above the ring
      width: 120,        // plane the text is drawn on, in world units
      planeHeight: 60,   // its height; the canvas matches this aspect

      // --- type -------------------------------------------------------
      // fontSize and outlineWidth are in CANVAS pixels, on a canvas that
      // is `resolution` wide -- so they are relative to each other and to
      // the plane, not to world units. Doubling fontSize doubles how much
      // of the plane the letters fill.
      resolution: 1024,  // canvas width; raise for crisper text when zoomed
      font: 'Helvetica, Arial, sans-serif',
      weight: 'bold',    // 'normal', 'bold', '600', ...
      fontSize: 120,
      color: '#FFFFFF',
      opacity: 1,
      letterSpacing: 0,  // canvas px between characters
      uppercase: false,

      // Outline. Set outlineWidth to 0 for no stroke.
      outline: '#000000',
      outlineWidth: 12,

      // Optional soft drop shadow -- often reads better than a hard
      // outline over a busy photo. null to skip.
      shadow: null,      // { color: 'rgba(0,0,0,.75)', blur: 24, x: 0, y: 6 }

      // Optional pill behind the text. null to skip.
      background: null,  // { color: 'rgba(10,16,40,.55)', padding: 26, radius: 28 }

      // Shrink the type if a long room name would run off the plane.
      fit: true,
    };
    // Motion. Every entry can be set to 0 to switch that piece off, so a
    // fully static marker is ringPulse/ringBreatheDepth/badgeBob/
    // badgeGlowDepth all at 0.
    const ANIM = {
      ringPulse: 1.8,        // seconds per expanding pulse ring
      ringBreathe: 2.0,      // ring brightness breathing, rad/sec
      ringBreatheDepth: 0.14,// how deep that breath is, 0..1
      ringHover: 1.7,        // ring brightness multiplier while hovered

      badgeBob: 2.2,         // float speed, rad/sec
      badgeBobAmount: 0.05,  // bob height, as a fraction of BADGE.size
      badgeSpin: 0,          // degrees/sec about the vertical axis
      badgeGlow: 2.0,        // badge glow breathing speed
      badgeGlowDepth: 0.15,

      hoverLift: 0.12,       // extra height on hover, fraction of BADGE.size
      hoverScale: 0.08,      // extra badge scale on hover
      hoverSpeed: 10,        // how quickly hover eases in and out
    };

    hotspotData.forEach((data, index) => {
      // panorama.js builds the photo sphere as
      // `new THREE.SphereGeometry(...); geometry.scale(-1, 1, 1)` -- the
      // standard three.js trick to mirror the sphere so the equirect
      // texture reads correctly from a camera positioned *inside* it.
      // x below already accounts for that mirror (it matches where the
      // texture actually lands), but z did not -- it was using the
      // un-mirrored textbook spherical formula, which is a left-right
      // mirror of the true texture position around the sphere's front
      // (x) axis. That's what was showing up as hotspots consistently
      // offset to the left of their intended doorway/marker position.
      const x = -data.radius * Math.sin(data.phi) * Math.cos(data.theta);
      const y = data.radius * Math.cos(data.phi);
      const z = -data.radius * Math.sin(data.phi) * Math.sin(data.theta);

      const position = new THREE.Vector3(x, y, z);

      // Real geometry instead of the old textures/hotspot.png sprite: a
      // shader glow ring laid FLAT in the world XZ plane, an expanding
      // pulse, and a lifted 3D chevron aimed away from the camera.
      //
      // The old sprite was billboarded every frame with lookAt(0,0,0) and
      // faked the floor perspective by being drawn as a squashed ellipse.
      // This one is genuinely lying on the floor, so the perspective is
      // correct at every camera angle and FOV. Pass `billboard: true` if
      // you ever want the old flat-facing-camera behaviour back.
      const hotspotGroup = createGlowHotspot({
        position,
        size: RING.size,
        ringHeight: RING.height,
        ringForward: RING.forward,
        ringSide: RING.side,
        // Absolute world units, so the badge keeps its size and height
        // whatever RING.size is set to.
        modelSize: BADGE.size,
        modelHeight: BADGE.height,
        halo: BADGE.halo,
        glow: BADGE.glow,
        // Degrees, applied on top of the yaw billboard every frame --
        // setting rotation on the badge object directly will NOT stick,
        // since lookAt() overwrites it.
        modelYaw: BADGE.yaw,
        modelTilt: BADGE.tilt,
        modelRoll: BADGE.roll,
        anim: ANIM,
      });

      // Name label. Kept as a separate scene child rather than a child of
      // the group -- the group is rotated into the floor plane, and a label
      // parented to it would be laid down flat and unreadable.
      const textTexture = this.createTextTexture(data.name, LABEL);
      const textGeometry = new THREE.PlaneGeometry(LABEL.width, LABEL.planeHeight);
      const textMaterial = new THREE.MeshBasicMaterial({
        map: textTexture,
        transparent: true,
        opacity: LABEL.opacity ?? 1,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      });
      const textMesh = new THREE.Mesh(textGeometry, textMaterial);
      // Nudged out toward the sphere so it never sinks into the glow, then
      // lifted to clear the badge -- see LABEL above. This used to be a
      // flat +45, which was set when a small chevron floated over the ring
      // and put the text right inside the badge's halo.
      textMesh.position.copy(position).multiplyScalar(1.02);
      textMesh.position.y += LABEL.height;
      textMesh.renderOrder = 12;
      this.scene.add(textMesh);

      hotspotGroup.name = `pano-hotspot-${index}`;

      // createGlowHotspot already put its animation state in userData._glow,
      // so extend userData rather than replacing it. `info` is what the
      // raycast walk in panorama.js looks for when climbing to the parent
      // group, so it must stay.
      hotspotGroup.userData.info = data;
      hotspotGroup.userData.textMesh = textMesh;

      this.scene.add(hotspotGroup);
      this.hotspots.push(hotspotGroup);
    });
  }

  /**
   * Draw a room name onto a canvas and hand it back as a texture.
   *
   * @param {string} text
   * @param {object} [style] the LABEL block from createPanoramaHotspots.
   *        Every key is optional; see the defaults below. The canvas is
   *        sized from style.width / style.planeHeight so it matches the
   *        plane's aspect -- otherwise the type comes out stretched.
   */
  createTextTexture(text, style = {}) {
    const S = Object.assign({
      resolution: 1024,
      width: 120, planeHeight: 60,
      font: 'Helvetica, Arial, sans-serif',
      weight: 'bold',
      fontSize: 120,
      color: '#FFFFFF',
      letterSpacing: 0,
      uppercase: false,
      outline: '#000000',
      outlineWidth: 12,
      shadow: null,
      background: null,
      fit: true,
    }, style);

    const canvas = document.createElement('canvas');
    canvas.width = S.resolution;
    canvas.height = Math.round(S.resolution * (S.planeHeight / S.width));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const label = S.uppercase ? String(text).toUpperCase() : String(text);
    // letterSpacing is Chrome 99+ / Safari 16+; older engines ignore the
    // property and just render without tracking rather than throwing.
    if (S.letterSpacing) ctx.letterSpacing = `${S.letterSpacing}px`;

    const setFont = (px) => { ctx.font = `${S.weight} ${px}px ${S.font}`; };
    let fontSize = S.fontSize;
    setFont(fontSize);

    // Shrink to fit rather than letting a long name run off the plane.
    // The margin leaves room for the stroke, which straddles the glyph
    // edge and so adds half its width on each side.
    if (S.fit) {
      const margin = canvas.width * 0.08 + S.outlineWidth;
      const avail = canvas.width - margin;
      const w = ctx.measureText(label).width;
      if (w > avail) {
        fontSize = Math.max(8, Math.floor(fontSize * (avail / w)));
        setFont(fontSize);
      }
    }

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (S.background) {
      const bg = S.background;
      const pad = bg.padding ?? 24;
      const m = ctx.measureText(label);
      const bw = m.width + pad * 2;
      const bh = fontSize * 1.35 + pad * 2;
      ctx.fillStyle = bg.color ?? 'rgba(0,0,0,.5)';
      ctx.beginPath();
      // roundRect is recent; fall back to a plain rect where it is missing.
      if (ctx.roundRect) ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, bg.radius ?? 20);
      else ctx.rect(cx - bw / 2, cy - bh / 2, bw, bh);
      ctx.fill();
    }

    if (S.shadow) {
      ctx.shadowColor = S.shadow.color ?? 'rgba(0,0,0,.75)';
      ctx.shadowBlur = S.shadow.blur ?? 20;
      ctx.shadowOffsetX = S.shadow.x ?? 0;
      ctx.shadowOffsetY = S.shadow.y ?? 4;
    }

    if (S.outlineWidth > 0 && S.outline) {
      ctx.strokeStyle = S.outline;
      ctx.lineWidth = S.outlineWidth;
      ctx.lineJoin = 'round';    // stops spikes on tight corners like "W"
      ctx.miterLimit = 2;
      ctx.strokeText(label, cx, cy);
    }

    // The shadow is spent on the stroke (or on the fill when there is no
    // stroke); leaving it on would double-darken the fill pass.
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.fillStyle = S.color;
    ctx.fillText(label, cx, cy);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    // The label is viewed at a shallow angle from across the room, where
    // mipmapped minification turns thin type to mush.
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    return texture;
  }

  /**
   * Advance the hotspot animation. Call once per frame.
   *
   * The old version billboarded every group with lookAt(0,0,0). The glow
   * ring is deliberately not billboarded -- lying flat in the floor plane
   * is what makes it read as 3D -- so only the name label turns to face
   * the camera now.
   *
   * @param {THREE.Camera} [camera] pass main.js's this.activeCamera
   */
  animateHotspots(camera) {
    if (!this.hotspots || !this.hotspots.length) return;

    // Clamped so a backgrounded tab resuming doesn't jump the pulse forward.
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this._lastHotspotTime || now)) / 1000);
    this._lastHotspotTime = now;

    // camera is passed on so the logo badge above each ring can yaw to
    // face the viewer; the ring and pulse stay flat in the floor plane.
    updateGlowHotspots(this.hotspots, dt, this.hoveredHotspot || null, camera || null);

    if (camera) {
      this.hotspots.forEach(group => {
        if (group.userData.textMesh) group.userData.textMesh.lookAt(camera.position);
      });
    }
  }

  /**
   * Mark which hotspot the cursor is over so its ring brightens and its
   * chevron lifts. Pass null to clear. Wire this up in panorama.js next to
   * the existing hotspotTooltip show/hide.
   *
   * @param {THREE.Group|null} group
   */
  setHoveredHotspot(group) {
    this.hoveredHotspot = group || null;
  }

  getRotHotspots() {
    return this.rotHotspots;
  }
  getPanoramaHotspots() {
    return this.hotspots || [];
  }

  hideLabels() {
    this.labels.forEach(label => {
      if (label.element) {
        label.element.style.display = 'none';
      }
    });
  }

  showLabels() {
    this.labels.forEach(label => {
      if (label.element) {
        label.element.style.display = 'block';
        label.element.style.visibility = 'visible';
      }
    });
  }

  /**
   * Puts each room's size under its name, e.g. "14' 0" x 20' 0"  253 sq ft".
   * Visibility is handled elsewhere: in the 3D view by zoom distance (see
   * setZoomDimsThreshold(), applied each frame in updateRotTextFacing()),
   * in the floor plan view by hover/tap (see setHoveredRoom()). This just
   * stores the text and starts every dims line hidden so it doesn't flash
   * on before the first per-frame update runs.
   * @param {Object<string,string>} textByRoomId  roomId -> text; rooms
   *        missing from it keep a single-line label.
   */
  setRoomDimensions(textByRoomId) {
    this._roomDimText = textByRoomId || {};
    this.labels.forEach(label => {
      if (!label.dimsElement) return;
      const text = label.roomId ? this._roomDimText[label.roomId] : null;
      label.dimsElement.textContent = text || '';
      Object.assign(label.dimsElement.style, {
        display: 'none',
        opacity: '0',
        transition: 'opacity 0.15s ease'
      });
    });
  }

  /**
   * Switches between the two dims-visibility behaviors: false (3D/dollhouse
   * view) reveals a room's size by zoom distance; true (floor plan view)
   * hides them all until setHoveredRoom() reveals one.
   * @param {boolean} active
   */
  setFloorPlanHoverMode(active) {
    this._floorPlanHoverMode = !!active;
    if (!active) this.hoveredRoomId = null;
    this.setRoomDimensions(this._roomDimText || {});
  }

  /**
   * Reveal the size line only for one room (hover on desktop, tap on
   * mobile); pass null/undefined to hide every size line again. Only takes
   * effect in floor plan hover mode -- see setFloorPlanHoverMode().
   * @param {string|null} roomId
   */
  setHoveredRoom(roomId) {
    if (!this._floorPlanHoverMode) return;
    this.hoveredRoomId = roomId || null;
    this.labels.forEach(label => {
      if (!label.dimsElement) return;
      const text = label.roomId ? (this._roomDimText || {})[label.roomId] : null;
      const show = !!text && label.roomId === this.hoveredRoomId;
      label.dimsElement.textContent = text || '';
      label.dimsElement.style.display = show ? 'block' : 'none';
      label.dimsElement.style.opacity = show ? '1' : '0';
    });
  }

  showLabelsForFloor(floorKey) {
    this.labels.forEach(label => {
      if (label.element) {
        if (label.floor === floorKey) {
          label.element.style.display = 'block';
          label.element.style.visibility = 'visible';
        } else {
          label.element.style.display = 'none';
        }
      }
    });
  }
}