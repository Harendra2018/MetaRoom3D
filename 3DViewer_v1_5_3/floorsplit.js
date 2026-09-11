/**
 * floorsplit.js -- turn ONE multi-floor GLB into per-floor groups.
 *
 * FloorManager was written for one GLB per floor (floor1.glb, floor2.glb...).
 * The Qt exporter now writes every floor into a single file, already stacked
 * at true height, so the split happens after load instead of on disk.
 *
 * Which floor a room is on, tried in order:
 *
 *   1. Explicit tag on the room node -- extras.floorIndex / floorName (what the
 *      Qt exporter writes now), or floor / level / storey. No guessing.
 *   2. Name prefix "Floor 1/Bedroom" (the housebin -> GLB converter's naming).
 *   3. Height clustering on each room's measured floor level (world bbox
 *      min.y), a new floor wherever the gap exceeds half a storey. Works for
 *      older exports that carry no tags.
 *
 * Nothing is re-stacked: the rooms are already at their real heights, and
 * stacking again would lift the upper floor by its own height a second time.
 */

// GLTFLoader sanitises node names ("Kitchen Room" -> "Kitchen_Room").
const ROOM_SUFFIX = /[ _]Room$/;

/* ------------------------------------------------------------------ *
 * Planning -- pure data, no three.js, unit-testable in node.
 * ------------------------------------------------------------------ */

/**
 * @param {Array<{id:*, name:string, y:number, extras?:object}>} rooms
 *        y = the room's floor level in metres
 * @param {{gap?:number}} [opts]
 * @returns {{method:string, floors:Array<{name:string, index:number, rooms:Array}>}}
 */
export function planFloors(rooms, opts = {}) {
  if (!rooms.length) return { method: 'none', floors: [] };

  const tagged = groupByKey(rooms, r => explicitFloor(r.extras), { allowSingle: true });
  if (tagged) return finish('tag', tagged);

  const prefixed = groupByKey(rooms, r => namePrefix(r.name));
  if (prefixed) return finish('name', prefixed);

  return finish('height', clusterByHeight(rooms, opts.gap ?? autoGap(rooms)));
}

/** { key, label } from a room's extras, or null when it carries no floor tag. */
function explicitFloor(extras) {
  if (!extras) return null;
  const idx = extras.floorIndex ?? extras.floor ?? extras.level ?? extras.storey;
  const name = typeof extras.floorName === 'string' && extras.floorName.trim()
    ? extras.floorName.trim() : null;
  if (idx !== undefined && idx !== null && idx !== '') {
    return { key: `i:${idx}`, label: name, order: Number(idx) };
  }
  if (name) return { key: `n:${name}`, label: name, order: null };
  return null;
}

function namePrefix(name) {
  const i = (name || '').indexOf('/');
  return i > 0 ? { key: `p:${name.slice(0, i)}`, label: name.slice(0, i), order: null } : null;
}

/** Groups rooms by key; null if any room lacks one (or only one bucket, unless allowed). */
function groupByKey(rooms, keyOf, { allowSingle = false } = {}) {
  const buckets = new Map();
  for (const room of rooms) {
    const k = keyOf(room);
    if (k === null) return null;
    if (!buckets.has(k.key)) buckets.set(k.key, { label: k.label, order: k.order, members: [] });
    buckets.get(k.key).members.push(room);
  }
  if (buckets.size > 1 || (allowSingle && buckets.size === 1)) return buckets;
  return null;
}

/** Half a storey, from whatever the file declares; 1.2 m if it declares none. */
function autoGap(rooms) {
  const heights = rooms
    .map(r => r.extras?.ceilingHeight)
    .filter(h => typeof h === 'number' && h > 0.5);
  return heights.length ? Math.min(...heights) * 0.5 : 1.2;
}

function clusterByHeight(rooms, gap) {
  const sorted = [...rooms].sort((a, b) => a.y - b.y);
  const buckets = new Map();
  let index = 0;
  let previous = null;
  for (const room of sorted) {
    if (previous !== null && room.y - previous > gap) index++;
    previous = room.y;
    const key = `h:${index}`;
    if (!buckets.has(key)) buckets.set(key, { label: null, order: index, members: [] });
    buckets.get(key).members.push(room);
  }
  return buckets;
}

