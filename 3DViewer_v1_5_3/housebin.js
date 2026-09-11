/**
 * housebin.js -- load a housebin capture straight into the tour viewer.
 *
 * Reads the house container (h1.housebine / h1.housebin), every floor file it
 * lists, the per-surface JPEG crops, and the h1_*_V.json sidecars, and builds
 * the SAME node layout GLBExporter::exportGLB() writes:
 *
 *   <floor group>
 *     <Name> Room        userData { roomId, cameraHeight, ceilingHeight, floorIndex, floorName }
 *       <Name> Mesh      floor / ceiling / wall surfaces, textured from the crops
 *       <Name>           userData.type === 'room_hotspot'   (at camera height, +90deg X)
 *         Pano NN EMPTY  userData.type === 'panorama_anchor'
 *
 * so FloorManager, hotspots.js and panorama.js treat a housebin tour exactly
 * like a GLB tour. No new conventions downstream.
 *
 * ── Frames (verified numerically against a GLB and a housebin exported from
 *    the same Qt session, 9 rooms, 2 floors: every floor corner lands within
 *    float noise of the GLB's) ──────────────────────────────────────────────
 *   floor file:  Z-up. room world = pos + Rz(yaw) * local
 *                house world = floorOffset + Rz(floorYaw) * room world
 *   three.js:    X = -x, Y = z (up), Z = y, and a floor-file yaw is a plain
 *                rotation.y. (Proper rotation, not a mirror: det = +1.)
 *
 * ── Units ────────────────────────────────────────────────────────────────
 *   The Qt app writes real metres with each room's floor pinned at z = -1.
 *   Older captures from the original capture tool are normalised so ONE UNIT
 *   IS ONE CAMERA HEIGHT, camera at z = 0. The camera height in file units is
 *   recovered per room from h1_TEXPAR_V.json (see cameraHeightFromTexpar), and
 *   that value tells the two apart: ~1.0 means normalised.
 */
import * as THREE from 'three';

const IN2M = 0.0254;
const DEFAULT_CAMERA_HEIGHT_M = 52 * IN2M; // 1.3208 -- the usual task value

/* ======================================================================= *
 * Binary readers -- no three.js, testable in node.
 * ======================================================================= */

/** Floor/ceiling/wall record: cornernum, 20 xyz slots, 20 uv slots, filename. */
function readRecord(dv, o, stride) {
  const n = Math.min(Math.max(dv.getInt32(o, true), 0), 20);
  const pts = [], uvs = [];
  for (let i = 0; i < n; i++) {
    pts.push([dv.getFloat32(o + 4 + i * 12, true),
              dv.getFloat32(o + 8 + i * 12, true),
              dv.getFloat32(o + 12 + i * 12, true)]);
    uvs.push([dv.getFloat32(o + 244 + i * 8, true),
              dv.getFloat32(o + 248 + i * 8, true)]);
  }
  // The crop this surface is textured with, e.g. "Kitchen_003.jpg". Reading
  // it from the record rather than guessing "<id>_<index>" keeps walls
  // right when hidden (doorway) walls were skipped and the indices have gaps.
  const file = readCString(dv, o + stride - 260, 260);
  return { pts, uvs, file };
}

function readCString(dv, o, max) {
  let s = '';
  for (let k = 0; k < max && o + k < dv.byteLength; k++) {
    const ch = dv.getUint8(o + k);
    if (ch === 0) break;
    s += String.fromCharCode(ch);
  }
  return s;
}

/**
 * Parses a .floorbine (668-byte records) or .floorbin (664) file.
 * Tries the stride the extension implies first and the other one if that
 * doesn't consume the file exactly -- a mislabelled file still loads.
 */
export function readFloorFile(buffer, preferredStride = 668) {
  const strides = preferredStride === 664 ? [664, 668] : [668, 664];
  let lastError = null;
  for (const stride of strides) {
    try {
      const rooms = readFloorWithStride(buffer, stride);
      return { rooms, stride };
    } catch (e) { lastError = e; }
  }
  throw lastError;
}

