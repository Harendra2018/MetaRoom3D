import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';

// One GLB that already contains every floor -- see floorsplit.js.
import { splitIntoFloors } from './floorsplit.js';

// 🔹 Import advanced line utilities
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';

export class FloorManager {
   constructor(scene) {
     this.scene = scene;
     this.floors = {};
     this.allRotNodes = [];
     this.floorOrder = [];
     this.currentFloorView = 'all';
     this.loader = new GLTFLoader();
     this.loadingCallbacks = [];
     this.progressCallbacks = [];

     // Small vertical gap (meters) inserted between stacked floors, in
     // case slab/ceiling thickness isn't already baked into the models.
     this.floorGap = 0;
     this.totalFloors = 0;
     this.loadedFloors = 0;
   }

  async initializeFloors(floorConfigs) {
    this.clearFloors();

    if (!Array.isArray(floorConfigs) || floorConfigs.length === 0) {
      throw new Error('Floor configurations must be a non-empty array');
    }

    floorConfigs.forEach((config, index) => {
      if (!config.name || !config.modelPath) {
        throw new Error(`Floor config at index ${index} must have 'name' and 'modelPath' properties`);
      }

      // Only treat a config's position as "explicit" (i.e. a manual
      // override that skips auto-stacking) when a y value was actually
      // provided. x/z default to 0; the real y is computed once every
      // floor has loaded, in applyAutoStacking().
      const explicitY = config.position && config.position.y !== undefined;

      this.floors[config.name] = {
        model: null,
        wireframe: null,
        hotspotNodes: [],
        modelPath: config.modelPath,
        position: { x: config.position?.x || 0, y: explicitY ? config.position.y : 0, z: config.position?.z || 0 },
        explicitY,
        loaded: false,
        config: config
      };
    });

    this.floorOrder = floorConfigs.map(c => c.name);
    this.currentFloorView = Object.keys(this.floors).length === 1 ? Object.keys(this.floors)[0] : 'all';
    await this.loadAllFloors();
  }

  async loadAllFloors() {
    this.totalFloors = Object.keys(this.floors).length;
    this.loadedFloors = 0;
    this.emitProgress({ loaded: 0, total: this.totalFloors, percentage: 0 });

    const loadPromises = Object.keys(this.floors).map(floorKey => this.loadFloor(floorKey));

    try {
      await Promise.all(loadPromises);
      console.log('All floors loaded successfully');

      // Every floor's real height is only known once its model has
      // actually loaded, so stacking (and the floor-plan wireframes,
      // which depend on final world position) happen here rather than
      // per-floor as each one comes in.
      this.applyAutoStacking();
      this.floorOrder.forEach(floorKey => this.createWireframeForFloor(floorKey));

      this.emitProgress({ loaded: this.totalFloors, total: this.totalFloors, percentage: 100 });
      setTimeout(() => this.onAllFloorsLoaded(), 100);
    } catch (error) {
      console.error('Error loading floors:', error);
      throw error;
    }
  }

  /**
   * The one-file path: a single GLB holding every floor, each already at
   * its true height. Loads it once, splits the rooms into per-floor groups
   * (floorsplit.js) and registers them, so hotspots, the dropdown, floor-plan
   * wireframes and per-floor visibility behave exactly as they do when each
   * floor arrived as its own file.
   *
   * Auto-stacking is deliberately bypassed -- the rooms are already stacked.
   *
   * @param {string} modelPath   the .glb
   * @param {object} [opts]      forwarded to planFloors ({ gap })
   */
  async initializeFromSingleModel(modelPath, opts = {}) {
    this.clearFloors();
    this.totalFloors = 1;
    this.loadedFloors = 0;
    this.emitProgress({ loaded: 0, total: 1, percentage: 0 });

    const gltf = await new Promise((resolve, reject) => {
      this.loader.load(
        modelPath,
        resolve,
        progress => {
          if (progress.total) {
            this.emitProgress({
              loaded: 0, total: 1,
              percentage: Math.round((progress.loaded / progress.total) * 95)
            });
          }
        },
        reject
      );
    });

    const { floors, method } = splitIntoFloors(gltf.scene, THREE, opts);
    if (!floors.length) throw new Error(`No rooms found in ${modelPath}`);
    console.log(`Split ${modelPath} into ${floors.length} floor(s) by ${method}:`,
      floors.map(f => `${f.name} (${f.rooms.length} rooms)`).join(', '));

    this._registerPrebuiltFloors(floors.map(f => ({ key: f.name, group: f.group })), modelPath);
    return { floors, method };
  }

