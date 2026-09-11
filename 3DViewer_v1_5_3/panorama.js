import * as THREE from 'three';

export class PanoramaManager {
  constructor(scene, camera, controls, hotspotManager, renderer, roomViewer) {
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.hotspotManager = hotspotManager;
    this.renderer = renderer;
    this.roomViewer = roomViewer;
    this.panoramaMesh = null;
    this.panoramaActive = false;
    this.savedView = this.saveCurrentView();

    // Defer DOM element access to ensure they exist
    this.initializeElements();

    this.autoRotateTimeout = null;
    this.wheelHandler = null; // keep reference for cleanup
    this.startListener = null;
    this.endListener = null;
    this.userStoppedAutoRotate = false; // true when user has manually paused auto-rotate

    // Store original renderer settings
    this.originalToneMappingExposure = this.renderer.toneMappingExposure;

    // Get hotspot data from HotspotManager instead of loading separately
    this.hotspotData = [];

    // Check if in mini mode
    const urlParams = new URLSearchParams(window.location.search);
    this.isMiniMode = urlParams.get('mini') === '1';

    // Carousel state
    this.carouselExpanded = false;
    this.panoList = [];
    this.currentPanoIndex = 0;

    // Side panel state
    this.sidePanelVisible = false;
    this.currentTab = '3d';

    if (!this.isMiniMode) {
      this.createCarousel();
    }
    this.createSidePanel();
    this.setupEventListeners();
  }

  initializeElements() {
    // Safely get DOM elements, checking if they exist
    this.panoHint = document.getElementById('panoHint');
    this.hotspotTooltip = document.getElementById('hotspotTooltip');
    this.loadingIndicator = document.getElementById('loadingIndicator');
    this.headerTitle = document.getElementById('headerTitle');

    if (this.headerTitle) {
      this.originalTitle = this.headerTitle.textContent;
    } else {
      this.originalTitle = '3D Viewer';
    }

    // Create menu button
    this.menuBtn = document.createElement('button');
    this.menuBtn.className = 'info-btn';
    this.menuBtn.style.left = '15px'; // Start at left aligned
    this.menuBtn.style.top = '25vh'; // Position at top edge of side menu
    this.menuBtn.style.zIndex = '400'; // Above side panel
    this.menuBtn.innerHTML = '<img src="textures/left_menu.svg" alt="Menu" class="info-icon">';
    this.menuBtn.style.display = 'none'; // Hidden initially
    document.body.appendChild(this.menuBtn);

    // Create auto-rotate toggle button - sits just below the fullscreen button
    this.autoRotateBtn = document.createElement('button');
    this.autoRotateBtn.className = 'autorotate-btn';
    this.autoRotateBtn.id = 'autoRotateBtn';
    this.autoRotateBtn.title = 'Stop auto-rotate';
    this.autoRotateBtn.innerHTML = '<img src="textures/stop_rotate.svg" alt="Stop rotation" class="fullscreen-icon" id="autoRotateIcon">';
    this.autoRotateBtn.style.display = 'none'; // Hidden until panorama is active
    this.autoRotateBtn.addEventListener('click', () => this.toggleAutoRotate());
    document.body.appendChild(this.autoRotateBtn);

    // Create video mute/unmute toggle button - sits just above the
    // fullscreen button. Only ever shown while the current panorama
    // actually has a YouTube panel in it (see the three display-toggle
    // sites below) -- otherwise it'd be a dead button in every other room.
    this.videoMuteBtn = document.createElement('button');
    this.videoMuteBtn.className = 'video-mute-btn';
    this.videoMuteBtn.id = 'videoMuteBtn';
    this.videoMuteBtn.title = 'Unmute video';
    this.videoMuteBtn.innerHTML = '<img src="textures/mute.svg" alt="Unmute video" class="fullscreen-icon" id="videoMuteIcon">';
    this.videoMuteBtn.style.display = 'none'; // Hidden until a panorama with video is active
    this.videoMuteBtn.addEventListener('click', () => this.toggleVideoMute());
    document.body.appendChild(this.videoMuteBtn);

    // Keep the button's icon in sync no matter which mute control the
    // visitor actually used -- this external button, or the small mute
    // icon on the video panel's own hover controls (video-hotspot.js).
    if (this.roomViewer && this.roomViewer.videoHotspots) {
      this.roomViewer.videoHotspots.onMuteChange((muted) => this._updateVideoMuteIcon(muted));
    }
  }

  toggleVideoMute() {
    if (!this.roomViewer || !this.roomViewer.videoHotspots) return;
    const muted = this.roomViewer.videoHotspots.toggleMuted();
    this._updateVideoMuteIcon(muted);
  }