/** Buckets -> floors, lowest first, with display names. */
function finish(method, buckets) {
  const floors = [...buckets.values()]
    .map(b => ({
      label: b.label,
      order: b.order,
      low: Math.min(...b.members.map(r => r.y)),
      rooms: b.members
    }))
    // Explicit indices win; otherwise order by height.
    .sort((a, b) => (a.order !== null && b.order !== null && a.order !== b.order)
      ? a.order - b.order : a.low - b.low)
    .map((f, i) => ({ name: prettyName(f.label, i), index: i, rooms: f.rooms }));

  // Keys must be unique -- FloorManager keys floors by name.
  const seen = new Map();
  for (const f of floors) {
    const n = seen.get(f.name) || 0;
    seen.set(f.name, n + 1);
    if (n) f.name = `${f.name} (${n + 1})`;
  }
  return { method, floors };
}

/**
 * The floor's name exactly as it was saved in the Qt app ("f1", "Floor 1",
 * "Basement"...) -- never rewritten. Only a floor that carries no name at all
 * (an untagged GLB split by height) gets a generated "Floor N".
 */
export function prettyName(label, index) {
  if (label === null || label === undefined || String(label).trim() === '') return `Floor ${index + 1}`;
  return String(label);
}

/* ------------------------------------------------------------------ *
 * three.js half.
 * ------------------------------------------------------------------ */

/**
 * The export root is GLTFLoader's "Scene" wrapping one "MetaRoom3D" node;
 * rooms are that node's children. Falls back to the scene itself for files
 * with no wrapper.
 */
function findContainer(root) {
  let node = root;
  while (node.children.length === 1 && node.children[0].children.length > 0 &&
         !isRoomNode(node.children[0])) {
    node = node.children[0];
  }
  return node;
}

function isRoomNode(child) {
  return child.userData?.roomId !== undefined || ROOM_SUFFIX.test(child.name || '');
}

function hasMesh(node) {
  let found = false;
  node.traverse(c => { if (c.isMesh) found = true; });
  return found;
}

export function collectRoomNodes(root) {
  const container = findContainer(root);
  return container.children.filter(child => isRoomNode(child) || hasMesh(child));
}

/**
 * Splits gltf.scene into one THREE.Group per floor.
 *
 * @param {THREE.Object3D} scene   gltf.scene straight from GLTFLoader
 * @param {typeof import('three')} THREE
 * @param {object} [opts]          passed through to planFloors
 * @returns {{floors: Array<{name:string, group:THREE.Group, rooms:string[]}>, method:string}}
 */
export function splitIntoFloors(scene, THREE, opts = {}) {
  scene.updateMatrixWorld(true);
  const container = findContainer(scene);
  const nodes = collectRoomNodes(scene);

  const box = new THREE.Box3();
  const plan = planFloors(nodes.map((node, i) => {
    box.setFromObject(node);
    return {
      id: i,
      name: node.name,
      y: Number.isFinite(box.min.y) ? box.min.y : node.getWorldPosition(new THREE.Vector3()).y,
      extras: node.userData
    };
  }), opts);

  // Anything at the container level that isn't a room (a stray empty from a
  // Blender-authored file, say) goes with the floor whose level is nearest
  // its height, rather than being silently dropped by the split.
  const used = new Set(plan.floors.flatMap(f => f.rooms.map(r => r.id)));
  const leftovers = container.children.filter(c => !nodes.includes(c) || !used.has(nodes.indexOf(c)));
  const levels = plan.floors.map(f => Math.min(...f.rooms.map(r => r.y)));
  const extra = plan.floors.map(() => []);
  const wp = new THREE.Vector3();
  for (const node of leftovers) {
    if (!plan.floors.length) break;
    const y = node.getWorldPosition(wp).y;
    let best = 0;
    levels.forEach((l, i) => { if (l <= y + 0.25 && l >= levels[best] - 1e-9) best = i; });
    extra[best].push(node);
  }

  const floors = plan.floors.map((entry, fi) => {
    const group = new THREE.Group();
    group.name = entry.name;
    // Keep the export root's own transform so each room stays exactly where
    // it was before the split.
    container.updateMatrixWorld(true);
    container.matrixWorld.decompose(group.position, group.quaternion, group.scale);
    for (const r of entry.rooms) group.add(nodes[r.id]);   // .add() reparents, local transform kept
    for (const node of extra[fi]) group.add(node);
    return { name: entry.name, group, rooms: entry.rooms.map(r => r.name) };
  });

  return { floors, method: plan.method };
}