function readFloorWithStride(buffer, stride) {
  const dv = new DataView(buffer);
  const panos = dv.getInt32(0, true);
  if (panos <= 0 || panos > 4096) throw new Error(`not a floor file (pano count ${panos})`);
  let off = 4;
  const rooms = [];
  for (let p = 0; p < panos; p++) {
    const floorRec = readRecord(dv, off, stride);
    const ceilRec = readRecord(dv, off + stride, stride);
    off += stride * 2;
    const wallCount = dv.getInt32(off, true);
    if (wallCount < 0 || wallCount > 64) throw new Error(`bad wall count ${wallCount}`);
    off += 4;
    const wallRecs = [];
    for (let w = 0; w < wallCount; w++) { wallRecs.push(readRecord(dv, off, stride)); off += stride; }

    const t = off;
    const pos = [dv.getFloat32(t, true), dv.getFloat32(t + 4, true), dv.getFloat32(t + 8, true)];
    const scale = dv.getFloat32(t + 12, true);
    const pivotZ = dv.getFloat32(t + 16, true);
    const ceilZ = dv.getFloat32(t + 20, true);
    const yaw = dv.getFloat32(t + 24, true);
    const imageName = readCString(dv, t + 32, 260);               // "<imgId>.jpg"
    const tail = dv.getInt32(t + 32 + 260, true);
    if (tail < 0 || tail > 4096) throw new Error(`bad tail count ${tail}`);
    off = t + 32 + 260 + 4 + tail * 8;
    if (off > dv.byteLength) throw new Error('truncated floor file');

    const id = imageName.replace(/\.[^.]+$/, '') ||
               floorRec.file.replace(/_\d{3}\.[^.]+$/, '');
    rooms.push({ id, imageName: imageName || `${id}.jpg`, floorRec, ceilRec, wallRecs,
                 pos, scale, pivotZ, ceilZ, yaw });
  }
  if (off !== dv.byteLength) throw new Error(`stride ${stride}: ${dv.byteLength - off} trailing bytes`);
  return rooms;
}

/** House container: floor count, then filename / "x y z" / yaw, three lines each. */
export function readHouseFile(text) {
  const L = text.split('\n').map(s => s.replace(/\r$/, '').trim()).filter(Boolean);
  const n = parseInt(L[0], 10);
  if (!(n > 0)) throw new Error('not a house file');
  const out = [];
  for (let i = 1; i + 2 < L.length + 1 && out.length < n; i += 3) {
    const xyz = (L[i + 1] || '').split(/\s+/).map(Number);
    out.push({ file: L[i], off: [xyz[0] || 0, xyz[1] || 0, xyz[2] || 0], yaw: Number(L[i + 2]) || 0 });
  }
  return out;
}

const median = values => {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : null;
};

/**
 * Camera height ABOVE THE FLOOR, in floor-file units, for one room.
 *
 * h1_TEXPAR_V.json lists the raw equirect UV of every floor corner (_000) and
 * the ceiling corner above it (_001) in the same order. For one corner at
 * horizontal distance d: d*tan(floor pitch) = camH and
 * d*tan(ceiling pitch) = ceilH - camH, so d cancels and
 *     camH = ceilH * tf / (tf + tc)
 * using nothing but the photo angles and the room height from the floor file.
 * Unit-agnostic and per room. On the reference house it returns 1.3208 for
 * eight rooms and 1.4421 for the one captured higher -- the exact values the
 * GLB export carries.
 */
export function cameraHeightFromTexpar(pano, ceilHeightUnits) {
  if (!pano || !(ceilHeightUnits > 0)) return null;
  const bySuffix = {};
  for (const t of pano.texspar || []) bySuffix[String(t.outtexname).slice(-3)] = t.inPix || [];
  const floor = bySuffix['000'], ceil = bySuffix['001'];
  if (!floor || !ceil || !floor.length) return null;
  const ratios = [];
  for (let i = 0; i < Math.min(floor.length, ceil.length); i++) {
    // v's origin (top or bottom) varies by writer; only |pitch| matters.
    const tf = Math.abs(Math.tan((0.5 - floor[i].y) * Math.PI));
    const tc = Math.abs(Math.tan((0.5 - ceil[i].y) * Math.PI));
    if (tf + tc > 1e-9) ratios.push(tf / (tf + tc));
  }
  const r = median(ratios);
  return r === null ? null : r * ceilHeightUnits;
}

/* ======================================================================= *
 * Navigation hotspots from h1_HOTSPOT_V.json.
 * ======================================================================= */