  _updateVideoMuteIcon(muted) {
    const icon = document.getElementById('videoMuteIcon');
    if (icon) {
      icon.src = muted ? 'textures/mute.svg' : 'textures/unmute.svg';
      icon.alt = muted ? 'Unmute video' : 'Mute video';
    }
    if (this.videoMuteBtn) {
      this.videoMuteBtn.title = muted ? 'Unmute video' : 'Mute video';
      // Pressed/active visual when muted -- same convention as
      // .autorotate-btn.active, so the button visibly reflects state.
      this.videoMuteBtn.classList.toggle('active', muted);
    }
  }

  toggleAutoRotate() {
    this.userStoppedAutoRotate = !this.userStoppedAutoRotate;
    clearTimeout(this.autoRotateTimeout);
    this.controls.autoRotate = !this.userStoppedAutoRotate;

    const icon = document.getElementById('autoRotateIcon');
    if (icon) {
      // Stopped -> show "rotate" icon (tap to resume). Rotating -> show "stop_rotate" icon (tap to stop).
      icon.src = this.userStoppedAutoRotate ? 'textures/rotate.svg' : 'textures/stop_rotate.svg';
      icon.alt = this.userStoppedAutoRotate ? 'Resume rotation' : 'Stop rotation';
    }
    if (this.autoRotateBtn) {
      this.autoRotateBtn.title = this.userStoppedAutoRotate ? 'Resume auto-rotate' : 'Stop auto-rotate';
      // Pressed/active visual state, handled by the .autorotate-btn.active rule in styles.css
      this.autoRotateBtn.classList.toggle('active', this.userStoppedAutoRotate);
    }
  }

  createCarousel() {
    // Create expand/collapse button - OUTSIDE of carousel
    this.expandBtn = document.createElement('button');
    this.expandBtn.className = 'carousel-expand-btn';
    this.expandBtn.innerHTML = '⬡';
    this.expandBtn.style.position = 'absolute';
    this.expandBtn.style.bottom = '15px';
    this.expandBtn.style.left = '50%';
    this.expandBtn.style.transform = 'translateX(-50%)';
    this.expandBtn.style.zIndex = '201'; // Higher than carousel
    this.expandBtn.style.display = 'none'; // Hidden initially
    this.expandBtn.addEventListener('click', () => this.toggleCarousel());

    // Create carousel container - WITHOUT expand button
    this.carouselElement = document.createElement('div');
    this.carouselElement.className = 'pano-carousel';
    this.carouselElement.id = 'panoCarousel';
    this.carouselElement.style.display = 'none';
    
    // Create carousel content
    const carouselContent = document.createElement('div');
    carouselContent.className = 'carousel-content';
    carouselContent.style.display = 'none'; // Start collapsed

    const leftArrow = document.createElement('button');
    leftArrow.className = 'carousel-arrow left';
    leftArrow.innerHTML = '<';
    leftArrow.addEventListener('click', () => this.navigateCarousel(-1));

    const container = document.createElement('div');
    container.className = 'carousel-container';

    const track = document.createElement('div');
    track.className = 'carousel-track';
    track.id = 'carouselTrack';

    container.appendChild(track);

    const rightArrow = document.createElement('button');
    rightArrow.className = 'carousel-arrow right';
    rightArrow.innerHTML = '>';
    rightArrow.addEventListener('click', () => this.navigateCarousel(1));

    carouselContent.appendChild(leftArrow);
    carouselContent.appendChild(container);
    carouselContent.appendChild(rightArrow);

    // Only add content to carousel, not the expand button
    this.carouselElement.appendChild(carouselContent);

    // Add both elements to body separately
    document.body.appendChild(this.carouselElement);
    document.body.appendChild(this.expandBtn);
  }

