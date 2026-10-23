/**
 * LMS Auto-Pilot - Popup Controller
 */

const DEFAULT_MODELS = {
  local: 'smart-contextual-v2',
  pollinations: 'openai',
  ollama: 'qwen2.5-coder:7b',
  gemini: 'gemini-2.5-flash',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free',
  openai: 'gpt-4o-mini',
  custom: 'gpt-4o-mini'
};

function updateProviderUI(prov) {
  const customGroup = document.getElementById('custom-endpoint-group');
  const modelGroup = document.getElementById('model-group');
  const apiKeyGroup = document.getElementById('api-key-group');
  const customEndpointEl = document.getElementById('custom-endpoint');

  if (customGroup) {
    customGroup.style.display = prov === 'custom' || prov === 'ollama' ? 'flex' : 'none';
  }
  if (prov === 'ollama' && customEndpointEl && !customEndpointEl.value) {
    customEndpointEl.value = 'http://localhost:11434/v1/chat/completions';
  }
  if (modelGroup) {
    modelGroup.style.display = prov === 'local' ? 'none' : 'flex';
  }
  if (apiKeyGroup) {
    apiKeyGroup.style.display = prov === 'local' || prov === 'pollinations' || prov === 'ollama' ? 'none' : 'flex';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const config = await window.LMSStorage.getConfig();
  const state = await window.LMSStorage.getState();

  populateForm(config);
  renderState(state);

  // Tab Switching
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  // Provider change updates default model suggestion
  const providerEl = document.getElementById('ai-provider');
  const modelEl = document.getElementById('ai-model');

  providerEl.addEventListener('change', () => {
    const prov = providerEl.value;
    modelEl.value = DEFAULT_MODELS[prov] || 'gemini-2.5-flash';
    updateProviderUI(prov);
  });

  // Show/hide API key
  const apiKeyEl = document.getElementById('api-key');
  document.getElementById('btn-toggle-key').addEventListener('click', () => {
    apiKeyEl.type = apiKeyEl.type === 'password' ? 'text' : 'password';
  });

  // Test AI Connection
  const feedbackEl = document.getElementById('api-test-feedback');
  document.getElementById('btn-test-api').addEventListener('click', async () => {
    const draft = readFormConfig();
    await window.LMSStorage.saveConfig(draft);

    if (draft.aiProvider === 'local' || (!draft.apiKey && !['pollinations', 'ollama', 'custom'].includes(draft.aiProvider))) {
      feedbackEl.className = 'feedback-msg';
      feedbackEl.textContent = '✓ Mode Smart Contextual Heuristic aktif (100% Gratis & Tanpa API Key).';
      return;
    }

    feedbackEl.className = 'feedback-msg';
    feedbackEl.textContent = 'Menguji koneksi ke ' + draft.aiProvider.toUpperCase() + '...';

    chrome.runtime.sendMessage({ type: 'TEST_API_KEY', payload: draft }, (res) => {
      if (res && res.ok) {
        feedbackEl.className = 'feedback-msg';
        feedbackEl.textContent = `✓ Berhasil terhubung ke ${draft.aiProvider} (${draft.model})!`;
      } else {
        feedbackEl.className = 'feedback-msg error';
        feedbackEl.textContent = `✗ Gagal: ${res?.error || 'Periksa kembali koneksi / API Key Anda'}`;
      }
    });
  });

  // Save Configuration
  document.getElementById('btn-save-config').addEventListener('click', async () => {
    const updated = readFormConfig();
    await window.LMSStorage.saveConfig(updated);
    const saveBtn = document.getElementById('btn-save-config');
    const prevText = saveBtn.textContent;
    saveBtn.textContent = '✓ Tersimpan!';
    setTimeout(() => {
      saveBtn.textContent = prevText;
    }, 1200);
  });

  // Reset Stats
  document.getElementById('btn-reset-stats').addEventListener('click', async () => {
    const updatedState = await window.LMSStorage.resetStats();
    renderState(updatedState);
  });

  // Start / Stop Auto-Pilot from Popup
  document.getElementById('btn-popup-autopilot').addEventListener('click', async () => {
    await window.LMSStorage.saveConfig(readFormConfig());
    const currentState = await window.LMSStorage.getState();
    const command = currentState.isRunning ? 'STOP_AUTOPILOT' : 'START_AUTOPILOT';
    sendToActiveTab({ type: command });
  });

  // Solve Single Page from Popup
  document.getElementById('btn-popup-single').addEventListener('click', async () => {
    await window.LMSStorage.saveConfig(readFormConfig());
    sendToActiveTab({ type: 'SOLVE_SINGLE_PAGE' });
  });

  // Listen to storage state updates
  window.LMSStorage.onChanged(({ state: newState }) => {
    if (newState) renderState(newState);
  });
});

