// Modal functionality for 3D tours

function close3DTour() {
  const modal = document.getElementById('tourModal');
  const tourFrame = document.getElementById('tourFrame');

  // Hide the modal
  modal.style.display = 'none';

  // Restore body scroll
  document.body.style.overflow = 'auto';

  // Clear the iframe source to stop the 3D viewer
  tourFrame.src = '';
}

// Enhanced tour opening with loading state
function open3DTour(propertyId) {
  const modal = document.getElementById('tourModal');
  const tourFrame = document.getElementById('tourFrame');
  const tourButton = event.target;

  // Find property by ID
  const property = properties.find(p => p.id === propertyId);
  const taskFolder = property ? property.taskId : "TaskID_default";

    // Show loading state
    const originalText = tourButton.textContent;
    tourButton.textContent = 'Loading 3D Tour...';
    tourButton.disabled = true;
    tourButton.style.opacity = '0.7';

    // Clear any existing iframe content
    tourFrame.src = '';

    // Show the modal with loading state
    modal.style.display = 'block';

    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';

    // Add a small delay to ensure modal is visible before loading iframe
    setTimeout(() => {
        // Pass taskFolder as query param to the viewer
        tourFrame.src = `3DViewer_v1_5_3/index.html?taskId=${taskFolder}`;

        // Restore button when iframe loads
        tourFrame.onload = function() {
            tourButton.textContent = originalText;
            tourButton.disabled = false;
            tourButton.style.opacity = '1';
        };

        // Handle iframe load errors
        tourFrame.onerror = function() {
            tourButton.textContent = 'Error loading tour';
            tourButton.disabled = false;
            tourButton.style.opacity = '1';
            setTimeout(() => {
                close3DTour();
                alert('Failed to load 3D tour. Please try again.');
            }, 2000);
        };
    }, 300);
}

function openPhotorealView(propertyId) {
  const property = properties.find(p => p.id === propertyId);
  if (!property) return;

  const taskFolder = property.taskId;

  // Show dialog for PT/BDPT selection
  showRendererDialog(taskFolder);
}