  /**
   * Floors that were built in code rather than loaded -- the housebin path
   * (housebin.js). Each entry is { key, group }, already at its true height.
   */
  initializeFromPrebuilt(floors, sourceLabel = 'prebuilt') {
    this.clearFloors();
    this.totalFloors = floors.length;
    this._registerPrebuiltFloors(floors, sourceLabel);
  }

  /**
   * Shared tail of the single-GLB and housebin paths.
   *
   * Recentres the house on the world origin: the home/dollhouse cameras aim
   * at (0, y, 0) and the idle spin turns each floor about its own origin, so a
   * house whose first room sat at the origin used to swing round a corner.
   * Each floor becomes an outer group AT the origin (what spins) holding the
   * original group shifted by the house centre (what moves).
   *
   * floor.position.y is set to that floor's measured floor level. Nothing
   * moves it -- getFloorCameraConfig() just reads it to aim the camera.
   */
  _registerPrebuiltFloors(floors, modelPath) {
    const houseBox = new THREE.Box3();
    floors.forEach(({ group }) => {
      group.updateMatrixWorld(true);
      houseBox.expandByObject(group);
    });
    const centre = houseBox.isEmpty() ? new THREE.Vector3() : houseBox.getCenter(new THREE.Vector3());

    floors.forEach(({ key, group }) => {
      const outer = new THREE.Group();
      outer.name = key;
      outer.userData.floorKey = key;
      outer.userData.isFloorGroup = true;
      group.userData.isFloorGroup = true;
      group.position.x -= centre.x;
      group.position.z -= centre.z;
      outer.add(group);
      outer.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(outer);
      const floorLevel = box.isEmpty() ? 0 : box.min.y;

      this.floors[key] = {
        model: outer,
        wireframe: null,
        hotspotNodes: [],
        // Shown in the floor menu exactly as saved in the Qt app.
        label: key,
        modelPath,
        position: { x: 0, y: floorLevel, z: 0 },
        explicitY: true,
        loaded: true,
        config: { name: key, modelPath, single: true }
      };
      this.processFloorModel(key);
    });

    this.floorOrder = floors.map(f => f.key);
    this.currentFloorView = this.floorOrder.length === 1 ? this.floorOrder[0] : 'all';
    this.floorOrder.forEach(k => this.createWireframeForFloor(k));

    this.loadedFloors = this.totalFloors = this.floorOrder.length;
    this.emitProgress({ loaded: this.totalFloors, total: this.totalFloors, percentage: 100 });
    setTimeout(() => this.onAllFloorsLoaded(), 100);
  }

  loadFloor(floorKey) {
    return new Promise((resolve, reject) => {
      const floor = this.floors[floorKey];
      if (!floor) {
        reject(new Error(`Floor '${floorKey}' not found`));
        return;
      }

      console.log(`Loading floor: ${floorKey} from ${floor.modelPath}`);

      this.loader.load(
        floor.modelPath,
        (gltf) => {
          floor.model = gltf.scene;
          floor.model.position.set(0, 0, 0);
          floor.model.userData.floorKey = floorKey;

          this.processFloorModel(floorKey);
          floor.loaded = true;
          this.loadedFloors++;
          const percentage = Math.round((this.loadedFloors / this.totalFloors) * 100);
          this.emitProgress({ loaded: this.loadedFloors, total: this.totalFloors, percentage });
          console.log(`Floor ${floorKey} loaded successfully (${this.loadedFloors}/${this.totalFloors})`);
          resolve(gltf);
        },
        (progress) => {
          const percent = Math.round((progress.loaded / progress.total) * 100);
          console.log(`Loading ${floorKey}: ${percent}%`);
        },
        (error) => {
          console.error(`Error loading floor ${floorKey}:`, error);
          reject(error);
        }
      );
    });
  }