function sendToActiveTab(message) {
  if (typeof chrome === 'undefined' || !chrome.tabs) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs && tabs[0]?.id) {
      chrome.tabs.sendMessage(tabs[0].id, message, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function populateForm(config) {
  const prov = config.aiProvider || 'gemini';
  document.getElementById('ai-provider').value = prov;
  document.getElementById('ai-model').value = config.model || DEFAULT_MODELS[prov] || 'gemini-2.5-flash';
  document.getElementById('custom-endpoint').value = config.customEndpoint || '';
  document.getElementById('api-key').value = config.apiKey || '';
  document.getElementById('use-smart-fallback').checked = config.useSmartFallback !== false;
  updateProviderUI(prov);

  document.getElementById('action-delay').value = config.actionDelay ?? 650;
  document.getElementById('program-wait').value = config.programWaitTime ?? 1800;
  document.getElementById('essay-language').value = config.essayLanguage || 'id';
  document.getElementById('essay-length').value = config.essayLength || 'medium';

  document.getElementById('auto-submit').checked = config.autoSubmit !== false;
  document.getElementById('auto-next-module').checked = config.autoNextModule !== false;
  document.getElementById('simulate-typing').checked = config.simulateTyping !== false;
  document.getElementById('show-floating-hud').checked = config.showFloatingHud !== false;

  const cs = config.customSelectors || {};
  document.getElementById('sel-sim-buttons').value = cs.simulationButtons || '';
  document.getElementById('sel-run-button').value = cs.runProgramButton || '';
  document.getElementById('sel-mcq').value = cs.mcqContainer || '';
  document.getElementById('sel-essay').value = cs.essayInput || '';
  document.getElementById('sel-submit').value = cs.submitButton || '';
  document.getElementById('sel-next').value = cs.nextButton || '';
}

function readFormConfig() {
  return {
    aiProvider: document.getElementById('ai-provider').value,
    model: document.getElementById('ai-model').value.trim() || 'gemini-2.5-flash',
    customEndpoint: document.getElementById('custom-endpoint').value.trim(),
    apiKey: document.getElementById('api-key').value.trim(),
    useSmartFallback: document.getElementById('use-smart-fallback').checked,
    actionDelay: Number(document.getElementById('action-delay').value) || 650,
    programWaitTime: Number(document.getElementById('program-wait').value) || 1800,
    essayLanguage: document.getElementById('essay-language').value,
    essayLength: document.getElementById('essay-length').value,
    autoSubmit: document.getElementById('auto-submit').checked,
    autoNextModule: document.getElementById('auto-next-module').checked,
    simulateTyping: document.getElementById('simulate-typing').checked,
    showFloatingHud: document.getElementById('show-floating-hud').checked,
    customSelectors: {
      simulationButtons: document.getElementById('sel-sim-buttons').value.trim(),
      runProgramButton: document.getElementById('sel-run-button').value.trim(),
      mcqContainer: document.getElementById('sel-mcq').value.trim(),
      essayInput: document.getElementById('sel-essay').value.trim(),
      submitButton: document.getElementById('sel-submit').value.trim(),
      nextButton: document.getElementById('sel-next').value.trim()
    }
  };
}

function renderState(state) {
  if (!state) return;
  const pill = document.getElementById('popup-status-pill');
  const btnAuto = document.getElementById('btn-popup-autopilot');

  pill.textContent = state.currentPhase || (state.isRunning ? 'RUNNING' : 'IDLE');
  pill.classList.toggle('running', Boolean(state.isRunning));

  if (state.isRunning) {
    btnAuto.className = 'btn btn-start stop-mode';
    btnAuto.textContent = '⏹ Hentikan Auto-Pilot';
  } else {
    btnAuto.className = 'btn btn-start';
    btnAuto.textContent = '▶ Jalankan Full Auto-Pilot';
  }

  const stats = state.stats || {};
  document.getElementById('stat-pages').textContent = String(stats.pagesCompleted || 0);
  document.getElementById('stat-sims').textContent = String(stats.simulationsRun || 0);
  document.getElementById('stat-mcqs').textContent = String(stats.mcqAnswered || 0);
  document.getElementById('stat-essays').textContent = String(stats.essaysFilled || 0);
}
