import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HotspotManager, applyHotspotConfigFallback } from './hotspots.js';
import { loadHousebin, firstExisting } from './housebin.js';
import { measureFloors, roomDimensionText, WallLengthLabels } from './measurements.js';
import { PanoramaManager } from './panorama.js';
import { FloorManager, FloorConfigurations } from './FloorManager.js';
import { VideoHotspotManager } from './video-hotspot.js';

class RoomViewer {
  constructor() {
    // Check if in mini mode
    const urlParams = new URLSearchParams(window.location.search);
    this.isMiniMode = urlParams.get('mini') === '1';

    this.panoLists = {};
    this.detectedPanos = {};
    this.initScene();
    this.initLights();
    this.initBackground();
    this.initManagers();
    this.initFloorSystem();
    this.setupEventListeners();
    this.setupCameraViews();

    if (this.isMiniMode) {
      this.hideUIMiniMode();
    }

    this.animate();
  }

  async detectPanosForCurrentTask() {
    const urlParams = new URLSearchParams(window.location.search);
    const taskId = urlParams.get('taskId') || 'TaskID_101';

    if (!this.detectedPanos[taskId] && this.derivedPanoList && this.derivedPanoList.length) {
      // Housebin tour without a hotspot-config.js: the room list IS the pano list.
      this.detectedPanos[taskId] = this.derivedPanoList;
    }

    if (!this.detectedPanos[taskId]) {
      // Try to load from config first
      try {
        const basePath = `../${taskId}/panos/`;
        const module = await import(`${basePath}hotspot-config.js`);
        const availablePanoramas = module.availablePanoramas || [];
        this.detectedPanos[taskId] = availablePanoramas.map(p => p.replace('panos/', ''));
      } catch (err) {
        console.log('Config not available, detecting panos');
        this.detectedPanos[taskId] = await this.detectPanosInTaskFolder(taskId);
      }
    }

    this.panoLists[taskId] = this.detectedPanos[taskId];

    // Update PanoramaManager with detected panos
    if (this.panoramaManager) {
      this.panoramaManager.setPanoList(this.panoLists[taskId]);
    }
  }

  async detectPanosInTaskFolder(taskId) {
    const basePath = `../${taskId}/panos/`;
    const detectedPanos = [];

    // Common pano names to try
    const commonNames = [
      'Bathroom', 'Bathroom 1', 'Bathroom 2', 'Bedroom 1', 'Bedroom 2', 'Bedroom 3', 'Bedroom 4', 'Bedroom 5', 'Bedroom 6', 'Breakfast Nook',
      'Closet', 'Entrance', 'Family Room', 'Hallway', 'Kitchen', 'Laundry Room',
      'Living Room', 'Living Room 2', 'Master Bathroom', 'Master Bedroom',
      'Master Bedroom 2', 'Dining Room', 'Office', 'Garage', 'Patio', 'Garden'
    ];

    // Try to detect using directory listing first (if server supports it)
    try {
      const response = await fetch(basePath);
      if (response.ok) {
        const text = await response.text();
        // Try to parse HTML directory listing
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/html');
        const links = doc.querySelectorAll('a');

        links.forEach(link => {
          const href = link.getAttribute('href');
          if (href && href.endsWith('.jpg') && !href.includes('..')) {
            detectedPanos.push(href);
          }
        });
      }
    } catch (error) {
      console.log('Directory listing not available, trying individual file detection');
    }

    // If directory listing didn't work, try common names
    if (detectedPanos.length === 0) {
      const checkPromises = commonNames.map(async (name) => {
        const fileName = `${name}.jpg`;
        try {
          const response = await fetch(basePath + fileName, { method: 'HEAD' });
          if (response.ok) {
            return fileName;
          }
        } catch (error) {
          // File doesn't exist
        }
        return null;
      });

      const results = await Promise.all(checkPromises);
      detectedPanos.push(...results.filter(result => result !== null));
    }

    // Also try numbered variations
    if (detectedPanos.length === 0) {
      for (let i = 1; i <= 20; i++) {
        try {
          const fileName = `pano${i}.jpg`;
          const response = await fetch(basePath + fileName, { method: 'HEAD' });
          if (response.ok) {
            detectedPanos.push(fileName);
          }
        } catch (error) {
          // Continue checking
        }
      }
    }

    console.log(`Detected ${detectedPanos.length} panos for ${taskId}:`, detectedPanos);
    return detectedPanos;
  }