function showRendererDialog(taskFolder) {
  // Create dialog if it doesn't exist
  let dialog = document.getElementById('rendererDialog');
  if (!dialog) {
    dialog = document.createElement('div');
    dialog.id = 'rendererDialog';
    dialog.className = 'renderer-dialog';
    dialog.innerHTML = `
      <div class="renderer-dialog-content">
        <h2>Choose 3D View Type</h2>
        <p>Select how you want to view the property:</p>
        <div class="renderer-options">
          <button class="renderer-btn pt-btn" onclick="openPTView('${taskFolder}')">
            <span class="renderer-icon">☀️</span>
            <span class="renderer-title">Daylight View</span>
            <span class="renderer-desc">Path Tracer (PT)</span>
          </button>
          <button class="renderer-btn bdpt-btn" onclick="openBDPTView('${taskFolder}')">
            <span class="renderer-icon">🌙</span>
            <span class="renderer-title">Night Time View</span>
            <span class="renderer-desc">Bidirectional Path Tracer (BDPT)</span>
          </button>
        </div>
        <button class="renderer-cancel" onclick="closeRendererDialog()">Cancel</button>
      </div>
    `;
    document.body.appendChild(dialog);

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      .renderer-dialog {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.7);
        z-index: 10000;
        justify-content: center;
        align-items: center;
      }
      .renderer-dialog.active {
        display: flex;
      }
      .renderer-dialog-content {
        background: white;
        padding: 30px;
        border-radius: 12px;
        text-align: center;
        max-width: 500px;
        width: 90%;
      }
      .renderer-dialog-content h2 {
        margin: 0 0 10px 0;
        color: #333;
      }
      .renderer-dialog-content p {
        color: #666;
        margin-bottom: 25px;
      }
      .renderer-options {
        display: flex;
        gap: 15px;
        justify-content: center;
        margin-bottom: 20px;
      }
      .renderer-btn {
        flex: 1;
        padding: 20px 15px;
        border: 2px solid #e0e0e0;
        border-radius: 10px;
        background: white;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      .renderer-btn:hover {
        border-color: #007bff;
        transform: translateY(-3px);
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.1);
      }
      .pt-btn:hover {
        border-color: #ffc107;
      }
      .bdpt-btn:hover {
        border-color: #6f42c1;
      }
      .renderer-icon {
        display: block;
        font-size: 32px;
        margin-bottom: 10px;
      }
      .renderer-title {
        display: block;
        font-size: 16px;
        font-weight: bold;
        color: #333;
        margin-bottom: 5px;
      }
      .renderer-desc {
        display: block;
        font-size: 12px;
        color: #888;
      }
      .renderer-cancel {
        padding: 10px 30px;
        border: none;
        background: #f0f0f0;
        border-radius: 5px;
        cursor: pointer;
        font-size: 14px;
        color: #666;
      }
      .renderer-cancel:hover {
        background: #e0e0e0;
      }
    `;
    document.head.appendChild(style);
  }

  // Update task folder in dialog
  dialog.querySelector('.pt-btn').setAttribute('onclick', `openPTView('${taskFolder}')`);
  dialog.querySelector('.bdpt-btn').setAttribute('onclick', `openBDPTView('${taskFolder}')`);

  dialog.classList.add('active');
}

function closeRendererDialog() {
  const dialog = document.getElementById('rendererDialog');
  if (dialog) {
    dialog.classList.remove('active');
  }
}

function openPTView(taskFolder) {
  closeRendererDialog();
  window.location.href = `Path Tracer/PT/Path Traycer.html?taskId=${taskFolder}`;
}

function openBDPTView(taskFolder) {
  closeRendererDialog();
  window.location.href = `Path Tracer/BDPT/Path Traycer.html?taskId=${taskFolder}`;
}

// Pricing plan monthly/annual toggle
document.addEventListener('DOMContentLoaded', function() {
    const pricingToggle = document.getElementById('pricingToggle');

    function syncPricingCtaLinks(period) {
        document.querySelectorAll('.pricing-cta[data-plan]').forEach(link => {
            const plan = link.dataset.plan;
            link.href = `checkout.html?plan=${plan}&period=${period}`;
        });
    }

    // Set initial links to match the default (monthly) toggle state
    syncPricingCtaLinks('monthly');

    if (pricingToggle) {
        pricingToggle.addEventListener('click', function(e) {
            const btn = e.target.closest('button[data-period]');
            if (!btn) return;

            const period = btn.dataset.period;

            pricingToggle.querySelectorAll('button').forEach(b => {
                b.classList.toggle('active', b === btn);
            });

            document.querySelectorAll('.pricing-card .price').forEach(priceEl => {
                priceEl.style.display = (priceEl.dataset.period === period) ? 'block' : 'none';
            });

            syncPricingCtaLinks(period);
        });
    }
});

// Click-to-load demo canvases (avoids loading heavy WebGL contexts on page load),
// with a Stop button to unload them again and free up GPU/CPU.
document.addEventListener('DOMContentLoaded', function() {

    function setupClickToLoadDemo({ wrapId, posterId, playBtnId, stopBtnId, title, getSrc }) {
        const wrap = document.getElementById(wrapId);
        const poster = document.getElementById(posterId);
        const playBtn = document.getElementById(playBtnId);
        const stopBtn = document.getElementById(stopBtnId);
        if (!wrap || !poster || !playBtn) return null;

        let iframe = null;

        function load() {
            if (iframe) return; // already loaded
            iframe = document.createElement('iframe');
            iframe.className = 'demo-frame';
            iframe.title = title;
            iframe.src = getSrc();
            wrap.appendChild(iframe);
            poster.style.display = 'none';
            if (stopBtn) stopBtn.hidden = false;
        }

        function unload() {
            if (!iframe) return;
            iframe.remove();
            iframe = null;
            poster.style.display = 'flex';
            if (stopBtn) stopBtn.hidden = true;
        }

        playBtn.addEventListener('click', load);
        if (stopBtn) stopBtn.addEventListener('click', unload);

        return {
            isLoaded: () => !!iframe,
            updateSrc: () => { if (iframe) iframe.src = getSrc(); }
        };
    }

    // 3D Viewer demo
    setupClickToLoadDemo({
        wrapId: 'viewerFrameWrap',
        posterId: 'viewerPoster',
        playBtnId: 'viewerPlayBtn',
        stopBtnId: 'viewerStopBtn',
        title: 'MetaRoom3D 3D Viewer Demo',
        getSrc: () => document.getElementById('viewerFrameWrap').dataset.src
    });

    // Path Tracer demo (PT/BDPT mode selectable before AND after loading)
    let ptMode = 'pt';
    const ptWrap = document.getElementById('ptFrameWrap');
    const ptToggle = document.getElementById('ptToggle');

    const ptDemo = setupClickToLoadDemo({
        wrapId: 'ptFrameWrap',
        posterId: 'ptPoster',
        playBtnId: 'ptPlayBtn',
        stopBtnId: 'ptStopBtn',
        title: 'MetaRoom3D Path Tracer Demo',
        getSrc: () => ptMode === 'bdpt' ? ptWrap.dataset.srcBdpt : ptWrap.dataset.srcPt
    });

    if (ptToggle && ptDemo) {
        ptToggle.addEventListener('click', function(e) {
            const btn = e.target.closest('button[data-mode]');
            if (!btn) return;

            ptMode = btn.dataset.mode;
            ptToggle.querySelectorAll('button').forEach(b => {
                b.classList.toggle('active', b === btn);
            });

            // If already loaded, switch it live; otherwise the chosen mode
            // is remembered for when Play is clicked.
            ptDemo.updateSrc();
        });
    }
});

// Scroll-reveal: fade/slide elements in the first time they enter the viewport
document.addEventListener('DOMContentLoaded', function() {
    const revealEls = document.querySelectorAll('.scroll-reveal');
    if (!revealEls.length) return;

    if (!('IntersectionObserver' in window)) {
        // Fallback: just show everything if the browser can't observe
        revealEls.forEach(el => el.classList.add('is-visible'));
        return;
    }

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('is-visible');
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.2, rootMargin: '0px 0px -60px 0px' });

    revealEls.forEach(el => observer.observe(el));
});

// Hamburger menu functionality
document.addEventListener('DOMContentLoaded', function() {
    const hamburger = document.querySelector('.hamburger');
    const navMenu = document.querySelector('.nav-menu');

    if (hamburger && navMenu) {
        hamburger.addEventListener('click', function() {
            navMenu.classList.toggle('active');
            hamburger.classList.toggle('active');
        });

        // Close menu when clicking on a link
        const navLinks = navMenu.querySelectorAll('a');
        navLinks.forEach(link => {
            link.addEventListener('click', function() {
                navMenu.classList.remove('active');
                hamburger.classList.remove('active');
            });
        });
    }
});

// Hero animation is now a <video> (assets/logo-hero.webm / .mp4).
// The old 192-frame PNG canvas loader was removed — it fired 192
// image requests on load and ran requestAnimationFrame forever.
//
// There is no poster image, so for visitors who ask for reduced motion we
// hold the video on its first frame rather than hiding it (hiding it would
// leave an empty hero).
(function () {
  const v = document.querySelector('video.hero-video');
  if (!v || !window.matchMedia) return;
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const apply = () => {
    if (mq.matches) {
      v.removeAttribute('autoplay');
      v.pause();
      try { v.currentTime = 0; } catch (e) { /* not seekable yet */ }
    } else if (v.paused) {
      v.play().catch(() => { /* autoplay blocked; first frame still shows */ });
    }
  };
  apply();
  v.addEventListener('loadeddata', apply);
  mq.addEventListener ? mq.addEventListener('change', apply)
                      : mq.addListener(apply);
})();

// Close modal when clicking outside the content
window.onclick = function(event) {
    const modal = document.getElementById('tourModal');
    if (event.target === modal) {
        close3DTour();
    }
}

// ==========================================================================
// Download Now — email capture -> admin notification (Web3Forms) -> installer
// ==========================================================================
// Uses the same Web3Forms access key as the Contact form (index.html), so
// submissions land in the same inbox (metaroom3d@gmail.com) with no extra
// account or backend needed. See README-downloads.md for setup notes.
const DOWNLOADS = {
  roomlayout: {
    label: 'MetaRoom3D Room Layout Editor 2026',
    size: '~93 MB',
    // Hosted on Cloudflare R2 (custom domain), not GitHub Releases.
    url: 'https://dl.metaroom3d.com/MetaRoom3D_RoomLayoutEditor_Setup_2026.exe'
  },
  sphere: {
    label: 'MetaRoom3D Sphere',
    size: '~22 MB',
    // Hosted on Cloudflare R2 (custom domain), not GitHub Releases.
    url: 'https://dl.metaroom3d.com/MetaRoom3D_Sphere_Setup_1.0.0.exe'
  }
};

const WEB3FORMS_KEY = '617b198d-8043-49f2-badf-cc7175946359'; // same key the Contact form uses

let pendingDownloadKey = null;

function openDownloadModal(productKey) {
  const product = DOWNLOADS[productKey];
  if (!product) return;
  pendingDownloadKey = productKey;

  const modal = document.getElementById('downloadModal');
  const title = document.getElementById('downloadModalTitle');
  const sub = document.getElementById('downloadModalSub');
  const status = document.getElementById('downloadStatus');
  const submitBtn = document.getElementById('downloadSubmitBtn');
  const emailInput = document.getElementById('downloadEmail');

  if (title) title.textContent = 'Download ' + product.label;
  if (sub) {
    sub.textContent = product.size + ' \u2014 enter your email and the download will start right away. ' +
      'Every install needs an activated license key (7-day free trial available on the Products page).';
  }
  if (status) { status.textContent = ''; status.className = 'download-status'; }
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Download Now'; }
  if (emailInput) emailInput.value = '';
  if (modal) modal.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeDownloadModal() {
  const modal = document.getElementById('downloadModal');
  if (modal) modal.style.display = 'none';
  document.body.style.overflow = '';
}

document.addEventListener('DOMContentLoaded', function () {
  const form = document.getElementById('downloadForm');
  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const product = DOWNLOADS[pendingDownloadKey];
    if (!product) return;

    const emailInput = document.getElementById('downloadEmail');
    const status = document.getElementById('downloadStatus');
    const submitBtn = document.getElementById('downloadSubmitBtn');
    const email = (emailInput.value || '').trim();
    if (!email) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Preparing download\u2026';
    status.textContent = '';
    status.className = 'download-status';

    try {
      await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: WEB3FORMS_KEY,
          subject: 'Download: ' + product.label,
          from_name: 'MetaRoom3D Downloads',
          email: email, // downloader's address -> becomes the reply-to on the notification
          message: email + ' just started downloading ' + product.label + '.'
        })
      });
    } catch (err) {
      // Don't let a notification hiccup block the customer's download.
      console.error('Download notification failed:', err);
    }

    status.textContent = 'Thanks! Your download is starting\u2026';
    status.className = 'download-status success';
    window.location.href = product.url;

    setTimeout(closeDownloadModal, 1500);
  });
});

// Close the download modal when clicking outside its content
window.addEventListener('click', function (event) {
  const modal = document.getElementById('downloadModal');
  if (modal && event.target === modal) {
    closeDownloadModal();
  }
});

// ==========================================================================
// Contact form — same fetch()-based Web3Forms pattern as the Download modal.
// No `action`/navigation: submit is caught here, sent via fetch, and the
// page shows an inline success/error message instead of leaving the site.
// ==========================================================================
document.addEventListener('DOMContentLoaded', function () {
  const form = document.getElementById('contactForm');
  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    const nameInput = document.getElementById('contactName');
    const emailInput = document.getElementById('contactEmail');
    const messageInput = document.getElementById('contactMessage');
    const status = document.getElementById('contactStatus');
    const submitBtn = document.getElementById('contactSubmitBtn');

    const name = (nameInput.value || '').trim();
    const email = (emailInput.value || '').trim();
    const message = (messageInput.value || '').trim();
    if (!name || !email || !message) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending\u2026';
    status.textContent = '';
    status.className = 'download-status';

    try {
      const response = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: WEB3FORMS_KEY, // same key used for download notifications
          subject: 'New Contact Message - MetaRoom3D',
          from_name: name,
          email: email, // sender's address -> becomes the reply-to on the notification
          message: message
        })
      });
      const result = await response.json();

      if (result.success) {
        status.textContent = 'Thanks! Your message has been sent \u2014 we\u2019ll get back to you soon.';
        status.className = 'download-status success';
        form.reset();
      } else {
        throw new Error(result.message || 'Submission failed');
      }
    } catch (err) {
      console.error('Contact form submission failed:', err);
      status.textContent = 'Something went wrong sending your message. Please try again or email metaroom3d@gmail.com directly.';
      status.className = 'download-status error';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send Message';
    }
  });
});