/** "Dining-Room" -> "Dining Room", the same clean-up GLBExporter applies. */
export function displayName(id) {
  const s = String(id || '').replace(/\s+\d+$/, '').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  return s || 'Room';
}

const wrapPi = a => {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
};

/**
 * Converts h1_HOTSPOT_V.json into the hotspot-config.js shape hotspots.js
 * already consumes, so the panorama view needs no second code path.
 *
 * theta: Deg.y is the hotspot's panorama azimuth in degrees -- the same
 *   (u - 0.5) * 2pi the GLB export writes, just in degrees and 0..360.
 * phi:   the pitch is read back off HSLoc as atan2(depth, distance). That
 *   ratio is independent of the camera height the exporter used and of which
 *   horizontal frame HSLoc is in, so it is exact for old and new exports.
 *   HSLoc of (0,0,0) means the old exporter dropped a hotspot that sat at or
 *   above the horizon; those get a default just below it.
 */
export function hotspotConfigFromHotspotV(json, names = {}, { defaultPhi = Math.PI / 2 + 0.15 } = {}) {
  const hotspotData = [];
  const roomConnections = {};
  const warnings = [];
  const nameOf = id => names[id] || displayName(id);

  for (const entry of json?.HOTSPOTOFROOM || []) {
    const from = String(entry.IDName || '').replace(/\.[^.]+$/, '');
    const degs = entry.Deg?.Vector || [];
    const locs = entry.HSLoc?.Coordinate || [];
    const tos = entry.ToIDName?.IDName || [];
    if (degs.length !== tos.length) {
      // Older exports appended Deg/HSLoc for hotspots whose target was
      // missing but skipped the target, so the arrays can be misaligned.
      // Only the common prefix is trustworthy.
      warnings.push(`${from}: ${degs.length} hotspot(s) but ${tos.length} target(s) -- ` +
                    'arrays are misaligned (re-export with the fixed exporter); using the first ' +
                    `${Math.min(degs.length, tos.length)}`);
    }
    for (let k = 0; k < Math.min(degs.length, tos.length); k++) {
      const to = String(tos[k]).replace(/\.[^.]+$/, '');
      const theta = wrapPi((Number(degs[k].y) || 0) * Math.PI / 180);
      const L = locs[k] || { x: 0, y: 0, z: 0 };
      const dist = Math.hypot(Number(L.x) || 0, Number(L.z) || 0);
      const depth = -(Number(L.y) || 0);
      const phi = (dist > 1e-6 || Math.abs(depth) > 1e-6)
        ? Math.PI / 2 + Math.atan2(depth, dist)
        : defaultPhi;
      hotspotData.push({
        theta, phi, radius: 480, color: 0xff6600,
        name: nameOf(to),
        panoramaImage: `panos/${to}.jpg`,
        fromRoom: from
      });
      (roomConnections[nameOf(from)] ||= []).push(nameOf(to));
    }
  }
  return { hotspotData, roomConnections, warnings };
}

/* ======================================================================= *
 * Fetching.
 * ======================================================================= */

async function fetchOk(url, as) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return as === 'text' ? res.text() : as === 'json' ? res.json() : res.arrayBuffer();
}

async function tryFetch(url, as) {
  try { return await fetchOk(url, as); } catch { return null; }
}

/** Returns the first URL that answers a HEAD (or GET) with 2xx, else null. */
export async function firstExisting(urls) {
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: 'HEAD' });
      if (res.ok) return url;
    } catch { /* try the next one */ }
  }
  return null;
}

/* ======================================================================= *
 * Loading + building.
 * ======================================================================= */

/**
 * @param {object} opts
 * @param {string} opts.houseUrl     URL of h1.housebine / h1.housebin
 * @param {'auto'|'metres'|'cameraHeights'} [opts.units]
 * @param {number} [opts.cameraHeightInches]  real camera height for normalised captures
 * @param {boolean} [opts.applyFloorOffsetXY=true]
 * @param {(p:{loaded:number,total:number,percentage:number})=>void} [opts.onProgress]
 * @returns {Promise<{floors, rooms, hotspotConfig, warnings, units, metresPerUnit}>}
 */