  createSidePanel() {
    this.sidePanel = document.createElement('div');
    this.sidePanel.className = 'side-panel';
    this.sidePanel.style.height = '220px';
    this.sidePanel.style.top = '25vh';
    this.sidePanel.style.transform = 'none';
    this.sidePanel.style.width = '300px';

    // Tabs
    const tabContainer = document.createElement('div');
    tabContainer.className = 'side-panel-tabs';

    const tab3d = document.createElement('button');
    tab3d.className = 'side-tab-btn active';
    tab3d.textContent = '3D View';
    tab3d.addEventListener('click', () => this.switchTab('3d'));

    const tabFloor = document.createElement('button');
    tabFloor.className = 'side-tab-btn';
    tabFloor.textContent = 'Floor Plan';
    tabFloor.addEventListener('click', () => this.switchTab('floorplan'));

    tabContainer.appendChild(tab3d);
    tabContainer.appendChild(tabFloor);

    // Content
    const content3d = document.createElement('div');
    content3d.className = 'side-tab-content active mini-3d-content';
    content3d.id = 'tab-3d';
    content3d.style.position = 'relative';
    content3d.style.padding = '0';
    content3d.style.margin = '0';
    content3d.style.overflow = 'hidden';
    content3d.style.boxSizing = 'border-box';

    // Add iframe showing the 3D viewer in mini mode
    const iframe3d = document.createElement('iframe');
    const url = new URL(window.location.href);
    url.searchParams.set('mini', '1');
    iframe3d.src = url.toString();
    iframe3d.style.width = '100%';
    iframe3d.style.height = '100%';
    iframe3d.style.border = 'none';
    iframe3d.style.margin = '0';
    iframe3d.style.padding = '0';
    iframe3d.style.pointerEvents = 'none'; // Let overlay handle clicks
    content3d.appendChild(iframe3d);

    // Add overlay for click handling
    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.cursor = 'pointer';
    overlay.style.zIndex = '1';
    overlay.addEventListener('click', () => {
      this.exitPanorama();
      // Reset camera to home position after exiting
      setTimeout(() => {
        if (this.roomViewer) {
          this.roomViewer.goHome();
        }
      }, 100);
    });
    content3d.appendChild(overlay);

    const contentFloor = document.createElement('div');
    contentFloor.className = 'side-tab-content';
    contentFloor.id = 'tab-floorplan';

    const floorImg = document.createElement('img');
    floorImg.src = window.PANO_BASE_PATH + 'FloorPlan.JPG';
    floorImg.style.width = '100%';
    floorImg.style.height = 'auto';
    floorImg.alt = 'Floor Plan';
    contentFloor.appendChild(floorImg);

    this.sidePanel.appendChild(tabContainer);
    this.sidePanel.appendChild(content3d);
    this.sidePanel.appendChild(contentFloor);

    document.body.appendChild(this.sidePanel);
  }

  switchTab(tab) {
    this.currentTab = tab;
    const tabs = this.sidePanel.querySelectorAll('.side-tab-btn');
    const contents = this.sidePanel.querySelectorAll('.side-tab-content');

    tabs.forEach(t => t.classList.remove('active'));
    contents.forEach(c => c.classList.remove('active'));

    if (tab === '3d') {
      tabs[0].classList.add('active');
      contents[0].classList.add('active');
    } else {
      tabs[1].classList.add('active');
      contents[1].classList.add('active');
    }
  }

  toggleSidePanel() {
    this.sidePanelVisible = !this.sidePanelVisible;
    this.sidePanel.style.display = this.sidePanelVisible ? 'block' : 'none';

    // Update menu button position and icon
    if (this.menuBtn) {
      this.menuBtn.style.left = this.sidePanelVisible ? '300px' : '15px';
      const icon = this.menuBtn.querySelector('img');
      if (icon) {
        icon.src = this.sidePanelVisible ? 'textures/left_menu_collapse.svg' : 'textures/left_menu.svg';
      }
    }
  }
toggleCarousel() {
this.carouselExpanded = !this.carouselExpanded;
if (!this.carouselElement) return;
const content = this.carouselElement.querySelector('.carousel-content');

  if (this.carouselExpanded) {
    content.style.display = 'flex';
    this.expandBtn.innerHTML = '⬢';
    
    // Position the expand button at the top of the expanded carousel
    this.expandBtn.style.bottom = '120px'; // Right above the expanded carousel content

    // Move controls and logo up when expanded
    const controls = document.querySelector('.controls-container');
    if (controls) {
      controls.style.bottom = '120px'; // Move up to make room for carousel + button
    }
    const logo = document.querySelector('.logo-container');
    if (logo) {
      logo.style.bottom = '120px'; // Move up to make room for carousel + button
    }
  } else {
    content.style.display = 'none';
    this.expandBtn.innerHTML = '⬡';
    
    // Keep the expand button at the carousel level when collapsed
    this.expandBtn.style.bottom = '15px'; // Same level as collapsed carousel

    // Move controls and logo back down
    const controls = document.querySelector('.controls-container');
    if (controls) {
      controls.style.bottom = '15px';
    }
    const logo = document.querySelector('.logo-container');
    if (logo) {
      logo.style.bottom = '15px';
    }
  }
}

  navigateCarousel(direction) {
    // Similar to main.js navigation
    const newIndex = this.currentPanoIndex + direction;
    if (newIndex >= 0 && newIndex < this.panoList.length) {
      this.currentPanoIndex = newIndex;
      this.openPanorama(`panos/${this.panoList[newIndex]}`);
      this.scrollCarouselToCurrent();

      // Ensure UI elements remain visible after navigation
      this.ensureUIVisibility();
    }
  }

