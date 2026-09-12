/**
 * measurements.js -- room width / length / area, and wall lengths for the
 * floor plan view.
 *
 * Everything is measured from the loaded 3D model itself, so it works the
 * same for every tour format (one GLB per floor, one all-floors GLB, or a
 * housebin), and hidden walls are skipped automatically: a wall the editor
 * hid (a doorway, an open side) has no wall geometry in any of those
 * exports, so it simply isn't found.
 *
 * Definitions match the Qt editor's W / L / Area readout exactly:
 *   width, length -- the room's bounding rectangle in its own dominant wall
 *                    direction (RoomLayoutModel::footprintBoundingSize():
 *                    wall directions averaged under 90-degree symmetry,
 *                    weighted by wall length), W along the room's x axis.
 *   area          -- the true floor polygon area (shoelace), so an L-shaped
 *                    room reads its real footprint, not its bounding box.
 *   wall length   -- floor corner to floor corner.
 *
 * Units: imperial by default (10' 2", sq ft). Set
 *   window.MEASUREMENT_UNITS = 'metric';
 * before the viewer starts for metres.
 */
import * as THREE from 'three';

const M_PER_FT = 0.3048;

/* ======================================================================= *
 * Formatting
 * ======================================================================= */

export function formatLength(m, units = currentUnits()) {
  if (units === 'metric') return `${m.toFixed(2)} m`;
  let inches = Math.round((m / M_PER_FT) * 12);
  const feet = Math.floor(inches / 12);
  inches -= feet * 12;
  return `${feet}' ${inches}"`;
}

export function formatArea(m2, units = currentUnits()) {
  if (units === 'metric') return `${m2.toFixed(1)} m²`;
  return `${Math.round(m2 / (M_PER_FT * M_PER_FT))} sq ft`;
}

function currentUnits() {
  return (typeof window !== 'undefined' && window.MEASUREMENT_UNITS === 'metric') ? 'metric' : 'imperial';
}

/* ======================================================================= *
 * Geometry -- pure functions on plan (x, z) points
 * ======================================================================= */

/** Shoelace area of a closed polygon [[x, z], ...]. */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(a) / 2;
}

/**
 * Width/length exactly as RoomLayoutModel::footprintBoundingSize(): rotate
 * into the dominant Manhattan wall frame (4x-angle average, length
 * weighted; 0 for fewer than 4 corners), then take the extents.
 */
export function boundingSize(poly) {
  const n = poly.length;
  let theta = 0;
  if (n >= 4) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const phi = Math.atan2(dy, dx);
      s += len * Math.sin(4 * phi);
      c += len * Math.cos(4 * phi);
    }
    if (s !== 0 || c !== 0) theta = Math.atan2(s, c) / 4;
  }
  const ct = Math.cos(-theta), st = Math.sin(-theta);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of poly) {
    const x = px * ct - py * st, y = px * st + py * ct;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return { width: maxX - minX, length: maxY - minY };
}

/**
 * The outer boundary of a set of floor triangles, as one closed loop of
 * corners. Boundary edges are the ones used by exactly one triangle; a
 * tessellated floor's in-between points on a straight edge are dropped so
 * each side comes back as one wall-length segment.
 */
export function outlineFromTriangles(tris) {
  const key = p => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  const pts = new Map();
  const edges = new Map();
  for (const t of tris) {
    const k = t.map(p => { const kk = key(p); pts.set(kk, p); return kk; });
    for (let i = 0; i < 3; i++) {
      const a = k[i], b = k[(i + 1) % 3];
      if (a === b) continue;
      const e = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(e, (edges.get(e) || 0) + 1);
    }
  }
  const next = new Map();
  for (const [e, count] of edges) {
    if (count !== 1) continue;
    const [a, b] = e.split('|');
    if (!next.has(a)) next.set(a, []);
    if (!next.has(b)) next.set(b, []);
    next.get(a).push(b);
    next.get(b).push(a);
  }
  // Walk every loop; keep the largest (the room's outline).
  const seen = new Set();
  let best = [];
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [start];
    seen.add(start);
    let prev = null, cur = start;
    for (let guard = 0; guard < 100000; guard++) {
      const nb = (next.get(cur) || []).find(x => x !== prev && (!seen.has(x) || (x === start && loop.length > 2)));
      if (!nb || nb === start) break;
      loop.push(nb); seen.add(nb); prev = cur; cur = nb;
    }
    const poly = loop.map(k => pts.get(k));
    if (poly.length >= 3 && polygonArea(poly) > polygonArea(best.length >= 3 ? best : [[0, 0], [0, 0], [0, 0]])) best = poly;
  }
  return simplifyCollinear(best);
}

