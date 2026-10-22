/**
 * LMS Auto-Pilot - Floating On-Page Control Panel (Shadow DOM HUD)
 * Menggunakan Shadow DOM agar tampilan panel tidak terpengaruh oleh CSS halaman LMS.
 */

const LMSHud = {
  hostEl: null,
  shadowRoot: null,
  isMinimized: false,
  lastScanSummary: {
    simulationCount: 0,
    mcqCount: 0,
    essayCount: 0,
    hasSubmit: false,
    hasNext: false
  },

  init(callbacks = {}) {
    if (document.getElementById('lms-autopilot-hud-host')) return;

    this.callbacks = callbacks;
    this.hostEl = document.createElement('div');
    this.hostEl.id = 'lms-autopilot-hud-host';
    this.hostEl.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; bottom: 20px; right: 20px; font-family: system-ui, -apple-system, sans-serif;';
    document.documentElement.appendChild(this.hostEl);

    this.shadowRoot = this.hostEl.attachShadow({ mode: 'open' });
    this.render();
    this.bindEvents();
  },

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #f8fafc;
        }
        * {
          box-sizing: border-box;
        }
        .hud-card {
          width: 340px;
          background: rgba(15, 23, 42, 0.96);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(148, 163, 184, 0.22);
          border-radius: 14px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(59, 130, 246, 0.15);
          overflow: hidden;
          transition: all 0.25s ease;
        }
        .hud-card.minimized {
          width: 230px;
        }
        .hud-card.minimized .hud-body {
          display: none;
        }
        .hud-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 11px 14px;
          background: linear-gradient(135deg, rgba(30, 41, 59, 0.95), rgba(15, 23, 42, 0.95));
          border-bottom: 1px solid rgba(148, 163, 184, 0.15);
          cursor: move;
          user-select: none;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 700;
          font-size: 13px;
          letter-spacing: 0.2px;
          color: #f8fafc;
        }
        .pulse-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #64748b;
          box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6);
        }
        .pulse-dot.running {
          background: #10b981;
          animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
          70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
          100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
        }
        .header-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .icon-btn {
          background: rgba(255, 255, 255, 0.07);
          border: 1px solid rgba(255, 255, 255, 0.1);
          color: #cbd5e1;
          border-radius: 6px;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          font-size: 12px;
          transition: background 0.15s;
        }
        .icon-btn:hover {
          background: rgba(255, 255, 255, 0.16);
          color: #fff;
        }
        .hud-body {
          padding: 12px 14px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .status-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(30, 41, 59, 0.75);
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid rgba(148, 163, 184, 0.14);
        }
        .phase-badge {
          font-size: 10.5px;
          font-weight: 700;
          text-transform: uppercase;
          padding: 3px 7px;
          border-radius: 5px;
          background: rgba(59, 130, 246, 0.2);
          color: #60a5fa;
          letter-spacing: 0.4px;
        }
        .phase-badge.running {
          background: rgba(16, 185, 129, 0.2);
          color: #34d399;
        }
        .phase-badge.error {
          background: rgba(239, 68, 68, 0.2);
          color: #f87171;
        }
        .status-text {
          font-size: 11.5px;
          color: #cbd5e1;
          max-width: 195px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .detected-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
        }
        .stat-pill {
          background: rgba(30, 41, 59, 0.65);
          border: 1px solid rgba(148, 163, 184, 0.12);
          border-radius: 8px;
          padding: 6px 4px;
          text-align: center;
        }
        .stat-val {
          font-size: 14px;
          font-weight: 700;
          color: #f8fafc;
        }
        .stat-lbl {
          font-size: 9.5px;
          color: #94a3b8;
          margin-top: 2px;
        }
        .btn-group {
          display: flex;
          gap: 7px;
        }
        .btn {
          flex: 1;
          border: none;
          border-radius: 8px;
          padding: 9px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          transition: all 0.18s ease;
        }
        .btn-primary {
          background: linear-gradient(135deg, #10b981, #059669);
          color: #ffffff;
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }
        .btn-primary:hover {
          filter: brightness(1.08);
        }
        .btn-stop {
          background: linear-gradient(135deg, #ef4444, #dc2626);
          color: #ffffff;
          box-shadow: 0 4px 12px rgba(239, 68, 68, 0.3);
        }
        .btn-secondary {
          background: rgba(59, 130, 246, 0.18);
          color: #93c5fd;
          border: 1px solid rgba(59, 130, 246, 0.35);
        }
        .btn-secondary:hover {
          background: rgba(59, 130, 246, 0.28);
        }
        .log-box {
          background: rgba(2, 6, 23, 0.65);
          border: 1px solid rgba(148, 163, 184, 0.14);
          border-radius: 8px;
          height: 105px;
          overflow-y: auto;
          padding: 7px 9px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size: 10.5px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .log-item {
          line-height: 1.35;
          color: #cbd5e1;
          word-break: break-word;
        }
        .log-item .time {
          color: #64748b;
          margin-right: 5px;
        }
        .log-item.action { color: #38bdf8; }
        .log-item.success { color: #34d399; }
        .log-item.warn { color: #fbbf24; }
        .log-item.error { color: #f87171; }
        .footer-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 10.5px;
          color: #94a3b8;
          padding-top: 2px;
        }
        .toggle-label {
          display: flex;
          align-items: center;
          gap: 5px;
          cursor: pointer;
          user-select: none;
        }
        .toggle-label input {
          accent-color: #10b981;
          cursor: pointer;
        }
      </style>

      <div class="hud-card" id="hud-card">
        <div class="hud-header" id="hud-drag-handle">
          <div class="brand">
            <span class="pulse-dot" id="pulse-dot"></span>
            <span>LMS Auto-Pilot AI</span>
          </div>
          <div class="header-actions">
            <button class="icon-btn" id="btn-rescan" title="Pindai Ulang Halaman">↻</button>
            <button class="icon-btn" id="btn-minimize" title="Minimize / Expand">−</button>
          </div>
        </div>

        <div class="hud-body">
          <div class="status-bar">
            <span class="phase-badge" id="phase-badge">IDLE</span>
            <span class="status-text" id="status-text">Siap menjalankan modul</span>
          </div>

          <div class="detected-grid" title="Jumlah tugas yang terdeteksi pada halaman ini">
            <div class="stat-pill">
              <div class="stat-val" id="count-sim">0</div>
              <div class="stat-lbl">Simulasi</div>
            </div>
            <div class="stat-pill">
              <div class="stat-val" id="count-mcq">0</div>
              <div class="stat-lbl">Pil. Ganda</div>
            </div>
            <div class="stat-pill">
              <div class="stat-val" id="count-essay">0</div>
              <div class="stat-lbl">Esai</div>
            </div>
            <div class="stat-pill">
              <div class="stat-val" id="count-next">-</div>
              <div class="stat-lbl">Nav Lanjut</div>
            </div>
          </div>

          <div class="btn-group">
            <button class="btn btn-primary" id="btn-toggle-autopilot">
              ▶ Start Auto-Pilot
            </button>
            <button class="btn btn-secondary" id="btn-solve-once" title="Selesaikan halaman ini saja tanpa pindah modul otomatis">
              ⚡ 1 Halaman
            </button>
          </div>

          <div class="log-box" id="log-box">
            <div class="log-item"><span class="time">--:--</span>Menunggu perintah...</div>
          </div>

          <div class="footer-row">
            <label class="toggle-label">
              <input type="checkbox" id="chk-auto-next" checked />
              <span>Auto-Next Modul</span>
            </label>
            <span id="solved-counter">Selesai: 0 modul</span>
          </div>
        </div>
      </div>
    `;
  },

  bindEvents() {
    const s = this.shadowRoot;
    const btnToggle = s.getElementById('btn-toggle-autopilot');
    const btnSolveOnce = s.getElementById('btn-solve-once');
    const btnRescan = s.getElementById('btn-rescan');
    const btnMin = s.getElementById('btn-minimize');
    const chkAutoNext = s.getElementById('chk-auto-next');
    const card = s.getElementById('hud-card');

    btnToggle.addEventListener('click', () => {
      if (this.callbacks.onToggleAutoPilot) {
        this.callbacks.onToggleAutoPilot();
      }
    });

    btnSolveOnce.addEventListener('click', () => {
      if (this.callbacks.onSolveSinglePage) {
        this.callbacks.onSolveSinglePage();
      }
    });

    btnRescan.addEventListener('click', () => {
      if (this.callbacks.onRescan) {
        this.callbacks.onRescan();
      }
    });

    btnMin.addEventListener('click', () => {
      this.isMinimized = !this.isMinimized;
      card.classList.toggle('minimized', this.isMinimized);
      btnMin.textContent = this.isMinimized ? '+' : '−';
    });

    chkAutoNext.addEventListener('change', (e) => {
      if (this.callbacks.onToggleAutoNext) {
        this.callbacks.onToggleAutoNext(e.target.checked);
      }
    });

    // Fitur geser (Drag & Drop) posisi HUD di layar
    const handle = s.getElementById('hud-drag-handle');
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialRight = 20;
    let initialBottom = 20;

    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      initialRight = parseInt(this.hostEl.style.right || '20', 10);
      initialBottom = parseInt(this.hostEl.style.bottom || '20', 10);
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = startX - e.clientX;
      const dy = startY - e.clientY;
      this.hostEl.style.right = `${Math.max(10, initialRight + dx)}px`;
      this.hostEl.style.bottom = `${Math.max(10, initialBottom + dy)}px`;
    });

    window.addEventListener('mouseup', () => {
      isDragging = false;
    });
  },

  updateScanSummary(summary) {
    if (!this.shadowRoot || !summary) return;
    this.lastScanSummary = summary;
    const s = this.shadowRoot;
    s.getElementById('count-sim').textContent = String(summary.simulationCount || 0);
    s.getElementById('count-mcq').textContent = String(summary.mcqCount || 0);
    s.getElementById('count-essay').textContent = String(summary.essayCount || 0);
    s.getElementById('count-next').textContent = summary.hasNext || summary.hasSubmit ? 'Ada' : '-';
  },

  updateState(state, config) {
    if (!this.shadowRoot || !state) return;
    const s = this.shadowRoot;

    if (config && typeof config.showFloatingHud === 'boolean') {
      this.hostEl.style.display = config.showFloatingHud ? 'block' : 'none';
    }
    if (config && typeof config.autoNextModule === 'boolean') {
      s.getElementById('chk-auto-next').checked = config.autoNextModule;
    }

    const dot = s.getElementById('pulse-dot');
    const badge = s.getElementById('phase-badge');
    const statusText = s.getElementById('status-text');
    const btnToggle = s.getElementById('btn-toggle-autopilot');
    const solvedCounter = s.getElementById('solved-counter');
    const logBox = s.getElementById('log-box');

    const isRunning = Boolean(state.isRunning);
    dot.classList.toggle('running', isRunning);

    badge.textContent = state.currentPhase || (isRunning ? 'RUNNING' : 'IDLE');
    badge.className = 'phase-badge' + (isRunning ? ' running' : '') + (state.currentPhase === 'ERROR' ? ' error' : '');
    statusText.textContent = state.statusText || (isRunning ? 'Memproses...' : 'Siap');

    if (isRunning) {
      btnToggle.className = 'btn btn-stop';
      btnToggle.innerHTML = '⏹ Stop Auto-Pilot';
    } else {
      btnToggle.className = 'btn btn-primary';
      btnToggle.innerHTML = '▶ Start Auto-Pilot';
    }

    const pagesDone = state.stats?.pagesCompleted || 0;
    solvedCounter.textContent = `Selesai: ${pagesDone} modul`;

    const logs = state.logs || [];
    if (logs.length > 0) {
      logBox.innerHTML = logs
        .slice(0, 25)
        .map(
          (l) =>
            `<div class="log-item ${l.level || 'info'}"><span class="time">${l.time || ''}</span>${this.escapeHtml(l.message)}</div>`
        )
        .join('');
    }
  },

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSHud = LMSHud;
}