  scrollCarouselToCurrent() {
    const track = document.getElementById('carouselTrack');
    const container = document.querySelector('.carousel-container');
    if (!track || !container) return;

    const itemWidth = 110; // 100px + 10px margin
    const containerWidth = container.offsetWidth;
    const scrollPosition = this.currentPanoIndex * itemWidth - containerWidth / 2 + itemWidth / 2;
    track.style.transform = `translateX(-${Math.max(0, scrollPosition)}px)`;
  }

  updateCarouselForCurrentPano(panoName) {
    // Normalize panoName by removing leading './' if present
    const normalizedPanoName = panoName.replace(/^\.\//, '');
    const index = this.panoList.findIndex(p => p === normalizedPanoName);
    if (index !== -1) {
      this.currentPanoIndex = index;
      this.updateActiveCarouselItem();
      this.scrollCarouselToCurrent();
    }
  }

  updateActiveCarouselItem() {
    const items = document.querySelectorAll('.carousel-item');
    items.forEach((item, index) => {
      item.classList.toggle('active', index === this.currentPanoIndex);
    });
  }

  setPanoList(panoList) {
    this.panoList = panoList;
    this.currentPanoIndex = 0;
    this.createCarouselItems();
    // Always display carousel in both 3D and pano viewers (if they exist)
    if (this.carouselElement) {
      this.carouselElement.style.display = 'flex';
    }
    if (this.expandBtn) {
      this.expandBtn.style.display = 'block';
    }
  }

createCarouselItems() {
    const track = document.getElementById('carouselTrack');
    if (!track) return;
    track.innerHTML = '';
    
    this.panoList.forEach((pano, index) => {
        const item = document.createElement('div');
        item.className = 'carousel-item';
        item.dataset.pano = pano;
        item.dataset.index = index;
        
        // Create thumbnail image
        const img = document.createElement('img');
        img.src = `${window.PANO_BASE_PATH}${pano}`;
        img.alt = pano.replace('.jpg', '');
        img.style.width = '100%';
        img.style.height = '70%';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '4px';
        
        // Create text label under image with better formatting
        const label = document.createElement('div');
        label.className = 'carousel-item-label';
        
        // Fix the label text by properly decoding and formatting
        let labelText = pano.replace('.jpg', '');
        
        // Decode any URL encoded characters
        try {
            labelText = decodeURIComponent(labelText);
        } catch (e) {
            // If decoding fails, use the original text
            console.warn('Failed to decode filename:', labelText);
        }
        
			// Improve the label formatting
		labelText = labelText
		.replace(/^\.\/\s*/, '')      // Remove leading './' and any spaces after it
		.replace(/[_-]/g, ' ')        // Replace underscores and hyphens with spaces
		.replace(/([A-Z])/g, ' $1')   // Add space before capital letters
		.replace(/^\s+/, '')          // Remove leading spaces
		.replace(/\s+/g, ' ')         // Replace multiple spaces with single space
		.trim();                       // Remove trailing spaces

        
        // Capitalize first letter of each word
        labelText = labelText.split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
        
        label.textContent = labelText;
        label.style.fontSize = '12px';
        label.style.textAlign = 'center';
        label.style.marginTop = '6px';
        label.style.color = 'white';
        label.style.fontWeight = 'bold';
        label.style.textShadow = '0 0 3px rgba(0,0,0,0.7)';
        
        item.appendChild(img);
        item.appendChild(label);
        
        // Make sure the click handler uses the correct path
        item.addEventListener('click', () => {
            const panoPath = `panos/${pano}`;
            console.log('Opening panorama:', panoPath); // For debugging
            this.openPanorama(panoPath);
            // Mark this item active
            this.currentPanoIndex = index;
            this.updateActiveCarouselItem();
            // Ensure UI elements remain visible after clicking
            this.ensureUIVisibility();
        });
        
        track.appendChild(item);
    });
}

  // Method to update hotspot data from HotspotManager
  setVideoHotspotData(videoHotspotData) {
    this.videoHotspotData = videoHotspotData || [];
  }

  setHotspotData(hotspotData) {
    this.hotspotData = hotspotData || [];
    console.log('PanoramaManager received hotspot data:', this.hotspotData.length, 'items');
  }

  saveCurrentView() {
    return {
      pos: this.camera.position.clone(),
      target: this.controls.target.clone(),
      enableZoom: this.controls.enableZoom,
      enablePan: this.controls.enablePan,
      minDistance: this.controls.minDistance,
      maxDistance: this.controls.maxDistance,
      minPolarAngle: this.controls.minPolarAngle,
      maxPolarAngle: this.controls.maxPolarAngle,
      zoomSpeed: this.controls.zoomSpeed
    };
  }

  setupEventListeners() {
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.panoramaActive) {
        this.exitPanorama();
      }
    });

    // Menu button event listener
    if (this.menuBtn) {
      this.menuBtn.addEventListener('click', () => this.toggleSidePanel());
    }
  }

  openPanorama(imageUrl) {
    console.log('Opening panorama:', imageUrl);

    // Ensure DOM elements are initialized
    if (!this.loadingIndicator) {
      this.initializeElements();
    }

    // Ensure UI elements are visible before loading starts
    this.ensureUIVisibility();

    if (this.loadingIndicator) {
      this.loadingIndicator.style.display = 'block';
      // Update loading text for panorama loading
      const loadingText = document.getElementById('loadingText');
      if (loadingText) {
        loadingText.textContent = 'Loading panorama...';
      }
      // Hide progress bar elements for panorama loading
      const progressBar = this.loadingIndicator.querySelector('.progress-bar');
      const progressText = document.getElementById('progressText');
      if (progressBar) progressBar.style.display = 'none';
      if (progressText) progressText.style.display = 'none';
    }

    this.hotspotManager.hideLabels();

    // Use the correct base path for panorama images
    const basePath = window.PANO_BASE_PATH || './panos/';
    const fullImageUrl = imageUrl.startsWith('panos/') ? basePath + imageUrl.substring(6) : imageUrl;
    console.log('Loading panorama from:', fullImageUrl);

    const loader = new THREE.TextureLoader();
    loader.load(
      fullImageUrl,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.flipY = true;

        if (this.loadingIndicator) {
          this.loadingIndicator.style.display = 'none';
          // Restore progress bar elements for future floor loading
          const progressBar = this.loadingIndicator.querySelector('.progress-bar');
          const progressText = document.getElementById('progressText');
          if (progressBar) progressBar.style.display = 'block';
          if (progressText) progressText.style.display = 'block';
        }

        if (this.panoramaMesh) {
          this.scene.remove(this.panoramaMesh);
          this.panoramaMesh.geometry.dispose();
          this.panoramaMesh.material.dispose();
        }

        const geometry = new THREE.SphereGeometry(500, 60, 40);
        geometry.scale(-1, 1, 1);

        const material = new THREE.MeshBasicMaterial({
          map: texture,
          toneMapped: false
        });

        this.panoramaMesh = new THREE.Mesh(geometry, material);
        this.scene.add(this.panoramaMesh);

        this.renderer.toneMappingExposure = 0.8;

        const currentPanoramaName = imageUrl.split('/').pop().replace('.jpg', '');

        // Decode URL encoding (like %20 for spaces) before displaying
        let displayName = currentPanoramaName;
        try {
          displayName = decodeURIComponent(currentPanoramaName);
        } catch (e) {
          console.warn('Failed to decode panorama name:', currentPanoramaName);
        }

        const filteredHotspots = this.hotspotData.filter(
          (h) => h.fromRoom === currentPanoramaName
        );

        // Display panorama name in header
        if (this.headerTitle) {
          const currentTitle = this.headerTitle.dataset.originalTitle || this.headerTitle.textContent || 'Property';
          this.headerTitle.textContent = `${currentTitle} | ${displayName}`;
        }

        // Show panorama carousel and expand button
        if (this.carouselElement) {
          this.carouselElement.style.display = 'flex';
        }
        if (this.expandBtn) {
          this.expandBtn.style.display = 'block';
        }
        // Expand carousel only when entering from 3D view, not when switching panoramas
        if (!this.panoramaActive && !this.carouselExpanded) {
          this.toggleCarousel();
        }

        // Ensure all UI elements are visible and properly positioned
        const controls = document.querySelector('.controls-container');
        const logo = document.querySelector('.logo-container');
        const infoBtn = document.getElementById('infoBtn');
        const fullscreenBtn = document.getElementById('fullscreenBtn');

        if (controls) {
          controls.style.display = 'flex';
        }
        if (logo) {
          logo.style.display = 'block';
        }
        if (infoBtn) {
          infoBtn.style.display = 'flex';
        }
        if (fullscreenBtn) {
          fullscreenBtn.style.display = 'flex';
        }
        if (this.autoRotateBtn) {
          this.autoRotateBtn.style.display = 'flex';
        }

        // Show menu button
        if (this.menuBtn) {
          this.menuBtn.style.display = 'flex';
          // Set icon and position based on current panel state
          const icon = this.menuBtn.querySelector('img');
          if (icon) {
            icon.src = this.sidePanelVisible ? 'textures/left_menu_collapse.svg' : 'textures/left_menu.svg';
          }
          this.menuBtn.style.left = this.sidePanelVisible ? '300px' : '15px';
        }

        this.updateCarouselForCurrentPano(imageUrl.split('/').pop());

        this.hotspotManager.createPanoramaHotspots(filteredHotspots);

        // Rebuild the YouTube panels for this room. clear() blanks each
        // iframe src first -- without that, audio from the previous room
        // keeps playing after the element is detached.
        if (this.roomViewer && this.roomViewer.videoHotspots) {
          const panoFile = 'panos/' + imageUrl.split('/').pop();
          this.roomViewer.videoHotspots.clear();
          this.roomViewer.videoHotspots.show();
          (this.videoHotspotData || [])
            .filter((v) => v.panoramaImage === panoFile)
            .forEach((v) => this.roomViewer.videoHotspots.addYouTube(v));

          // Only show the toggle in rooms that actually have a video panel.
          if (this.videoMuteBtn) {
            const hasVideo = this.roomViewer.videoHotspots.panels.length > 0;
            this.videoMuteBtn.style.display = hasVideo ? 'flex' : 'none';
            if (hasVideo) this._updateVideoMuteIcon(this.roomViewer.videoHotspots.muted);
          }
        } else if (this.videoMuteBtn) {
          this.videoMuteBtn.style.display = 'none';
        }

        this.hideRoomElements();
        if (!this.panoramaActive) this.savedView = this.saveCurrentView();
        this.setPanoramaCameraSettings();

        if (this.panoHint) {
          this.panoHint.style.display = 'block';
        }
        this.panoramaActive = true;

        // Final check to ensure UI elements remain visible after all operations
        setTimeout(() => {
          this.ensureUIVisibility();
        }, 100);
      },
      undefined,
      (err) => {
        if (this.loadingIndicator) {
          this.loadingIndicator.style.display = 'none';
          // Restore progress bar elements for future floor loading
          const progressBar = this.loadingIndicator.querySelector('.progress-bar');
          const progressText = document.getElementById('progressText');
          if (progressBar) progressBar.style.display = 'block';
          if (progressText) progressText.style.display = 'block';
        }
        console.error('Panorama load error:', err);
        alert(`Failed to load panorama: ${imageUrl}.`);
        this.hotspotManager.showLabels();
      }
    );
  }

  exitPanorama() {
    console.log('Exiting panorama, cleaning up...');
    console.log('Panorama active before exit:', this.panoramaActive);
    console.log('Panorama mesh exists:', !!this.panoramaMesh);

    // BUGFIX (a panorama hotspot's room name -- e.g. "Dining Room" --
    // left floating in the 3D view after leaving the panorama): this used
    // to remove each hotspot GROUP by hand, but the name label is not in
    // the group. It is its own scene child (so it stays upright; see
    // HotspotManager.createPanoramaHotspots()), drawn with depthTest off on
    // top of everything -- so it was never removed and stayed on screen.
    // The hand-rolled loop also disposed the ring/pulse/chevron geometry
    // that glow-hotspot.js shares across every marker, and left the stale
    // groups in the manager's list. clearPanoramaHotspots() already does
    // all of this correctly: disposes the per-hotspot materials, removes
    // label and group, and empties the list.
    this.hotspotManager.clearPanoramaHotspots();

    if (this.panoramaMesh) {
      console.log('Removing panorama mesh from scene');
      console.log('Scene children before removal:', this.scene.children.length);
      console.log('Panorama mesh in scene before removal:', this.scene.children.includes(this.panoramaMesh));

      // Dispose of resources first
      this.panoramaMesh.geometry?.dispose();
      if (this.panoramaMesh.material) {
        this.panoramaMesh.material.map?.dispose();
        this.panoramaMesh.material.dispose();
      }

      // Then remove from scene
      this.scene.remove(this.panoramaMesh);
      console.log('Scene children after removal:', this.scene.children.length);
      console.log('Panorama mesh in scene after removal:', this.scene.children.includes(this.panoramaMesh));

      this.panoramaMesh = null;
      console.log('Panorama mesh removed and disposed');
    } else {
      console.log('No panorama mesh to remove');
    }

    console.log('Restoring tone mapping exposure from', this.renderer.toneMappingExposure, 'to', this.originalToneMappingExposure);
    this.renderer.toneMappingExposure = this.originalToneMappingExposure;
    console.log('Tone mapping exposure restored to', this.renderer.toneMappingExposure);

    this.showRoomElements();
    this.restoreCameraSettings();

    if (this.panoHint) {
      this.panoHint.style.display = 'none';
    }
    if (this.hotspotTooltip) {
      this.hotspotTooltip.style.display = 'none';
    }
    if (this.headerTitle) {
      this.headerTitle.textContent = this.headerTitle.dataset.originalTitle || 'Property';
    }
    
    // Hide expand button but keep carousel always visible
    if (this.expandBtn) {
      this.expandBtn.style.display = 'none';
    }

    // Reset carousel to collapsed state when exiting panorama
    this.carouselExpanded = false;
    if (this.carouselElement) {
      const content = this.carouselElement.querySelector('.carousel-content');
      if (content) {
        content.style.display = 'none';
      }
    }
    if (this.expandBtn) {
      this.expandBtn.style.display = 'block';
      this.expandBtn.innerHTML = '⬡';
      this.expandBtn.style.bottom = '15px';
    }

    // Hide menu button and side panel
    if (this.menuBtn) {
      this.menuBtn.style.display = 'none';
    }
    if (this.autoRotateBtn) {
      this.autoRotateBtn.style.display = 'none';
    }
    if (this.videoMuteBtn) {
      this.videoMuteBtn.style.display = 'none';
    }
    if (this.sidePanel) {
      this.sidePanel.style.display = 'none';
      this.sidePanelVisible = false;
    }

    // Reset controls and logo position
    const controls = document.querySelector('.controls-container');
    if (controls) {
      controls.style.bottom = '15px';
    }
    const logo = document.querySelector('.logo-container');
    if (logo) {
      logo.style.bottom = '15px';
    }
    document.querySelector('canvas').style.cursor = 'grab';
    this.panoramaActive = false;
    console.log('Panorama marked as inactive');

    // Stops playback and removes the DOM layer from view.
    if (this.roomViewer && this.roomViewer.videoHotspots) {
      this.roomViewer.videoHotspots.clear();
      this.roomViewer.videoHotspots.hide();
    }

    if (this.wheelHandler) {
      window.removeEventListener('wheel', this.wheelHandler);
      this.wheelHandler = null;
    }
    if (this.startListener) {
      this.controls.removeEventListener('start', this.startListener);
      this.startListener = null;
    }
    if (this.endListener) {
      this.controls.removeEventListener('end', this.endListener);
      this.endListener = null;
    }
    clearTimeout(this.autoRotateTimeout);

    // Force a render update to ensure panorama is removed from view
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    console.log('Panorama exit complete - label management handled by main viewer');
  }

  hideRoomElements() {
    window.dispatchEvent(new CustomEvent('hideRoomModel'));
  }

  showRoomElements() {
    window.dispatchEvent(new CustomEvent('showRoomModel'));
  }

  setPanoramaCameraSettings() {
    this.camera.position.set(0, 0, 0);
    this.controls.target.set(0, 0, -1);

    this.controls.enablePan = false;
    this.controls.enableZoom = false;

    this.controls.minPolarAngle = 0.01;
    this.controls.maxPolarAngle = Math.PI - 0.01;

    this.camera.fov = 75;
    this.camera.minFov = 30;
    this.camera.maxFov = 90;
    this.camera.updateProjectionMatrix();

    this.wheelHandler = (event) => {
      const zoomSpeed = 1;
      if (event.deltaY < 0) {
        this.camera.fov = Math.max(this.camera.minFov, this.camera.fov - zoomSpeed);
      } else {
        this.camera.fov = Math.min(this.camera.maxFov, this.camera.fov + zoomSpeed);
      }
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener('wheel', this.wheelHandler);

    this.controls.autoRotate = !this.userStoppedAutoRotate;
    this.controls.autoRotateSpeed = 0.9;

    // Remove existing listeners if any
    if (this.startListener) {
      this.controls.removeEventListener('start', this.startListener);
    }
    if (this.endListener) {
      this.controls.removeEventListener('end', this.endListener);
    }

    this.startListener = () => {
      console.log('Panorama: Auto-rotate stopped (user interaction started)');
      this.controls.autoRotate = false;
    };
    this.endListener = () => {
      console.log('Panorama: User interaction ended, scheduling auto-rotate restart');
      clearTimeout(this.autoRotateTimeout);
      this.autoRotateTimeout = setTimeout(() => {
        if (this.panoramaActive && !this.userStoppedAutoRotate) {
          console.log('Panorama: Auto-rotate restarted');
          this.controls.autoRotate = true;
        }
      }, 1000); // Reduced delay to 1 second
    };

    this.controls.addEventListener('start', this.startListener);
    this.controls.addEventListener('end', this.endListener);
  }

  restoreCameraSettings() {
    console.log('Restoring camera settings');
    console.log('Saved position:', this.savedView.pos);
    console.log('Saved target:', this.savedView.target);
    console.log('Current position before restore:', this.camera.position);
    console.log('Current target before restore:', this.controls.target);

    this.controls.autoRotate = false;

    this.camera.position.copy(this.savedView.pos);
    this.controls.target.copy(this.savedView.target);
    this.controls.enablePan = this.savedView.enablePan;
    this.controls.enableZoom = this.savedView.enableZoom;
    this.controls.minDistance = this.savedView.minDistance;
    this.controls.maxDistance = this.savedView.maxDistance;
    this.controls.minPolarAngle = this.savedView.minPolarAngle;
    this.controls.maxPolarAngle = this.savedView.maxPolarAngle;
    this.controls.zoomSpeed = this.savedView.zoomSpeed;

    this.controls.update();
    console.log('Camera position after restore:', this.camera.position);
    console.log('Camera target after restore:', this.controls.target);
    console.log('Camera settings restored, auto-rotate disabled');
  }

  handleMouseMove(event, raycaster, mouse, renderer) {
    if (!this.panoramaActive) return;

    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, this.camera);
    const intersects = raycaster.intersectObjects(
      this.hotspotManager.getPanoramaHotspots(),
      true
    );

    if (intersects.length > 0) {
      let hotspotGroup = intersects[0].object;
      while (hotspotGroup.parent && !hotspotGroup.userData.info) {
        hotspotGroup = hotspotGroup.parent;
      }
      if (hotspotGroup.userData.info) {
        const info = hotspotGroup.userData.info;
        this.hotspotManager.setHoveredHotspot(hotspotGroup);
        if (this.hotspotTooltip) {
          this.hotspotTooltip.textContent = `${info.name}: ${info.description}`;
          this.hotspotTooltip.style.left = event.clientX + 10 + 'px';
          this.hotspotTooltip.style.top = event.clientY - 10 + 'px';
          this.hotspotTooltip.style.display = 'block';
        }
        renderer.domElement.style.cursor = 'pointer';
      }
    } else {
      this.hotspotManager.setHoveredHotspot(null);
      if (this.hotspotTooltip) {
        this.hotspotTooltip.style.display = 'none';
      }
      renderer.domElement.style.cursor = 'grab';
    }
  }

  handleClick(intersects) {
    if (!this.panoramaActive || intersects.length === 0) return false;

    let hotspotGroup = intersects[0].object;
    while (hotspotGroup.parent && !hotspotGroup.userData.info) {
      hotspotGroup = hotspotGroup.parent;
    }

    if (hotspotGroup.userData.info) {
      const info = hotspotGroup.userData.info;
      this.openPanorama(info.panoramaImage);
      return true;
    }

    return false;
  }

  isActive() {
    return this.panoramaActive;
  }

  adjustBrightness(exposure = 0.8) {
    if (this.panoramaActive) {
      this.renderer.toneMappingExposure = exposure;
    }
  }

  ensureUIVisibility() {
    // Ensure all UI elements are visible and properly positioned
    const controls = document.querySelector('.controls-container');
    const logo = document.querySelector('.logo-container');
    const infoBtn = document.getElementById('infoBtn');
    const fullscreenBtn = document.getElementById('fullscreenBtn');

    if (controls) {
      controls.style.display = 'flex';
      // Adjust position based on carousel state
      controls.style.bottom = this.carouselExpanded ? '120px' : '15px';
    }
    if (logo) {
      logo.style.display = 'block';
      // Adjust position based on carousel state
      logo.style.bottom = this.carouselExpanded ? '120px' : '15px';
    }
    if (infoBtn) {
      infoBtn.style.display = 'flex';
    }
    if (fullscreenBtn) {
      fullscreenBtn.style.display = 'flex';
    }
    if (this.autoRotateBtn) {
      this.autoRotateBtn.style.display = 'flex';
    }
    if (this.videoMuteBtn && this.roomViewer && this.roomViewer.videoHotspots) {
      const hasVideo = this.roomViewer.videoHotspots.panels.length > 0;
      this.videoMuteBtn.style.display = hasVideo ? 'flex' : 'none';
    }
  }

  updateCarouselVisibility(isFloorPlanView) {
    if (this.carouselElement && this.expandBtn) {
      if (isFloorPlanView) {
        this.carouselElement.style.display = 'none';
        this.expandBtn.style.display = 'none';

        // Reset controls and logo positions when hiding carousel (floor plan view)
        const controls = document.querySelector('.controls-container');
        const logo = document.querySelector('.logo-container');

        if (controls) {
          controls.style.bottom = '15px';
        }
        if (logo) {
          logo.style.bottom = '15px';
        }
      } else {
        this.carouselElement.style.display = 'flex';
        this.expandBtn.style.display = 'block';

        // Ensure controls and logo are positioned correctly when showing carousel
        const controls = document.querySelector('.controls-container');
        const logo = document.querySelector('.logo-container');

        if (controls) {
          // Position based on carousel expansion state
          controls.style.bottom = this.carouselExpanded ? '120px' : '15px';
        }
        if (logo) {
          // Position based on carousel expansion state
          logo.style.bottom = this.carouselExpanded ? '120px' : '15px';
        }
      }
    }
  }
}