export async function loadHousebin(opts) {
  const {
    houseUrl, units = 'auto', cameraHeightInches = null,
    applyFloorOffsetXY = true, onProgress = () => {}
  } = opts;
  const dir = houseUrl.slice(0, houseUrl.lastIndexOf('/') + 1);
  const rawVariant = /\.housebin$/i.test(houseUrl);
  const warnings = [];

  const entries = readHouseFile(await fetchOk(houseUrl, 'text'));

  // Sidecars are optional; the shell builds without any of them.
  const [texpar, hotspotV, relation] = await Promise.all([
    tryFetch(`${dir}h1_TEXPAR_V.json`, 'json'),
    tryFetch(`${dir}h1_HOTSPOT_V.json`, 'json'),
    tryFetch(`${dir}relation.json`, 'json').then(j => j || tryFetch(`${dir}../relation.json`, 'json'))
  ]);

  const names = {};
  for (const p of relation?.panos || []) if (p.id && p.name) names[String(p.id)] = p.name;

  const texparById = {};
  for (const p of texpar?.Pano || []) texparById[String(p.imgid).replace(/\.[^.]+$/, '')] = p;

  // HSLoc.y is -cameraHeight (metres) -- a last-resort camera height.
  const hslocCamById = {};
  for (const e of hotspotV?.HOTSPOTOFROOM || []) {
    const y = e.HSLoc?.Coordinate?.find(c => Number(c.y) < 0)?.y;
    if (y !== undefined) hslocCamById[String(e.IDName).replace(/\.[^.]+$/, '')] = -Number(y);
  }

  // ── floors ────────────────────────────────────────────────────────────
  const floors = [];
  for (const [index, entry] of entries.entries()) {
    const buf = await tryFetch(dir + entry.file, 'buffer');
    if (!buf) { warnings.push(`missing floor file ${entry.file}`); continue; }
    try {
      const { rooms, stride } = readFloorFile(buf, /\.floorbin$/i.test(entry.file) ? 664 : 668);
      floors.push({ ...entry, index, rooms, stride });
    } catch (e) {
      warnings.push(`${entry.file}: ${e.message}`);
    }
  }
  if (!floors.length) throw new Error(`no readable floor files listed in ${houseUrl}`);

  // ── per-room vertical facts, in file units ────────────────────────────
  const allRooms = floors.flatMap(f => f.rooms);
  for (const room of allRooms) {
    const zFloor = median(room.floorRec.pts.map(p => p[2])) ?? -1;
    const zCeilCorners = median(room.ceilRec.pts.map(p => p[2]));
    const zCeil = zCeilCorners ?? room.ceilZ;
    room.up = zCeil < zFloor ? -1 : 1;
    room.zFloor = zFloor;
    // Height of this room's floor above its floor file's base -- a stair
    // landing or split-level room. The Qt exporter keeps every room's corners
    // floor-at--1 and stores the room's level in position.z, so the height is
    // position.z minus the room's own floor corners. Files written before
    // that (and files from the original capture tool, whose position.z is
    // bit-for-bit the floor corner z) give 0: no change for them.
    const e = (room.pos[2] - zFloor) * room.up;
    room.elevationUnits = Math.abs(e) > 1e-4 ? e : 0;
    room.ceilHeightUnits = Math.abs(zCeil - zFloor);
    room.camHeightUnits = cameraHeightFromTexpar(texparById[room.id], room.ceilHeightUnits);
    room.camSource = room.camHeightUnits ? 'texpar' : null;
  }

  // The raw .floorbin variant is the edit variant divided by a per-house
  // constant K; with the Qt writer's floor pinned at -1 in the edit file,
  // |raw floor z| = 1/K gives it back.
  let kRaw = 1;
  if (rawVariant) {
    const zf = median(allRooms.map(r => Math.abs(r.zFloor)));
    if (zf && zf > 0.2 && zf < 1.0) kRaw = 1 / zf;
    if (Math.abs(kRaw - 1) > 1e-4) {
      warnings.push(`raw .floorbin variant: rescaling by K = ${kRaw.toFixed(5)} (prefer h1.housebine)`);
    }
  }

  // ── units ─────────────────────────────────────────────────────────────
  const camMedian = median(allRooms.map(r => r.camHeightUnits));
  let mode = units;
  if (mode === 'auto') {
    if (camMedian !== null) {
      mode = Math.abs(camMedian - 1) < 0.08 ? 'cameraHeights' : 'metres';
    } else {
      // The Qt writer stores trailing position.z as exactly -1 (the pinned
      // floor); the original tool stored -cameraHeight, rarely exactly -1.
      const pinned = allRooms.filter(r => Math.abs(r.pos[2] + 1) < 1e-6).length;
      mode = pinned >= allRooms.length / 2 ? 'metres' : 'cameraHeights';
    }
  }
  const realCamM = (cameraHeightInches ? cameraHeightInches * IN2M : DEFAULT_CAMERA_HEIGHT_M);
  const metresPerUnit = (mode === 'cameraHeights' ? realCamM : 1) * kRaw;

  for (const room of allRooms) {
    if (!room.camHeightUnits) {
      if (mode === 'cameraHeights') {
        // Normalised captures put the camera at z = 0.
        room.camHeightUnits = Math.abs(0 - room.zFloor) || 1;
        room.camSource = 'normalised';
      } else if (hslocCamById[room.id] && !rawVariant) {
        room.camHeightUnits = hslocCamById[room.id];
        room.camSource = 'hotspot';
      } else {
        room.camHeightUnits = DEFAULT_CAMERA_HEIGHT_M / kRaw;
        room.camSource = 'default';
      }
    }
  }

  // ── build ─────────────────────────────────────────────────────────────
  const textures = new TextureCache(dir, onProgress);
  const builtFloors = floors.map((floor, fi) => {
    const label = floorLabel(floor.file, fi);
    const group = new THREE.Group();
    group.name = label;
    let panoNo = 0;
    for (const room of floor.rooms) {
      const node = buildRoom(room, floor, fi, label, ++panoNo, {
        s: metresPerUnit, applyFloorOffsetXY, names, textures
      });
      if (node) group.add(node);
    }
    return { key: label, label, index: fi, group, file: floor.file };
  });
  // FloorManager keys floors by name, so two files that prettify alike
  // ("f1" and "floor1") must not collide.
  const seen = new Map();
  for (const f of builtFloors) {
    const n = seen.get(f.key) || 0;
    seen.set(f.key, n + 1);
    if (n) { f.key = f.label = `${f.key} (${n + 1})`; f.group.name = f.key; }
  }

  await textures.done();
  warnings.push(...textures.warnings);

  const hotspotConfig = hotspotV ? buildHotspotConfig(hotspotV, allRooms, names) : null;
  if (hotspotConfig) warnings.push(...hotspotConfig.warnings);

  const rooms = allRooms.map(r => ({
    id: r.id, name: names[r.id] || displayName(r.id),
    cameraHeightM: r.camHeightUnits * metresPerUnit, cameraSource: r.camSource,
    ceilingHeightM: r.ceilHeightUnits * metresPerUnit,
    elevationM: r.elevationUnits * metresPerUnit
  }));

  return { floors: builtFloors, rooms, hotspotConfig, warnings, units: mode, metresPerUnit };
}

