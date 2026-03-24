/**
 * CLASHD27 — Standalone 3D Cube Visualization
 * Reusable Three.js component for embedding in any page.
 *
 * Usage:
 *   <canvas id="cube-canvas"></canvas>
 *   <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
 *   <script src="/js/cube-visual.js"></script>
 *   <script>
 *     const cube = new CubeVisual('cube-canvas', { interactive: true });
 *     cube.highlightCollision(3, 19); // highlight two colliding cells
 *   </script>
 */

class CubeVisual {
  constructor(canvasId, options = {}) {
    this.canvas = document.getElementById(canvasId);
    if (!this.canvas) return;

    this.opts = Object.assign({
      interactive: true,    // drag to rotate, scroll to zoom
      autoRotate: true,     // slow auto rotation
      showAgents: false,    // show agent spheres
      showEdges: true,      // wireframe edges
      size: null,           // null = fill parent
      highlightA: null,     // cell index to highlight (collision A)
      highlightB: null,     // cell index to highlight (collision B)
      activeCell: null,     // pulsing active cell
    }, options);

    this._init();
    this._animate();
  }

  _init() {
    const canvas = this.canvas;
    const parent = canvas.parentElement;
    const w = this.opts.size || parent.clientWidth || window.innerWidth;
    const h = this.opts.size || parent.clientHeight || window.innerHeight;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(6, 5, 8);
    this.camera.lookAt(0, 0, 0);

    // Colors
    this.LAYER_COLORS = [0x00FF88, 0x4488FF, 0xFF4500];
    this.ACTIVE_COLOR = 0xFFDD00;
    this.HIGHLIGHT_A = 0xFF4500;
    this.HIGHLIGHT_B = 0x4488FF;
    this.COLLISION_COLOR = 0xFFDD00;

    // Group
    this.cubeGroup = new THREE.Group();
    this.scene.add(this.cubeGroup);

    // Cell positions
    this.cellPositions = [];
    this.cellMeshes = [];
    const spacing = 1.4;
    for (let i = 0; i < 27; i++) {
      const layer = Math.floor(i / 9);
      const rem = i % 9;
      const row = Math.floor(rem / 3);
      const col = rem % 3;
      const x = (col - 1) * spacing;
      const y = (layer - 1) * spacing;
      const z = (row - 1) * spacing;
      this.cellPositions.push(new THREE.Vector3(x, y, z));
    }

    // Cell nodes
    const cellGeo = new THREE.SphereGeometry(0.08, 8, 8);
    for (let i = 0; i < 27; i++) {
      const layer = Math.floor(i / 9);
      const mat = new THREE.MeshBasicMaterial({
        color: this.LAYER_COLORS[layer],
        transparent: true,
        opacity: 0.5
      });
      const mesh = new THREE.Mesh(cellGeo, mat);
      mesh.position.copy(this.cellPositions[i]);
      this.cubeGroup.add(mesh);
      this.cellMeshes.push(mesh);
    }

    // Wireframe edges
    if (this.opts.showEdges) {
      const edgeMat = new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.35 });
      for (let layer = 0; layer < 3; layer++) {
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) {
            const idx = layer * 9 + row * 3 + col;
            if (col < 2) {
              const idx2 = layer * 9 + row * 3 + (col + 1);
              const geo = new THREE.BufferGeometry().setFromPoints([this.cellPositions[idx], this.cellPositions[idx2]]);
              this.cubeGroup.add(new THREE.Line(geo, edgeMat));
            }
            if (row < 2) {
              const idx2 = layer * 9 + (row + 1) * 3 + col;
              const geo = new THREE.BufferGeometry().setFromPoints([this.cellPositions[idx], this.cellPositions[idx2]]);
              this.cubeGroup.add(new THREE.Line(geo, edgeMat));
            }
            if (layer < 2) {
              const idx2 = (layer + 1) * 9 + row * 3 + col;
              const geo = new THREE.BufferGeometry().setFromPoints([this.cellPositions[idx], this.cellPositions[idx2]]);
              this.cubeGroup.add(new THREE.Line(geo, edgeMat));
            }
          }
        }
      }
    }

    // Active cell glow
    const glowGeo = new THREE.SphereGeometry(0.18, 16, 16);
    this.glowMat = new THREE.MeshBasicMaterial({ color: this.ACTIVE_COLOR, transparent: true, opacity: 0.4 });
    this.glowMesh = new THREE.Mesh(glowGeo, this.glowMat);
    this.glowMesh.visible = false;
    this.cubeGroup.add(this.glowMesh);
    this.activeCell = this.opts.activeCell;
    if (this.activeCell !== null) {
      this.glowMesh.position.copy(this.cellPositions[this.activeCell]);
      this.glowMesh.visible = true;
    }

    // Collision line
    this.collisionLine = null;

    // Apply initial highlights
    if (this.opts.highlightA !== null || this.opts.highlightB !== null) {
      this.highlightCollision(this.opts.highlightA, this.opts.highlightB);
    }

    // Interaction
    if (this.opts.interactive) {
      this._setupInteraction();
    }

    // Resize
    this._resizeHandler = () => {
      const pw = parent.clientWidth || window.innerWidth;
      const ph = parent.clientHeight || window.innerHeight;
      this.camera.aspect = pw / ph;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(pw, ph);
    };
    window.addEventListener('resize', this._resizeHandler);

    // Clock
    this.clock = new THREE.Clock();
    this.rotVel = { x: 0, y: 0 };
    this.isDragging = false;
  }

  _setupInteraction() {
    let prevMouse = { x: 0, y: 0 };

    this.canvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      prevMouse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('pointerup', () => { this.isDragging = false; });
    window.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - prevMouse.x;
      const dy = e.clientY - prevMouse.y;
      this.rotVel.y += dx * 0.003;
      this.rotVel.x += dy * 0.003;
      prevMouse = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('wheel', (e) => {
      this.camera.position.multiplyScalar(e.deltaY > 0 ? 1.05 : 0.95);
      this.camera.position.clampLength(4, 20);
    }, { passive: true });
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    const t = this.clock.getElapsedTime();

    // Auto-rotate
    if (this.opts.autoRotate && !this.isDragging) {
      this.cubeGroup.rotation.y += 0.003;
      this.cubeGroup.rotation.x += 0.001;
    }

    // Drag momentum
    this.cubeGroup.rotation.y += this.rotVel.y;
    this.cubeGroup.rotation.x += this.rotVel.x;
    this.rotVel.x *= 0.95;
    this.rotVel.y *= 0.95;

    // Active cell pulse
    if (this.activeCell !== null) {
      const pulse = 0.3 + Math.sin(t * 3) * 0.2;
      this.glowMat.opacity = pulse;
      this.glowMesh.scale.setScalar(1 + Math.sin(t * 3) * 0.2);
    }

    // Highlighted cells pulse
    for (let i = 0; i < 27; i++) {
      const mesh = this.cellMeshes[i];
      if (mesh._highlighted) {
        mesh.material.opacity = 0.7 + Math.sin(t * 4 + i) * 0.3;
        mesh.scale.setScalar(1.5 + Math.sin(t * 3) * 0.3);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  setActiveCell(cellIndex) {
    this.activeCell = cellIndex;
    if (cellIndex !== null && cellIndex >= 0 && cellIndex < 27) {
      this.glowMesh.position.copy(this.cellPositions[cellIndex]);
      this.glowMesh.visible = true;
    } else {
      this.glowMesh.visible = false;
    }
  }

  highlightCollision(cellA, cellB) {
    // Reset all cells
    for (let i = 0; i < 27; i++) {
      const layer = Math.floor(i / 9);
      this.cellMeshes[i].material.color.setHex(this.LAYER_COLORS[layer]);
      this.cellMeshes[i].material.opacity = 0.5;
      this.cellMeshes[i].scale.setScalar(1);
      this.cellMeshes[i]._highlighted = false;
    }

    // Remove old collision line
    if (this.collisionLine) {
      this.cubeGroup.remove(this.collisionLine);
      this.collisionLine = null;
    }

    if (cellA === null && cellB === null) return;

    // Highlight cell A
    if (cellA !== null && cellA >= 0 && cellA < 27) {
      this.cellMeshes[cellA].material.color.setHex(this.HIGHLIGHT_A);
      this.cellMeshes[cellA]._highlighted = true;
    }

    // Highlight cell B
    if (cellB !== null && cellB >= 0 && cellB < 27) {
      this.cellMeshes[cellB].material.color.setHex(this.HIGHLIGHT_B);
      this.cellMeshes[cellB]._highlighted = true;
    }

    // Draw collision line between A and B
    if (cellA !== null && cellB !== null) {
      const lineMat = new THREE.LineBasicMaterial({
        color: this.COLLISION_COLOR,
        transparent: true,
        opacity: 0.8,
        linewidth: 2
      });
      const geo = new THREE.BufferGeometry().setFromPoints([
        this.cellPositions[cellA],
        this.cellPositions[cellB]
      ]);
      this.collisionLine = new THREE.Line(geo, lineMat);
      this.cubeGroup.add(this.collisionLine);
    }
  }

  destroy() {
    window.removeEventListener('resize', this._resizeHandler);
    this.renderer.dispose();
  }
}

// Export for module usage or global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CubeVisual;
}