function simplifyCollinear(poly, tolerance = 0.005) {
  let pts = poly.slice();
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (len < 1e-9) { pts.splice(i, 1); changed = true; break; }
      const dist = Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / len;
      if (dist < tolerance) { pts.splice(i, 1); changed = true; break; }
    }
  }
  return pts;
}

/**
 * Splits the floor edge a->b into alternating covered/open sub-segments
 * based on which parts have wall triangles standing on them, 0..1 along
 * the edge. This is the piece that makes a doorway cut into the *middle*
 * of an otherwise straight wall show up as its own labelled segment: the
 * floor's own outline has no corner there (the floor runs straight through
 * the opening), so outlineFromTriangles() alone would only ever see one
 * long straight edge and report a single combined length for it. Walking
 * the actual wall coverage along that edge is the only way to find the
 * doorway's own width.
 *
 * minSeg (metres) absorbs wall-thickness noise -- slivers of coverage
 * shorter than this at a raw-triangle level get merged into their
 * neighbour rather than reported as their own tiny segment.
 *
 * Returns [{ lo, hi, length, covered }, ...] sorted along the edge, always
 * at least one entry for L > 0 (falling back to a single covered/open
 * segment if the wall geometry can't be resolved finely enough).
 */
export function wallIntervals(a, b, wallTris, planeTol = 0.03, minSeg = 0.05) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
  if (L < 1e-6) return [];
  const ux = dx / L, uz = dz / L;

  const raw = [];
  for (const t of wallTris) {
    let lo = Infinity, hi = -Infinity, onLine = true;
    for (const p of t) {
      const rx = p[0] - a[0], rz = p[1] - a[1];
      if (Math.abs(rx * uz - rz * ux) > planeTol) { onLine = false; break; }
      const s = rx * ux + rz * uz;
      lo = Math.min(lo, s); hi = Math.max(hi, s);
    }
    if (!onLine || hi < 0 || lo > L) continue;
    raw.push([Math.max(0, lo), Math.min(L, hi)]);
  }
  raw.sort((p, q) => p[0] - q[0]);

  // Merge raw triangle spans into covered ranges, closing gaps under
  // minSeg (wall-thickness noise, not a real doorway).
  const covered = [];
  for (const [lo, hi] of raw) {
    const last = covered[covered.length - 1];
    if (last && lo <= last[1] + minSeg) last[1] = Math.max(last[1], hi);
    else covered.push([lo, hi]);
  }

  // Walk the covered ranges, filling the gaps between them as open
  // (unwalled) segments -- unless a gap is itself under minSeg, in which
  // case it's noise and gets folded into the covered segment after it.
  const segs = [];
  let cursor = 0;
  for (const [lo, hi] of covered) {
    if (lo - cursor > minSeg) segs.push({ lo: cursor, hi: lo, covered: false });
    segs.push({ lo, hi, covered: true });
    cursor = hi;
  }
  if (L - cursor > minSeg) segs.push({ lo: cursor, hi: L, covered: false });

  return segs.map(s => ({ ...s, length: s.hi - s.lo }));
}

/**
 * How much of the floor edge a->b is covered by wall triangles standing on
 * it, 0..1. A hidden wall has no triangles, so it scores 0; a split wall
 * with only one half hidden still scores ~1 (its other half spans the edge).
 */