function buildHotspotConfig(hotspotV, allRooms, names) {
  const { hotspotData, roomConnections, warnings } = hotspotConfigFromHotspotV(hotspotV, names);
  const ids = [...new Set(allRooms.map(r => r.id))].sort();
  const availablePanoramas = ids.map(id => `panos/${id}.jpg`);
  const modelToPanoramaMapping = ids.map((id, i) => ({
    nodeNamePatterns: [id.toLowerCase()],
    fallbackIndex: i,
    panoramaImage: `panos/${id}.jpg`,
    displayName: names[id] || displayName(id)
  }));
  return { hotspotData, roomConnections, availablePanoramas, modelToPanoramaMapping, warnings };
}

/**
 * The floor's name exactly as saved: the house file lists each floor by the
 * file name it was saved under ("f1.floorbine", "Basement.floorbine"), so the
 * name is that file's stem, unchanged.
 */
export function floorLabel(file, index) {
  const stem = String(file || '').replace(/\.floorbine?$/i, '');
  return stem.trim() ? stem : `Floor ${index + 1}`;
}

/* ----------------------------------------------------------------------- */

class TextureCache {
  constructor(dir, onProgress) {
    this.dir = dir;
    this.loader = new THREE.TextureLoader();
    this.pending = [];
    this.cache = new Map();
    this.users = new Map();   // file -> materials using it
    this.loaded = 0;
    this.total = 0;
    this.warnings = [];
    this.onProgress = onProgress;
  }

