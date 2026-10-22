/**
 * LMS Auto-Pilot - Storage & State Management Utility
 * Dapat digunakan baik di Content Script (window.LMSStorage) maupun di Background / Popup.
 */

const DEFAULT_CONFIG = {
  aiProvider: 'gemini', // 'gemini' | 'openai' | 'groq' | 'custom'
  apiKey: '',
  model: 'gemini-2.5-flash',
  customEndpoint: 'https://api.openai.com/v1/chat/completions',
  useSmartFallback: true, // Gunakan analisis heuristik cerdas jika API key belum diisi / gagal

  // Pengaturan Eksekusi & Auto-Pilot
  actionDelay: 650, // Jeda antar klik tombol (ms)
  programWaitTime: 1800, // Waktu tunggu eksekusi program selesai (ms)
  pageLoadDelay: 1500, // Jeda saat halaman modul baru dimuat (ms)
  autoSubmit: true, // Otomatis klik tombol Submit / Cek Jawaban
  autoNextModule: true, // Otomatis pindah ke modul / halaman berikutnya
  simulateTyping: true, // Efek mengetik natural pada soal esai
  essayLanguage: 'id', // 'id' (Bahasa Indonesia) | 'en' (English) | 'auto'
  essayLength: 'medium', // 'short' | 'medium' | 'detailed'
  showFloatingHud: true,

  // Kustomisasi Selector CSS (Opsional untuk LMS khusus)
  customSelectors: {
    simulationButtons: '',
    runProgramButton: '',
    mcqContainer: '',
    essayInput: '',
    submitButton: '',
    nextButton: ''
  }
};

const DEFAULT_STATE = {
  isRunning: false,
  mode: 'autopilot', // 'autopilot' | 'single-page'
  currentPhase: 'IDLE', // 'IDLE' | 'SCANNING' | 'AI_THINKING' | 'SIMULATION' | 'MCQ' | 'ESSAY' | 'SUBMITTING' | 'NAVIGATING' | 'COMPLETED' | 'ERROR'
  statusText: 'Siap dijalankan',
  stats: {
    pagesCompleted: 0,
    simulationsRun: 0,
    mcqAnswered: 0,
    essaysFilled: 0
  },
  logs: []
};

function hasChromeStorage() {
  return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

const LMSStorage = {
  DEFAULT_CONFIG,
  DEFAULT_STATE,

  async getConfig() {
    if (!hasChromeStorage()) {
      try {
        const raw = localStorage.getItem('lms_autopilot_config');
        return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
      } catch {
        return { ...DEFAULT_CONFIG };
      }
    }
    return new Promise((resolve) => {
      chrome.storage.local.get(['lmsConfig'], (res) => {
        const merged = {
          ...DEFAULT_CONFIG,
          ...(res.lmsConfig || {}),
          customSelectors: {
            ...DEFAULT_CONFIG.customSelectors,
            ...((res.lmsConfig && res.lmsConfig.customSelectors) || {})
          }
        };
        resolve(merged);
      });
    });
  },

  async saveConfig(partialConfig) {
    const current = await this.getConfig();
    const updated = {
      ...current,
      ...partialConfig,
      customSelectors: {
        ...current.customSelectors,
        ...(partialConfig.customSelectors || {})
      }
    };
    if (!hasChromeStorage()) {
      localStorage.setItem('lms_autopilot_config', JSON.stringify(updated));
      return updated;
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ lmsConfig: updated }, () => resolve(updated));
    });
  },

  async getState() {
    if (!hasChromeStorage()) {
      try {
        const raw = localStorage.getItem('lms_autopilot_state');
        return raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : { ...DEFAULT_STATE };
      } catch {
        return { ...DEFAULT_STATE };
      }
    }
    return new Promise((resolve) => {
      chrome.storage.local.get(['lmsState'], (res) => {
        const merged = {
          ...DEFAULT_STATE,
          ...(res.lmsState || {}),
          stats: {
            ...DEFAULT_STATE.stats,
            ...((res.lmsState && res.lmsState.stats) || {})
          },
          logs: (res.lmsState && Array.isArray(res.lmsState.logs)) ? res.lmsState.logs : []
        };
        resolve(merged);
      });
    });
  },

  async updateState(partialState) {
    const current = await this.getState();
    const updated = {
      ...current,
      ...partialState,
      stats: {
        ...current.stats,
        ...(partialState.stats || {})
      }
    };
    if (!hasChromeStorage()) {
      localStorage.setItem('lms_autopilot_state', JSON.stringify(updated));
      window.dispatchEvent(new CustomEvent('lms-state-updated', { detail: updated }));
      return updated;
    }
    return new Promise((resolve) => {
      chrome.storage.local.set({ lmsState: updated }, () => resolve(updated));
    });
  },

  async addLog(message, level = 'info') {
    const state = await this.getState();
    const entry = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      time: new Date().toLocaleTimeString('id-ID', { hour12: false }),
      message,
      level // 'info' | 'success' | 'warn' | 'error' | 'action'
    };
    const logs = [entry, ...(state.logs || [])].slice(0, 60);
    return this.updateState({ logs, statusText: message });
  },

  async clearLogs() {
    return this.updateState({ logs: [] });
  },

  async resetStats() {
    return this.updateState({
      stats: { ...DEFAULT_STATE.stats }
    });
  },

  onChanged(callback) {
    if (hasChromeStorage() && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          callback({
            config: changes.lmsConfig ? changes.lmsConfig.newValue : null,
            state: changes.lmsState ? changes.lmsState.newValue : null
          });
        }
      });
    } else if (typeof window !== 'undefined') {
      window.addEventListener('lms-state-updated', (e) => {
        callback({ state: e.detail, config: null });
      });
    }
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSStorage = LMSStorage;
}