export function wallCoverage(a, b, wallTris, planeTol = 0.03) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 1e-6) return 0;
  const segs = wallIntervals(a, b, wallTris, planeTol);
  const covered = segs.filter(s => s.covered).reduce((sum, s) => sum + s.length, 0);
  return covered / L;
}

/* ======================================================================= *
 * Reading rooms out of the scene
 * ======================================================================= */

/** floor / wall / ceiling for one mesh: housebin tags, GLB material names, else null. */
function surfaceKind(mesh) {
  const tag = mesh.userData && mesh.userData.surface;
  if (tag) return tag;
  const name = (mesh.material && mesh.material.name) || mesh.name || '';
  if (/wall/i.test(name)) return 'wall';
  if (/floor/i.test(name)) return 'floor';
  if (/ceil/i.test(name)) return 'ceiling';
  return null;
}

export function isRoomNode(obj) {
  if (!obj.userData || obj.userData.roomId === undefined) return false;
  if (obj.userData.type === 'room_hotspot' || obj.userData.type === 'panorama_anchor') return false;
  let hasMesh = false;
  obj.traverse(c => { if (c.isMesh) hasMesh = true; });
  return hasMesh;
}

/**
 * Measures one room node. Works in the ROOM's own frame, so the result
 * doesn't depend on where the room sits or how the model is spinning.
 */
export function measureRoom(roomNode) {
  roomNode.updateMatrixWorld(true);
  const toRoom = new THREE.Matrix4().copy(roomNode.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const floorTris = [], wallTris = [], untagged = [];
  let floorY = Infinity;

  roomNode.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry || !mesh.geometry.attributes.position) return;
    // Hotspot cylinders etc. live under the anchor, not the room geometry.
    let p = mesh.parent;
    while (p && p !== roomNode) { if (p.userData && p.userData.type === 'room_hotspot') return; p = p.parent; }
    const kind = surfaceKind(mesh);
    m.multiplyMatrices(toRoom, mesh.matrixWorld);
    const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      const tri = [0, 1, 2].map(k => {
        v.fromBufferAttribute(pos, idx ? idx.getX(i + k) : i + k).applyMatrix4(m);
        return [v.x, v.y, v.z];
      });
      if (kind === 'floor') { floorTris.push(tri); tri.forEach(q => { floorY = Math.min(floorY, q[1]); }); }
      else if (kind === 'wall') wallTris.push(tri);
      else if (!kind) untagged.push(tri);
    }
  });

  // Untagged geometry (a hand-made GLB): classify by facing.
  if (!floorTris.length || !wallTris.length) {
    for (const t of untagged) {
      const a = new THREE.Vector3(...t[0]), b = new THREE.Vector3(...t[1]), c = new THREE.Vector3(...t[2]);
      const nrm = b.sub(a).cross(c.sub(a)).normalize();
      if (Math.abs(nrm.y) < 0.2) wallTris.push(t);
      else if (Math.abs(nrm.y) > 0.9) floorTris.push(t);
    }
    if (floorTris.length) {
      // Keep only the lowest horizontal layer as floor (the rest is ceiling).
      const minY = Math.min(...floorTris.flat().map(q => q[1]));
      for (let i = floorTris.length - 1; i >= 0; i--) {
        if (floorTris[i].some(q => q[1] > minY + 0.05)) floorTris.splice(i, 1);
      }
      floorY = minY;
    }
  }
  if (!floorTris.length) return null;

  const plan = t => t.map(q => [q[0], q[2]]);
  const outline = outlineFromTriangles(floorTris.map(plan));
  if (outline.length < 3) return null;
  const wallPlan = wallTris.map(plan);

  const walls = [];
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    const segs = L > 1e-6 ? wallIntervals(a, b, wallPlan) : [];
    if (!segs.length) {
      // Wall geometry couldn't be resolved finely enough (or this edge is
      // itself tiny) -- fall back to one entry spanning the whole edge, as
      // before.
      walls.push({ a, b, length: L, visible: wallCoverage(a, b, wallPlan) > 0.5 });
      return;
    }
    const ux = dx / L, uz = dz / L;
    const pointAt = s => [a[0] + ux * s, a[1] + uz * s];
    for (const seg of segs) {
      walls.push({ a: pointAt(seg.lo), b: pointAt(seg.hi), length: seg.length, visible: seg.covered });
    }
  });

  const { width, length } = boundingSize(outline);
  return {
    roomId: roomNode.userData.roomId,
    node: roomNode,
    floorY: Number.isFinite(floorY) ? floorY : 0,
    outline, walls, width, length,
    area: polygonArea(outline)
  };
}