  get(file) {
    if (!file) return null;
    if (this.cache.has(file)) return this.cache.get(file);
    const texture = new THREE.Texture();
    this.cache.set(file, texture);
    this.total++;
    const p = new Promise(resolve => {
      this.loader.load(this.dir + encodeURIComponent(file).replace(/%2F/g, '/'), tex => {
        texture.image = tex.image;
        texture.needsUpdate = true;
        this._tick(); resolve();
      }, undefined, () => {
        this.warnings.push(`missing crop ${file}`);
        texture.userData.missing = true;
        // Fall back to a flat colour rather than a black, image-less texture.
        for (const mat of this.users.get(file) || []) {
          mat.map = null;
          mat.color.set(0xbfc7d5);
          mat.needsUpdate = true;
        }
        this._tick(); resolve();
      });
    });
    // glTF conventions: v = 0 is the TOP of the image. See the UV note in buildSurface().
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    this.pending.push(p);
    return texture;
  }

  /** Records that `material` samples `file`, so a missing crop can be patched. */
  bind(material, file) {
    if (!this.users.has(file)) this.users.set(file, []);
    this.users.get(file).push(material);
  }

  _tick() {
    this.loaded++;
    this.onProgress({
      loaded: this.loaded, total: this.total,
      percentage: Math.round((this.loaded / Math.max(1, this.total)) * 100)
    });
  }

  done() { return Promise.all(this.pending); }
}

/**
 * One room, as the GLB exporter lays it out. Local frame: origin on the
 * FLOOR directly below the camera, Y up, X = -x, Z = y.
 */
function buildRoom(room, floor, floorIndex, floorName, panoNo, ctx) {
  const { s, applyFloorOffsetXY, names, textures } = ctx;
  if (room.floorRec.pts.length < 3) return null;

  // House placement: floorOffset + Rz(floorYaw) * pos, yaw adds.
  const fc = Math.cos(floor.yaw), fs = Math.sin(floor.yaw);
  const ox = applyFloorOffsetXY ? floor.off[0] : 0;
  const oy = applyFloorOffsetXY ? floor.off[1] : 0;
  const px = ox + room.pos[0] * fc - room.pos[1] * fs;
  const py = oy + room.pos[0] * fs + room.pos[1] * fc;

  const id = room.id;
  const label = names[id] || displayName(id);

  const roomNode = new THREE.Group();
  roomNode.name = `${label} Room`;
  roomNode.position.set(-px * s, (floor.off[2] + room.elevationUnits) * s, py * s);
  roomNode.rotation.set(0, floor.yaw + room.yaw, 0);
  roomNode.userData = {
    roomId: id,
    cameraHeight: room.camHeightUnits * s,
    ceilingHeight: room.ceilHeightUnits * s,
    elevation: room.elevationUnits * s,
    floorIndex, floorName,
    source: 'housebin'
  };

  const toLocal = ([x, y, z]) => new THREE.Vector3(-x * s, (z - room.zFloor) * room.up * s, y * s);
  const camera = new THREE.Vector3(0, room.camHeightUnits * s, 0);
  // The room outline in local plan (X, Z) -- decides which side of each
  // wall is outside. See buildSurface().
  const outline = room.floorRec.pts.map(toLocal).map(v => [v.x, v.z]);

  // Surfaces: floor (crop _000), ceiling (_001), walls (_002...).
  const mesh = new THREE.Group();
  mesh.name = `${label} Mesh`;
  const surfaces = [
    { rec: room.floorRec, kind: 'floor' },
    { rec: room.ceilRec, kind: 'ceiling' },
    ...room.wallRecs.map(rec => ({ rec, kind: 'wall' }))
  ];
  for (const { rec, kind } of surfaces) {
    const m = buildSurface(rec, kind, toLocal, camera, textures, outline);
    if (m) mesh.add(m);
  }
  roomNode.add(mesh);

  // Hotspot anchor, identical to GLBExporter's image-named empty: at camera
  // height, +90deg about X, carrying the roomId hotspots.js maps to a pano.
  const anchor = new THREE.Object3D();
  anchor.name = label;
  anchor.position.copy(camera);
  anchor.rotation.set(Math.PI / 2, 0, 0);
  anchor.userData = { type: 'room_hotspot', roomId: id };
  const inner = new THREE.Object3D();
  inner.name = `Pano ${String(panoNo).padStart(2, '0')} EMPTY`;
  inner.userData = { type: 'panorama_anchor', roomId: id, metaroom3d: true };
  anchor.add(inner);
  roomNode.add(anchor);

  return roomNode;
}