  initScene() {
    this.scene = new THREE.Scene();

    // Get container dimensions for iframe compatibility
    const container = document.body;
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(60, width/height, 0.1, 1000);

    // Create orthographic camera for floor plan view
    const aspect = width / height;
    const size = 8;
    this.orthoCamera = new THREE.OrthographicCamera(
      -size * aspect, size * aspect, size, -size, 0.1, 1000
    );

    if (this.isMiniMode) {
      this.camera.position.set(8, 4, 8);   // Closer camera position for mini viewer
    } else {
      this.camera.position.set(12, 5, 12);   //MAIN 3D VIEWR CAMERA POS
    }

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = false; // no shadow-casting lights remain (ambient only)

    // In mini mode, set clear color to white to remove black space
    if (this.isMiniMode) {
      this.renderer.setClearColor(0xffffff, 1);
    }

    // Clear any existing canvas first
    const existingCanvas = container.querySelector('canvas');
    if (existingCanvas) {
      container.removeChild(existingCanvas);
    }

    container.appendChild(this.renderer.domElement);

    // CSS3D layer for YouTube panels. Shares this.camera, so FOV zoom and
    // drag-look stay in sync with the WebGL scene automatically -- there is
    // no per-frame syncing to do and nothing can drift. Hidden by default;
    // only shown while a panorama is open, because CSS3D content cannot be
    // occluded by WebGL geometry (fine inside a photo sphere, wrong in the
    // dollhouse view).
    this.videoHotspots = new VideoHotspotManager(container, this.camera);
    this.videoHotspots.hide();

    // In mini mode, ensure canvas fills the container
    if (this.isMiniMode) {
      this.renderer.domElement.style.width = '100%';
      this.renderer.domElement.style.height = '100%';
      this.renderer.domElement.style.position = 'absolute';
      this.renderer.domElement.style.top = '0';
      this.renderer.domElement.style.left = '0';
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      document.body.style.overflow = 'hidden';
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    
    this.activeCamera = this.camera;
  }

  initLights() {
    const light1 = new THREE.AmbientLight(0xffffff, 2);
    this.scene.add(light1);
  }

  initBackground() {
    if (this.isMiniMode) {
      // In mini mode, use a solid background to avoid black space
      this.scene.background = new THREE.Color(0xffffff);
    } else {
      this.gradientTexture = this.createRadialGradientTexture(window.innerWidth, window.innerHeight);
      this.scene.background = this.gradientTexture;
    }
  }

  createRadialGradientTexture(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(width/2, height/2, 0, width/2, height/2, Math.max(width,height)/1.2);
    gradient.addColorStop(0,'#deeeff');
    gradient.addColorStop(1,'#0c1538');
    ctx.fillStyle = gradient;
    ctx.fillRect(0,0,width,height);
    return new THREE.CanvasTexture(canvas);
  }

  initManagers() {
    // Create PanoramaManager first (without hotspotManager reference)
    this.panoramaManager = new PanoramaManager(this.scene, this.camera, this.controls, null, this.renderer, this);
    // Create HotspotManager with PanoramaManager reference
    this.hotspotManager = new HotspotManager(this.scene, this.panoramaManager);
    // Set the hotspotManager reference in PanoramaManager
    this.panoramaManager.hotspotManager = this.hotspotManager;

    // Pano list will be set after detection in detectPanosForCurrentTask()
  }

  /**
   * Which model a task uses. First match wins:
   *   1. ?model=<path>            (relative to the task's panos/ folder)
   *   2. panos/tour.json           { "model": "house.glb" }  or
   *                                { "model": { "type": "housebin", "path": "housebin/h1.housebine",
   *                                             "units": "auto", "cameraHeightInches": 52 } }  or
   *                                { "model": { "type": "floors", "floors": [{ "name": "floor 1", "path": "floor1.glb" }] } }
   *   3. panos/house.glb           one GLB, every floor inside
   *   4. panos/housebin/h1.housebine (or ../housebin/)  a raw housebin capture
   *   5. the per-task floor list below -- a list with ONE file goes through the
   *      single-model path, since that file may well hold every floor.
   */
  async resolveModelSource(taskId, legacyConfig) {
    const base = window.PANO_BASE_PATH || 'panos/';
    // Absolute URLs pass through; anything else is relative to panos/.
    const rel = p => (/^(https?:)?\/\//.test(p) || p.startsWith('/')) ? p : base + p;

    const describe = (m) => {
      if (!m) return null;
      if (typeof m === 'string') m = { path: m };
      const path = m.path || m.url || '';
      const type = m.type ||
        (/\.glb$/i.test(path) ? 'glb' : /\.housebine?$/i.test(path) || /\/$/.test(path) ? 'housebin' : null);
      if (type === 'floors') {
        return { type, floors: (m.floors || []).map((f, i) => ({
          name: f.name || `floor ${i + 1}`, modelPath: rel(f.path || f.modelPath) })) };
      }
      return type ? { ...m, type, url: rel(path) } : null;
    };

    const params = new URLSearchParams(window.location.search);
    let source = describe(params.get('model'));

    if (!source) {
      try {
        const res = await fetch(`${base}tour.json`, { cache: 'no-cache' });
        if (res.ok) source = describe((await res.json()).model);
      } catch (e) { /* no manifest -- probe instead */ }
    }

    if (!source) {
      const glb = await firstExisting([`${base}house.glb`]);
      if (glb) source = { type: 'glb', url: glb };
    }

    if (!source) {
      const house = await firstExisting([
        `${base}housebin/h1.housebine`, `${base}housebin/h1.housebin`,
        `${base}../housebin/h1.housebine`, `${base}../housebin/h1.housebin`
      ]);
      if (house) source = { type: 'housebin', url: house };
    }

    if (!source) {
      source = legacyConfig.length === 1
        ? { type: 'glb', url: legacyConfig[0].modelPath }
        : { type: 'floors', floors: legacyConfig };
    }

    // A housebin path given as a folder -> its container.
    if (source.type === 'housebin' && /\/$/.test(source.url)) {
      source.url = await firstExisting([`${source.url}h1.housebine`, `${source.url}h1.housebin`]) ||
                   `${source.url}h1.housebine`;
    }
    return source;
  }

  async initFloorSystem() {
  // Initialize the floor manager
  this.floorManager = new FloorManager(this.scene);

  // Map tasks/projects to floor configurations (used only when the task has
  // no tour.json, house.glb or housebin -- see resolveModelSource()).
  const taskFloorMapping = {
    'TaskID_101': FloorConfigurations.TWO_FLOORS,
    'TaskID_102': FloorConfigurations.TWO_FLOORS,
    'TaskID_103': FloorConfigurations.THREE_FLOORS,
    // Add more tasks here as needed
  };

  // Determine current task from URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  const taskId = urlParams.get('taskId') || 'TaskID_101';
  const floorConfig = taskFloorMapping[taskId] || FloorConfigurations.SINGLE_FLOOR;

  try {
    // Show loading indicator
    this.showLoadingIndicator();

    // Preload essential textures before loading floors
    const textureLoader = new THREE.TextureLoader();
    const transparentTexture = await new Promise((resolve, reject) => {
      textureLoader.load('textures/transparent.png', resolve, undefined, reject);
    });

    // Set the preloaded texture in hotspot manager
    this.hotspotManager.setAlphaMap(transparentTexture);

    // Set up progress callback
    this.floorManager.onProgress((progress) => {
      this.updateLoadingProgress(progress);
    });

    // Set up callback BEFORE initializing floors
    this.floorManager.onLoaded(async (allRotNodes, floors) => {
      console.log('All floors loaded, creating hotspots...', allRotNodes.length, 'nodes found');

      // Map dollhouse hotspots to panoramas only once the config is in --
      // either hotspot-config.js, or (housebin tours without one) the config
      // derived from h1_HOTSPOT_V.json.
      try { await this.hotspotManager.configReady; } catch (e) { /* logged by hotspots.js */ }
      if (this.derivedHotspotConfig) {
        const used = applyHotspotConfigFallback(this.derivedHotspotConfig, this.panoramaManager);
        if (used) console.log('Pano hotspots taken from h1_HOTSPOT_V.json (no hotspot-config.js in this task)');
      }

      // Hide loading indicator
      this.hideLoadingIndicator();

      // Create the hotspots only if not in mini mode
      if (!this.isMiniMode) {
        this.hotspotManager.createRotHotspots(allRotNodes);
        this.buildMeasurements(floors);
      }

      this.updateFloorVisibility();
      this.generateFloorDropdownOptions();

      // Now that floors are loaded, detect panos in background (don't await)
      this.detectPanosForCurrentTask();

      // Automatically click the home button once after 3D model loading is complete
      setTimeout(() => {
        document.getElementById('homeBtn').click();
      }, 500);
    });

    const source = await this.resolveModelSource(taskId, floorConfig);
    this.modelSource = source;
    console.log('Initializing floors for task:', taskId, 'from', source);

    if (source.type === 'housebin') {
      this.loadingUnit = 'images';
      const result = await loadHousebin({
        houseUrl: source.url,
        units: source.units || 'auto',
        cameraHeightInches: source.cameraHeightInches || null,
        applyFloorOffsetXY: source.applyFloorOffsetXY !== false,
        onProgress: p => this.updateLoadingProgress(p)
      });
      result.warnings.forEach(w => console.warn('[housebin]', w));
      console.log(`Housebin: ${result.floors.length} floor(s), ${result.rooms.length} room(s), units=${result.units}`);
      console.table(result.rooms);
      this.derivedHotspotConfig = result.hotspotConfig;
      this.derivedPanoList = result.hotspotConfig
        ? result.hotspotConfig.availablePanoramas.map(p => p.replace('panos/', ''))
        : result.rooms.map(r => `${r.id}.jpg`);
      this.loadingUnit = 'floors';
      this.floorManager.initializeFromPrebuilt(result.floors, source.url);
    } else if (source.type === 'glb') {
      await this.floorManager.initializeFromSingleModel(source.url);
    } else {
      await this.floorManager.initializeFloors(source.floors);
    }

  } catch (error) {
    console.error('Failed to initialize floors:', error);
    this.hideLoadingIndicator();
  }
}


/**
 * Menu text for a floor. Floors from a single GLB or a housebin keep the
 * name they were saved with in the Qt app, unchanged ("f1" stays "f1").
 * The older one-GLB-per-floor setup keys floors "floor 1", "floor 2", which
 * still get their first letter capitalised as before.
 */
floorDisplayName(floorKey) {
  const floor = this.floorManager && this.floorManager.floors[floorKey];
  if (floor && floor.label) return floor.label;
  return floorKey.charAt(0).toUpperCase() + floorKey.slice(1);
}

// Generate floor dropdown options dynamically based on loaded floors
  generateFloorDropdownOptions() {
    const floorDropdownMenu = document.getElementById('floorDropdownMenu');
    if (!floorDropdownMenu) return;

    // Clear existing options
    floorDropdownMenu.innerHTML = '';

    const floorKeys = this.floorManager.getFloorKeys();
    
    // Add "All Floors" option if more than one floor
    if (floorKeys.length > 1) {
      const allFloorsItem = document.createElement('div');
      allFloorsItem.className = 'floor-dropdown-item';
      allFloorsItem.dataset.floor = 'all';
      allFloorsItem.innerHTML = '<span class="floor-icon"></span><span>All Floors</span>';
      floorDropdownMenu.appendChild(allFloorsItem);
    }

    // Add individual floor options
    floorKeys.forEach((floorKey, index) => {
      const floorItem = document.createElement('div');
      floorItem.className = 'floor-dropdown-item';
      floorItem.dataset.floor = floorKey;
      
      const displayName = this.floorDisplayName(floorKey);
      
      // textContent, not innerHTML: floor names come from saved files.
      floorItem.innerHTML = '<span class="floor-icon"></span><span></span>';
      floorItem.lastElementChild.textContent = displayName;
      floorDropdownMenu.appendChild(floorItem);
    });

    // Re-attach event listeners for new dropdown items
    this.attachDropdownListeners();
    
    // Update current floor view display
    this.updateFloorDropdown();
  }

  attachDropdownListeners() {
    document.querySelectorAll('.floor-dropdown-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const floor = item.dataset.floor;
        this.setFloorView(floor);
        this.closeFloorDropdown();
      });
    });
  }

  updateFloorVisibility() {
    if (this.floorManager) {
      this.floorManager.updateFloorVisibility(this.floorPlanView);
      this.updateHotspotVisibility();
    }
  }

  updateHotspotVisibility() {
    // In mini mode, keep labels hidden
    if (this.isMiniMode) {
      this.hotspotManager.hideLabels();
      return;
    }

    // Always hide all labels first
    this.hotspotManager.hideLabels();

    // Use a slightly longer delay to ensure proper hiding
    setTimeout(() => {
      const currentView = this.floorManager.getCurrentFloorView();
      console.log(`Updating hotspot visibility for floor view: ${currentView}`);

      if (currentView === 'all') {
        this.hotspotManager.showLabels();
        console.log('Showing all labels');
      } else {
        this.hotspotManager.showLabelsForFloor(currentView);
        console.log(`Showing labels for floor: ${currentView}`);
      }

      // Force an immediate update of label positions after showing them
      if (!this.panoramaManager.isActive()) {
        this.hotspotManager.updateRotTextFacing(this.activeCamera, this.floorPlanView);
      }
    }, 150); // Increased timeout
  }

  setFloorView(view) {
    if (this.panoramaManager.isActive()) return;
    
    if (this.floorManager.setFloorView(view)) {
      // Reset all floor model rotations to zero FIRST
      Object.values(this.floorManager.getFloors()).forEach(floor => {
        if (floor.model) {
          floor.model.rotation.set(0, 0, 0);
        }
      });
      
      this.updateFloorVisibility();
      this.updateFloorDropdown();

      if (!this.dollhouseView && !this.floorPlanView) {
        this.autoRotate = false;
        this.adjustCameraForFloorView();
      } else if (this.floorPlanView) {
        const cameraConfig = this.floorManager.getFloorCameraConfig();
        this.orthoCamera.position.set(0, cameraConfig.orthoY, 0.001);
        this.controls.target.set(cameraConfig.target.x, cameraConfig.target.y, cameraConfig.target.z);
        this.controls.update();
      }
    }
  }

  updateFloorDropdown() {
    const currentFloorText = document.getElementById('currentFloorText');
    const dropdownItems = document.querySelectorAll('.floor-dropdown-item');
    
    if (!currentFloorText) return;

    const currentView = this.floorManager.getCurrentFloorView();
    let displayText = 'All Floors';
    let displayIcon = '';
    
    if (currentView !== 'all') {
      displayText = this.floorDisplayName(currentView);
      displayIcon = '';
    }
    
    currentFloorText.innerHTML = `<span class="floor-icon">${displayIcon}</span><span>${displayText}</span>`;
    
    // Update active state of dropdown items
    dropdownItems.forEach(item => {
      item.classList.remove('active');
      if (item.dataset.floor === currentView) {
        item.classList.add('active');
      }
    });
  }

  adjustCameraForFloorView() {
    // Reset floor model rotations
    Object.values(this.floorManager.getFloors()).forEach(floor => {
      if (floor.model) {
        floor.model.rotation.set(0, 0, 0);
      }
    });
    
    this.autoRotate = false;
    this.controls.reset();
    
    if (this.activeCamera !== this.camera) {
      this.activeCamera = this.camera;
      this.controls.object = this.camera;
    }
    
    // Reset control constraints
    this.controls.enableRotate = true;
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.minAzimuthAngle = -Infinity;
    this.controls.maxAzimuthAngle = Infinity;
    
    // Get camera configuration from floor manager
    const cameraConfig = this.floorManager.getFloorCameraConfig();
    if (cameraConfig.camera && cameraConfig.target) {
      this.camera.position.set(cameraConfig.camera.x, cameraConfig.camera.y, cameraConfig.camera.z);
      this.controls.target.set(cameraConfig.target.x, cameraConfig.target.y, cameraConfig.target.z);
    }
    
    this.controls.update();
    
    setTimeout(() => {
      if (!this.dollhouseView && !this.floorPlanView) {
        this.autoRotate = true;
      }
    }, 200);
  }

  setupEventListeners() {
   this.renderer.domElement.addEventListener('click', (event) => {
  const rect = this.renderer.domElement.getBoundingClientRect();
  this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  this.raycaster.setFromCamera(this.mouse, this.activeCamera);

  if (this.panoramaManager.isActive()) {
    // Flatten hotspot groups into child meshes for raycasting
    const hotspotMeshes = this.hotspotManager.getPanoramaHotspots().flatMap(g => g.children);
    const intersects = this.raycaster.intersectObjects(hotspotMeshes, true);

    console.log("Panorama click → intersected objects:", intersects.map(i => i.object.name));

    if (intersects.length > 0) {
      // Find the parent group with userData.info
      let hotspotGroup = intersects[0].object;
      while (hotspotGroup && !hotspotGroup.userData.info) {
        hotspotGroup = hotspotGroup.parent;
      }

      if (hotspotGroup && hotspotGroup.userData.info) {
        const info = hotspotGroup.userData.info;
        console.log("Hotspot clicked:", info);
        this.panoramaManager.openPanorama(info.panoramaImage);
      }
    }
  } else {
    // Click detection for cylinder hotspots on floors (disabled in mini mode)
    if (!this.isMiniMode) {
      const intersects = this.raycaster.intersectObjects(this.hotspotManager.getRotHotspots(), true);
      if (intersects.length > 0) {
        let obj = intersects[0].object;
        while (obj && !obj.userData.panoramaImage) obj = obj.parent;
        if (obj && obj.userData.panoramaImage) {
          this.animateCylinderClick(obj);
          this.zoomToCylinder(obj, () => {
            this.panoramaManager.openPanorama(obj.userData.panoramaImage);
          });
        }
      }
    }
  }
});


    // Bottom control buttons
    document.getElementById('homeBtn').addEventListener('click', () => this.goHome());
    document.getElementById('dollhouseBtn').addEventListener('click', () => this.toggleDollhouseView());
    document.getElementById('floorPlanBtn').addEventListener('click', () => this.toggleFloorPlanView());

    // Floor dropdown functionality
    const floorDropdownToggle = document.getElementById('floorDropdownToggle');
    const floorDropdownMenu = document.getElementById('floorDropdownMenu');
    
    if (floorDropdownToggle && floorDropdownMenu) {
      floorDropdownToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = floorDropdownMenu.classList.contains('open');
        
        if (isOpen) {
          this.closeFloorDropdown();
        } else {
          this.openFloorDropdown();
        }
      });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.floor-selector')) {
        this.closeFloorDropdown();
      }
    });

    // Other event listeners...
    document.getElementById('fullscreenBtn')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('infoBtn')?.addEventListener('click', () => this.showInfoPanel());
    document.getElementById('closeInfoBtn')?.addEventListener('click', () => this.hideInfoPanel());

    // Keyboard shortcuts - dynamically handle floor numbers
    window.addEventListener('keydown', (event) => {
      switch(event.key.toLowerCase()) {
        case 'h':
          this.goHome();
          break;
        case 'd':
          this.toggleDollhouseView();
          break;
        case 'f':
          this.toggleFloorPlanView();
          break;
        case 'a':
          this.setFloorView('all');
          break;
        case 'escape':
          if (this.panoramaManager.isActive()) {
            this.panoramaManager.exitPanorama();
          } else {
            this.goHome();
          }
          break;
        default:
          // Handle numeric keys for floor selection
          const floorKeys = this.floorManager?.getFloorKeys() || [];
          const keyNumber = parseInt(event.key);
          if (keyNumber >= 1 && keyNumber <= floorKeys.length) {
            const floorKey = floorKeys[keyNumber - 1];
            this.setFloorView(floorKey);
          }
          break;
      }
    });

    // Window events
    window.addEventListener('resize', () => {
      // Get container dimensions for iframe compatibility
      const container = document.body;
      const width = container.clientWidth || window.innerWidth;
      const height = container.clientHeight || window.innerHeight;
      const aspect = width / height;

      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();

      const size = 8;
      this.orthoCamera.left = -size * aspect;
      this.orthoCamera.right = size * aspect;
      this.orthoCamera.top = size;
      this.orthoCamera.bottom = -size;
      this.orthoCamera.updateProjectionMatrix();

      this.renderer.setSize(width, height);
      this.gradientTexture = this.createRadialGradientTexture(width, height);
      this.scene.background = this.gradientTexture;
    });

    window.addEventListener('hideRoomModel', () => {
      Object.values(this.floorManager?.getFloors() || {}).forEach(floor => {
        if(floor.model) floor.model.visible = false;
        if(floor.wireframe) floor.wireframe.visible = false;
      });
    });

    window.addEventListener('showRoomModel', () => {
      this.updateFloorVisibility();
    });

  }

  openFloorDropdown() {
    const floorDropdownMenu = document.getElementById('floorDropdownMenu');
    const floorDropdownToggle = document.getElementById('floorDropdownToggle');
    const floorDropdownArrow = floorDropdownToggle?.querySelector('.floor-dropdown-arrow');
    
    floorDropdownMenu?.classList.add('open');
    floorDropdownToggle?.classList.add('active');
    floorDropdownArrow?.classList.add('expanded');
  }

  closeFloorDropdown() {
    const floorDropdownMenu = document.getElementById('floorDropdownMenu');
    const floorDropdownToggle = document.getElementById('floorDropdownToggle');
    const floorDropdownArrow = floorDropdownToggle?.querySelector('.floor-dropdown-arrow');
    
    floorDropdownMenu?.classList.remove('open');
    floorDropdownToggle?.classList.remove('active');
    floorDropdownArrow?.classList.remove('expanded');
  }

  setupCameraViews() {
    this.autoRotate = true;
    this.dollhouseView = false;
    this.floorPlanView = false;
    this.homePosition = { pos: new THREE.Vector3(6, 5, 6), target: new THREE.Vector3(0, 2, 0) };
  }

  goHome() {
    if (this.panoramaManager.isActive()) {
      this.panoramaManager.exitPanorama();
    }
    
    // FIXED: Return to the previously selected floor view instead of 'all'
    if (this.previousFloorView) {
      this.floorManager.setFloorView(this.previousFloorView);
    }
    
    this.activeCamera = this.camera;
    this.controls.object = this.camera;
    
    this.camera.position.copy(this.homePosition.pos);
    this.controls.target.copy(this.homePosition.target);
    this.controls.update();
    this.dollhouseView = false;
    this.floorPlanView = false;
    
    // FIXED: Update floor visibility and dropdown after restoring previous floor view
    this.updateFloorVisibility();
    this.updateFloorDropdown();
    
    this.updateViewMode();
    
    // Force label visibility update after a short delay
    setTimeout(() => {
      this.updateHotspotVisibility();
    }, 200);
  }

  toggleDollhouseView() {
    if (this.panoramaManager.isActive()) {
      this.panoramaManager.exitPanorama();
    }

    // Always switch to dollhouse view when button is pressed
    this.dollhouseView = true;
    this.floorPlanView = false;

    this.activeCamera = this.camera;
    this.controls.object = this.camera;

    this.updateViewMode();
  }

  toggleFloorPlanView() {
    if (this.panoramaManager.isActive()) {
      this.panoramaManager.exitPanorama();
    }

    // Always switch to floor plan view when button is pressed
    this.floorPlanView = true;
    this.dollhouseView = false;

    if (this.floorPlanView) {
      this.activeCamera = this.orthoCamera;
      this.controls.object = this.orthoCamera;
    } else {
      this.activeCamera = this.camera;
      this.controls.object = this.camera;
    }

    this.updateViewMode();
  }

  updateViewMode() {
    if (this.dollhouseView) {
      // Dollhouse view: higher camera position for overview
      const cameraConfig = this.floorManager.getFloorCameraConfig();
      this.camera.position.set(12, 15, 12);
      this.controls.target.set(cameraConfig.target.x, cameraConfig.target.y, cameraConfig.target.z);
      this.autoRotate = false;

      // Enable all controls for dollhouse view
      this.controls.enableRotate = true;
      this.controls.enablePan = true;
      this.controls.enableZoom = true;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = Math.PI;
      this.controls.minAzimuthAngle = -Infinity;
      this.controls.maxAzimuthAngle = Infinity;

      this.updateFloorVisibility();

      // Reset model rotation for dollhouse view
      Object.values(this.floorManager.getFloors()).forEach(floor => {
        if (floor.model) {
          floor.model.rotation.set(0, 0, 0);
        }
      });

    } else if (this.floorPlanView) {
      // Top view: position camera above looking straight down
      const cameraConfig = this.floorManager.getFloorCameraConfig();

      this.orthoCamera.position.set(0, cameraConfig.orthoY, 0.001);
      this.controls.target.set(cameraConfig.target.x, cameraConfig.target.y, cameraConfig.target.z);
      this.autoRotate = false;

      // Lock tilting in top view - only allow Y-axis rotation (spinning)
      this.controls.enableRotate = true;
      this.controls.enablePan = true;
      this.controls.enableZoom = true;

      this.controls.minPolarAngle = 0.0;
      this.controls.maxPolarAngle = 0.0;

      this.controls.minAzimuthAngle = -Infinity;
      this.controls.maxAzimuthAngle = Infinity;

      this.updateFloorVisibility();

      // Reset model rotation for floor plan view
      Object.values(this.floorManager.getFloors()).forEach(floor => {
        if (floor.model) {
          floor.model.rotation.set(0, 0, 0);
        }
      });

    } else {
      // Normal view
      this.autoRotate = true;

      this.controls.enableRotate = true;
      this.controls.enablePan = true;
      this.controls.enableZoom = true;
      this.controls.minPolarAngle = 0;
      this.controls.maxPolarAngle = Math.PI;
      this.controls.minAzimuthAngle = -Infinity;
      this.controls.maxAzimuthAngle = Infinity;

      this.controls.reset();
      this.adjustCameraForFloorView();
      this.updateFloorVisibility();

      // Reset model rotation when returning to normal view
      Object.values(this.floorManager.getFloors()).forEach(floor => {
        if (floor.model) {
          floor.model.rotation.set(0, 0, 0);
        }
      });
    }

    // Update carousel visibility based on floor plan view
    if (this.panoramaManager) {
      this.panoramaManager.updateCarouselVisibility(this.floorPlanView);
    }

    this.controls.update();

    // Ensure labels are updated after view mode change
    setTimeout(() => {
      this.updateHotspotVisibility();
    }, 100);
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }

 showInfoPanel() {
    const infoPanel = document.getElementById('infoPanel');
    if (infoPanel) {
      infoPanel.style.display = 'block';
      // Hide hotspot labels when info panel is open
      this.hotspotManager.hideLabels();
    }
  }

  hideInfoPanel() {
    const infoPanel = document.getElementById('infoPanel');
    if (infoPanel) {
      infoPanel.style.display = 'none';
      // Restore hotspot label visibility when info panel is closed
      if (!this.panoramaManager.isActive()) {
        this.updateHotspotVisibility();
      }
    }
  }

  animateCylinderClick(cylinder) {
    // Store original scale
    const originalScale = cylinder.scale.clone();

    // Animate scale up
    cylinder.scale.setScalar(1.3);

    // Animate back to original scale after a short delay
    setTimeout(() => {
      cylinder.scale.copy(originalScale);
    }, 60);
  }

  zoomToCylinder(cylinder, callback) {
    // Get cylinder world position
    const targetPosition = new THREE.Vector3();
    cylinder.getWorldPosition(targetPosition);

    // Calculate zoom position (closer to cylinder)
    const direction = new THREE.Vector3();
    direction.subVectors(this.camera.position, targetPosition).normalize();

    const zoomDistance = 1; // Distance to zoom to
    const zoomPosition = new THREE.Vector3();
    zoomPosition.copy(targetPosition).add(direction.multiplyScalar(zoomDistance));

    // Store current camera state
    const startPosition = this.camera.position.clone();
    const startTarget = this.controls.target.clone();

    // Animate camera zoom
    const duration = 1300; // 800ms animation
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Smooth easing function
      const easeProgress = 1 - Math.pow(1 - progress, 3);

      // Interpolate camera position
      this.camera.position.lerpVectors(startPosition, zoomPosition, easeProgress);

      // Update controls target to look at cylinder
      this.controls.target.lerpVectors(startTarget, targetPosition, easeProgress);
      this.controls.update();

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        // Animation complete, call callback
        setTimeout(callback, 100); // Small delay before opening panorama
      }
    };

    animate();
  }

  /**
   * Room sizes under the room names, and wall lengths for the floor plan
   * view. Measured once from the loaded model -- see measurements.js.
   */
  buildMeasurements(floors) {
    try {
      const measured = measureFloors(floors || this.floorManager.getFloors());
      const text = {};
      Object.values(measured).flat().forEach(r => { text[r.roomId] = roomDimensionText(r); });
      this.hotspotManager.setRoomDimensions(text);

      if (!this.wallLabels) this.wallLabels = new WallLengthLabels();
      this.wallLabels.build(measured, this.floorManager.getFloors());
      console.log('Room measurements:', Object.values(measured).flat()
        .map(r => `${r.roomId} ${text[r.roomId]}`).join(' | '));
    } catch (e) {
      console.warn('Room measurements unavailable:', e);
    }
  }

  animate() {
    requestAnimationFrame(() => this.animate());

    // Only auto-rotate when in normal view mode and not in panorama
    if (this.autoRotate && !this.panoramaManager.isActive() && !this.dollhouseView && !this.floorPlanView) {
      Object.values(this.floorManager.getFloors()).forEach(floor => {
        if (floor.model && floor.model.visible) {
          floor.model.rotation.y += 0.002;
        }
      });
    }

    if (this.panoramaManager.isActive())
      this.hotspotManager.animateHotspots(this.activeCamera);

    // Update labels when not in panorama mode and ensure they're properly managed
    if (!this.panoramaManager.isActive()) {
      // Only update if we have labels and they should be visible
      const hasVisibleLabels = this.hotspotManager.labels.some(label => 
        label.element && label.element.style.display !== 'none'
      );
      
      if (hasVisibleLabels) {
        this.hotspotManager.updateRotTextFacing(this.activeCamera, this.floorPlanView);
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.activeCamera);

    // Wall lengths: floor plan view only, for the floor(s) on show.
    if (this.wallLabels) {
      const view = this.floorManager.getCurrentFloorView();
      this.wallLabels.update(
        this.activeCamera,
        this.floorPlanView && !this.isMiniMode && !this.panoramaManager.isActive(),
        key => view === 'all' || view === key
      );
    }

    // Drawn after the WebGL pass so the panels sit over the panorama.
    if (this.videoHotspots && this.panoramaManager.isActive()) {
      this.videoHotspots.camera = this.activeCamera;
      this.videoHotspots.render();
    }
  }

  hideUIMiniMode() {
    // Hide all UI elements in mini mode
    const elementsToHide = [
      'header-container',
      'controls-container',
      'logo-container',
      'infoBtn',
      'fullscreenBtn',
      'panoHint',
      'loadingIndicator',
      'hotspotTooltip',
      'infoPanel'
    ];

    elementsToHide.forEach(id => {
      const element = document.getElementById(id) || document.querySelector(`.${id}`);
      if (element) {
        element.style.display = 'none';
      }
    });

    // Also hide any carousel elements
    const carousel = document.getElementById('panoCarousel');
    if (carousel) {
      carousel.style.display = 'none';
    }

    // Hide expand button
    const expandBtn = document.querySelector('.carousel-expand-btn');
    if (expandBtn) {
      expandBtn.style.display = 'none';
    }
  }

  // Dispose method for cleanup
  dispose() {
    if (this.floorManager) {
      this.floorManager.dispose();
    }

    // Clean up other resources
    this.renderer.dispose();
    if (this.gradientTexture) {
      this.gradientTexture.dispose();
    }
  }

  showLoadingIndicator() {
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) {
      indicator.style.display = 'block';
      // Set loading text for floor loading
      const loadingText = document.getElementById('loadingText');
      if (loadingText) {
        loadingText.textContent = 'Loading floors...';
      }
      // Ensure progress bar elements are visible for floor loading
      const progressBar = indicator.querySelector('.progress-bar');
      const progressText = document.getElementById('progressText');
      if (progressBar) progressBar.style.display = 'block';
      if (progressText) progressText.style.display = 'block';
    }
  }

  hideLoadingIndicator() {
    const indicator = document.getElementById('loadingIndicator');
    if (indicator) {
      indicator.style.display = 'none';
    }
  }

  updateLoadingProgress(progress) {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');

    if (progressFill) {
      progressFill.style.width = `${progress.percentage}%`;
    }

    if (progressText) {
      progressText.textContent = `${progress.percentage}% (${progress.loaded}/${progress.total} ${this.loadingUnit || 'floors'})`;
    }
  }
}

// Initialize
new RoomViewer();