/** Every room in every loaded floor: { floorKey -> [measurement, ...] }. */
export function measureFloors(floors) {
  const out = {};
  for (const [floorKey, floor] of Object.entries(floors || {})) {
    if (!floor || !floor.model) continue;
    const rooms = [];
    floor.model.traverse(obj => {
      if (!isRoomNode(obj)) return;
      // Nested room nodes (shouldn't happen) -- measure the outermost only.
      let p = obj.parent;
      while (p) { if (isRoomNode(p)) return; p = p.parent; }
      const r = measureRoom(obj);
      if (r) rooms.push({ ...r, floorKey });
    });
    out[floorKey] = rooms;
  }
  return out;
}

/** "13' 10" x 20' 7"  252 sq ft" */
export function roomDimensionText(r, units = currentUnits()) {
  return `${formatLength(r.width, units)} x ${formatLength(r.length, units)}  ${formatArea(r.area, units)}`;
}

/* ======================================================================= *
 * Floor plan wall labels
 * ======================================================================= */

export class WallLengthLabels {
  constructor() {
    this.labels = [];     // { element, anchor, a, b, floorKey, rooms: Set<roomId>, open }
    this.visible = false;
    this.hoveredRoomId = null;   // null = nothing hovered -> all hidden
  }

  /**
   * Builds one label per boundary wall, including open (doorway/missing
   * wall) segments -- those get a lighter, dashed pill so it's clear
   * there's no physical wall there, but the length is never left out.
   * A wall two rooms share is labelled once and remembers both roomIds so
   * hovering either room can reveal it. Anchors are children of the room
   * nodes, so labels follow the model wherever it moves.
   */
  build(measuredFloors, floors) {
    this.clear();
    for (const [floorKey, rooms] of Object.entries(measuredFloors)) {
      const placed = [];   // floor-plan-space segments already labelled on this floor
      const floorModel = (floors && floors[floorKey] && floors[floorKey].model) || null;
      for (const room of rooms) {
        for (const w of room.walls) {
          if (w.length < 0.05) continue;
          const y = room.floorY + 0.02;
          const mk = ([x, z]) => {
            const o = new THREE.Object3D();
            o.position.set(x, y, z);
            o.userData.measurementAnchor = true;
            room.node.add(o);
            return o;
          };
          const a = mk(w.a), b = mk(w.b);
          const mid = mk([(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2]);

          // Shared-wall check in the floor's own frame.
          room.node.updateMatrixWorld(true);
          const pa = toFloorPlan(a, floorModel), pb = toFloorPlan(b, floorModel);
          const existing = placed.find(s => sameSegment(s.pts, pa, pb));
          if (existing) {
            [a, b, mid].forEach(o => room.node.remove(o));
            existing.rooms.add(room.roomId);
            if (existing.label) existing.label.rooms = existing.rooms;
            continue;
          }

          const el = document.createElement('div');
          el.className = 'wall-length-label';
          el.textContent = formatLength(w.length);
          el.dataset.meters = String(w.length);
          Object.assign(el.style, {
            position: 'absolute',
            background: w.visible ? 'rgba(0, 0, 0, 0.85)' : 'rgba(0, 0, 0, 0.55)',
            border: w.visible ? 'none' : '1px dashed rgba(255,255,255,0.85)',
            color: '#fff',
            padding: '3px 10px',
            borderRadius: '999px',
            fontSize: '12px',
            fontWeight: 'bold',
            whiteSpace: 'nowrap',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
            zIndex: '99',
            opacity: '0',
            transition: 'opacity 0.15s ease',
            display: 'none'
          });
          document.body.appendChild(el);

          const rooms = new Set([room.roomId]);
          const label = { element: el, anchor: mid, a, b, floorKey, rooms, open: !w.visible };
          this.labels.push(label);
          placed.push({ pts: [pa, pb], rooms, label });
        }
      }
    }
  }

  clear() {
    for (const l of this.labels) {
      l.element.remove();
      [l.anchor, l.a, l.b].forEach(o => o.parent && o.parent.remove(o));
    }
    this.labels = [];
    this.hoveredRoomId = null;
  }

  /** Reveal only the walls belonging to this room (null clears the reveal). */
  setHoveredRoom(roomId) {
    this.hoveredRoomId = roomId || null;
  }

  /** Called every frame. show=false hides everything (not in floor plan view). */
  update(camera, show, isFloorShown) {
    const w = window.innerWidth, h = window.innerHeight;
    const pm = new THREE.Vector3(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
    for (const l of this.labels) {
      const wanted = show && isFloorShown(l.floorKey) && isAncestorVisible(l.anchor) &&
        this.hoveredRoomId && l.rooms.has(this.hoveredRoomId);
      if (!wanted) {
        if (l.element.style.opacity !== '0') l.element.style.opacity = '0';
        if (l.element.style.display !== 'none') l.element.style.display = 'none';
        continue;
      }
      l.anchor.getWorldPosition(pm).project(camera);
      l.a.getWorldPosition(pa).project(camera);
      l.b.getWorldPosition(pb).project(camera);
      const x = (pm.x * 0.5 + 0.5) * w, y = (-pm.y * 0.5 + 0.5) * h;
      // Shrink (rather than hide) a label that wouldn't fully fit along its
      // wall at this zoom, so short jogs still show a length -- just smaller.
      const screenLen = Math.hypot((pa.x - pb.x) * 0.5 * w, (pa.y - pb.y) * 0.5 * h);
      const offscreen = pm.z > 1 || x < -50 || x > w + 50 || y < -50 || y > h + 50;
      if (offscreen) {
        l.element.style.opacity = '0';
        l.element.style.display = 'none';
        continue;
      }
      l.element.style.display = 'block';
      l.element.style.opacity = '1';
      l.element.style.left = `${x}px`;
      l.element.style.top = `${y}px`;
      const scale = screenLen < 40 ? Math.max(0.65, screenLen / 40) : 1;
      l.element.style.transform = `translate(-50%, -50%) scale(${scale})`;
    }
  }
}

/** A point in its floor's own plan frame (independent of the idle spin). */
function toFloorPlan(obj, floorRoot) {
  const v = obj.getWorldPosition(new THREE.Vector3());
  if (floorRoot) {
    floorRoot.updateMatrixWorld(true);
    floorRoot.worldToLocal(v);
  }
  return [v.x, v.z];
}

function sameSegment([p, q], a, b, tol = 0.1) {
  const d = (u, w) => Math.hypot(u[0] - w[0], u[1] - w[1]);
  // Require the lengths to roughly match too, not just nearby endpoints --
  // otherwise a short jog can falsely dedup against an unrelated segment
  // from a different room where several short walls converge at a corner,
  // silently swallowing the short one's own label.
  const lenPQ = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const lenAB = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (Math.abs(lenPQ - lenAB) > Math.max(0.1, 0.25 * Math.max(lenPQ, lenAB))) return false;
  return (d(p, a) < tol && d(q, b) < tol) || (d(p, b) < tol && d(q, a) < tol);
}

function isAncestorVisible(obj) {
  for (let p = obj; p; p = p.parent) if (p.visible === false) return false;
  return true;
}