/**
 * One textured polygon. Triangles are wound so their FRONT faces point AWAY
 * from the room's camera -- FloorManager renders every material BackSide, so
 * that is what gives the dollhouse cut-away (walls facing you disappear, the
 * floor shows from above, the ceiling doesn't). Same convention as the GLB.
 *
 * UVs: the Qt bake writes each crop top-down (row 0 = ceiling for walls,
 * max-Y for floors) while the record stores v = 1 at that top edge, so the
 * glTF-convention v is 1 - v_record, with texture.flipY = false.
 */
function insidePolygon([x, z], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function buildSurface(rec, kind, toLocal, camera, textures, outline = null) {
  const n = rec.pts.length;
  if (n < 3) return null;
  const V = rec.pts.map(toLocal);

  // Newell normal + centroid decide which way is "out".
  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = V[i], b = V[(i + 1) % n];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
    centroid.add(a);
  }
  centroid.divideScalar(n);
  if (normal.lengthSq() < 1e-12) return null;
  normal.normalize();

  // Which way is OUT. Floors and ceilings: away from the camera, which is
  // always between them. Walls: the side a step off the wall leaves the
  // room's floor outline -- the rule GLBExporter uses (polygon winding).
  //
  // BUGFIX: walls used "away from the camera" too, which is only true when
  // the camera can see the wall's inner face. In a non-convex room the
  // camera can stand on the OUTSIDE of a wall's plane -- Foyer's 0.649 m jog
  // wall beside the Dining Room doorway, seen from behind in its own
  // panorama -- and that wall came out facing inward, so the dollhouse
  // cut-away culled it from every normal viewing angle.
  let outwardKnown = false;
  if (kind === 'wall' && outline && outline.length >= 3) {
    const h = Math.hypot(normal.x, normal.z);
    if (h > 1e-6) {
      const eps = 0.01;   // 1 cm either side of the wall's base line
      const ahead = [centroid.x + normal.x / h * eps, centroid.z + normal.z / h * eps];
      const behind = [centroid.x - normal.x / h * eps, centroid.z - normal.z / h * eps];
      const inAhead = insidePolygon(ahead, outline), inBehind = insidePolygon(behind, outline);
      if (inAhead !== inBehind) {
        if (inAhead) normal.negate();
        outwardKnown = true;
      }
    }
  }
  if (!outwardKnown && normal.dot(centroid.clone().sub(camera)) < 0) normal.negate();

  // Triangulate in the polygon's own plane (floors can be L/U-shaped, so a
  // fan is not safe).
  const axisU = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0)
                                          : new THREE.Vector3(0, 1, 0).cross(normal).normalize();
  const axisV = normal.clone().cross(axisU).normalize();
  const flat = V.map(p => new THREE.Vector2(p.dot(axisU), p.dot(axisV)));
  let tris = n === 3 ? [[0, 1, 2]] : THREE.ShapeUtils.triangulateShape(flat, []);
  if (!tris.length) tris = Array.from({ length: n - 2 }, (_, i) => [0, i + 1, i + 2]);

  const position = [], uv = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const [a, b, c] of tris) {
    e1.subVectors(V[b], V[a]); e2.subVectors(V[c], V[a]);
    const order = e1.cross(e2).dot(normal) >= 0 ? [a, b, c] : [a, c, b];
    for (const k of order) {
      position.push(V[k].x, V[k].y, V[k].z);
      const [u, v] = rec.uvs[k] || [0, 0];
      uv.push(u, 1 - v);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const map = textures.get(rec.file);
  const material = map
    ? new THREE.MeshBasicMaterial({ map, side: THREE.BackSide })
    : new THREE.MeshBasicMaterial({ color: 0xbfc7d5, side: THREE.BackSide });
  material.name = `${kind} ${rec.file || ''}`.trim();
  if (map) textures.bind(material, rec.file);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${kind}`;
  mesh.userData.surface = kind;
  return mesh;
}