  /**
   * Legacy name-based heuristic for GLBs that carry no explicit hotspot
   * tags (e.g. assets authored directly in Blender via the pano plugin,
   * or older exports). Excludes actual mesh geometry and the
   * "MetaRoom3D" root wrapper in addition to the original "empty"/
   * "plane" checks -- the original heuristic mistakenly matched those
   * too (any node name that didn't contain "empty" or "plane" was
   * accepted, including e.g. "Bedroom-2 Mesh" and "MetaRoom3D" itself).
   * Those nodes carry no pano-anchor tilt, so they rendered as flat/
   * horizontal duplicate hotspots.
   */
  isLegacyHotspotNode(child) {
    if (child.isMesh) return false;
    if (!child.name) return false;
    if (child.userData && child.userData.isFloorGroup) return false;

    const lower = child.name.toLowerCase();
    if (lower === 'scene') return false;
    if (lower === 'metaroom3d') return false;
    if (lower.includes('empty')) return false;
    if (lower.includes('plane')) return false;
    if (lower.includes('mesh')) return false;

    return true;
  }

  processFloorModel(floorKey) {
    const floor = this.floors[floorKey];
    const rotNodes = [];

    // Check once whether this asset was exported with explicit hotspot
    // tags (extras.type === "room_hotspot" on the intended anchor node,
    // surfaced by GLTFLoader as child.userData.type). If any tagged node
    // exists, trust tags EXCLUSIVELY for this floor and skip the legacy
    // name heuristic entirely. Running both checks at once was the bug:
    // the Room container node (e.g. named "Front-Door") has no "empty"/
    // "mesh"/"plane" in its name, so it matched the legacy heuristic
    // *in addition to* the correctly tagged anchor node matching via the
    // tag check -- producing a duplicate "Front-Door" + "Front-Door 1"
    // hotspot for every single room.
    let hasExplicitTags = false;
    floor.model.traverse(child => {
      if (child.userData && child.userData.type === 'room_hotspot') {
        hasExplicitTags = true;
      }
    });

    floor.model.traverse(child => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        // child.material can be an array for multi-material meshes; setting
        // .side directly on the array silently no-ops and leaves whatever
        // the GLB declared (previously doubleSided:true from the exporter,
        // now fixed at the source -- this loop is just defense-in-depth so
        // a stray double-sided material can't slip through either way).
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        mats.forEach(mat => {
          if (mat) mat.side = THREE.BackSide;
        });
      }

      const isHotspot = hasExplicitTags
        ? (child.userData && child.userData.type === 'room_hotspot')
        : this.isLegacyHotspotNode(child);

      if (isHotspot) {
        child.userData.floor = floorKey;
        rotNodes.push(child);
      }
    });

    floor.hotspotNodes = rotNodes;
    this.allRotNodes = this.allRotNodes.concat(rotNodes);
  }

  /**
   * Automatically stacks floors on top of one another using each floor's
   * own measured height, instead of a fixed/manual offset per floor.
   * Runs once every floor model has finished loading (heights aren't
   * known before then). A floor whose config explicitly set a y position
   * is left exactly where the caller put it (and still contributes its
   * measured height to whatever comes after it), so manual overrides
   * still work for the rare case where auto-stacking isn't wanted.
   */
  applyAutoStacking() {
    let runningY = 0;

    this.floorOrder.forEach(floorKey => {
      const floor = this.floors[floorKey];
      if (!floor || !floor.model) return;

      const x = floor.position.x || 0;
      const z = floor.position.z || 0;

      if (floor.explicitY) {
        // Manual override: keep the y the caller specified.
        floor.model.position.set(x, floor.position.y, z);
      } else {
        // Measure this floor's own height at the origin so we can sit
        // its bottom exactly on top of whatever came before it,
        // regardless of where the model's own pivot point is.
        floor.model.position.set(0, 0, 0);
        const localBox = new THREE.Box3().setFromObject(floor.model);
        const bottomOffset = -localBox.min.y;
        const finalY = runningY + bottomOffset;

        floor.model.position.set(x, finalY, z);
        floor.position.y = finalY;
      }

      // Whatever floor comes next (if it's also auto-stacked) starts
      // right at the top of this one.
      const worldBox = new THREE.Box3().setFromObject(floor.model);
      runningY = worldBox.max.y + this.floorGap;
    });
  }

  /**
   * Create cross-section wireframe for floor plan view
   */
  createWireframeForFloor(floorKey, cutHeight = 1.6) {
    const floor = this.floors[floorKey];
    if (!floor.model) return;

    if (floor.wireframe) {
      this.scene.remove(floor.wireframe);
    }
    floor.wireframe = new THREE.Group();

    const box = new THREE.Box3().setFromObject(floor.model);
    const floorLevel = box.min.y;
    const sliceHeight = floorLevel + cutHeight;
    const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), sliceHeight);

    floor.model.traverse(child => {
      if (child.isMesh && child.geometry) {
        const geometry = child.geometry;
        const posAttr = geometry.attributes.position;
        const matrixWorld = child.matrixWorld;
        const segments = [];

        // Indexed (GLB) or not (housebin-built meshes) -- same slice either way.
        const indices = geometry.index
          ? geometry.index.array
          : Array.from({ length: posAttr.count }, (_, i) => i);
        {
          for (let i = 0; i + 2 < indices.length; i += 3) {
            const a = new THREE.Vector3().fromBufferAttribute(posAttr, indices[i]).applyMatrix4(matrixWorld);
            const b = new THREE.Vector3().fromBufferAttribute(posAttr, indices[i + 1]).applyMatrix4(matrixWorld);
            const c = new THREE.Vector3().fromBufferAttribute(posAttr, indices[i + 2]).applyMatrix4(matrixWorld);

            this.addEdgeIntersection(a, b, plane, segments);
            this.addEdgeIntersection(b, c, plane, segments);
            this.addEdgeIntersection(c, a, plane, segments);
          }
        }

        // Build lines for each intersection segment
        segments.forEach(([p1, p2]) => {
          const lineGeom = new LineGeometry();
          lineGeom.setPositions([p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]);

          const lineMat = new LineMaterial({
            color: 0x000000, //FLOOR PLAN COLOR (boundary/wall lines, black)////////////////////////////////////////////////
            linewidth: 4, // adjust thickness
          });
          lineMat.resolution.set(window.innerWidth, window.innerHeight);

          const line = new Line2(lineGeom, lineMat);
          line.computeLineDistances();
          floor.wireframe.add(line);
        });
      }
    });

    floor.wireframe.position.copy(floor.model.position);
    floor.wireframe.visible = false;
  }

  /**
   * Add intersection point of edge with slicing plane (stores pairs)
   */
  addEdgeIntersection(v1, v2, plane, segments) {
    const d1 = plane.distanceToPoint(v1);
    const d2 = plane.distanceToPoint(v2);

    if ((d1 >= 0 && d2 <= 0) || (d1 <= 0 && d2 >= 0)) {
      const t = d1 / (d1 - d2);
      const intersect = new THREE.Vector3().lerpVectors(v1, v2, t);

      // store as a segment
      segments.push([v1.clone(), intersect.clone()]);
      segments.push([intersect.clone(), v2.clone()]);
    }
  }

  onAllFloorsLoaded() {
    // Add all floors to the scene at once
    Object.values(this.floors).forEach(floor => {
      if (floor.model) {
        this.scene.add(floor.model);
      }
      if (floor.wireframe) {
        this.scene.add(floor.wireframe);
      }
    });

    console.log('All floors added to scene at once');

    this.loadingCallbacks.forEach(callback => {
      try {
        callback(this.allRotNodes, this.floors);
      } catch (error) {
        console.error('Error in loading callback:', error);
      }
    });
  }

  onLoaded(callback) {
    if (typeof callback !== 'function') throw new Error('Callback must be a function');
    this.loadingCallbacks.push(callback);
  }

  onProgress(callback) {
    if (typeof callback !== 'function') throw new Error('Callback must be a function');
    this.progressCallbacks.push(callback);
  }

  emitProgress(progress) {
    this.progressCallbacks.forEach(callback => {
      try {
        callback(progress);
      } catch (error) {
        console.error('Error in progress callback:', error);
      }
    });
  }

  updateFloorVisibility(floorPlanView = false) {
    Object.keys(this.floors).forEach(floorKey => {
      const floor = this.floors[floorKey];
      if (floor.model && floor.wireframe) {
        switch (this.currentFloorView) {
          case 'all':
            floor.model.visible = true;
            floor.wireframe.visible = floorPlanView;
            break;
          case floorKey:
            floor.model.visible = true;
            floor.wireframe.visible = floorPlanView;
            break;
          default:
            floor.model.visible = false;
            floor.wireframe.visible = false;
            break;
        }
      }
    });
  }

  setFloorView(view) {
    if (view === 'all' || this.floors[view]) {
      this.currentFloorView = view;
      return true;
    }
    return false;
  }

  getFloorCameraConfig() {
    const floorKeys = Object.keys(this.floors);
    const configs = {};

    if (this.currentFloorView === 'all') {
      const positions = floorKeys.map(key => this.floors[key].position.y);
      const minY = Math.min(...positions);
      const maxY = Math.max(...positions);
      const centerY = (minY + maxY) / 2;

      configs.camera = { x: 10, y: centerY + 5, z: 10 };
      configs.target = { x: 0, y: centerY, z: 0 };
      configs.orthoY = centerY + 15;
    } else if (this.floors[this.currentFloorView]) {
      const floorY = this.floors[this.currentFloorView].position.y;
      configs.camera = { x: 8, y: floorY + 5, z: 8 };  // floorY = floor level
      configs.target = { x: 0, y: floorY + 1, z: 0 };
      configs.orthoY = floorY + 8;
    }

    return configs;
  }

  getFloorKeys() {
    return Object.keys(this.floors);
  }
  getCurrentFloorView() {
    return this.currentFloorView;
  }
  getAllRotNodes() {
    return this.allRotNodes;
  }
  getFloors() {
    return this.floors;
  }

  clearFloors() {
    Object.values(this.floors).forEach(floor => {
      if (floor.model) this.scene.remove(floor.model);
      if (floor.wireframe) this.scene.remove(floor.wireframe);
    });
    this.floors = {};
    this.floorOrder = [];
    this.allRotNodes = [];
  }

  dispose() {
    this.clearFloors();
    this.loadingCallbacks = [];
  }
}

// 🔹 Example configs (now dynamic based on PANO_BASE_PATH)
const BASE_PATH = window.PANO_BASE_PATH || "panos/";

// One file holding every floor. Not a floor list, so it goes through
// initializeFromSingleModel() rather than initializeFloors().
export const COMBINED_MODEL_PATH = `${BASE_PATH}house.glb`;

export const FloorConfigurations = {
  SINGLE_FLOOR: [
    { name: 'floor 1', modelPath: `${BASE_PATH}floor1.glb` }
  ],
  TWO_FLOORS: [
    { name: 'floor 1', modelPath: `${BASE_PATH}floor1.glb` },
    { name: 'floor 2', modelPath: `${BASE_PATH}floor2.glb` }
  ],
  THREE_FLOORS: [
    { name: 'floor 1', modelPath: `${BASE_PATH}floor1.glb` },
    { name: 'floor 2', modelPath: `${BASE_PATH}floor2.glb` },
    { name: 'floor 3', modelPath: `${BASE_PATH}floor3.glb` }
  ]
};