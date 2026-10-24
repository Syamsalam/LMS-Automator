/**
 * LMS Auto-Pilot - Background Service Worker (Manifest V3)
 */

importScripts('../utils/storage.js', './ai-client.js');

chrome.runtime.onInstalled.addListener(async () => {
  const config = await self.LMSStorage.getConfig();
  await self.LMSStorage.saveConfig(config);
  const state = await self.LMSStorage.getState();
  await self.LMSStorage.updateState({
    ...state,
    isRunning: false,
    currentPhase: 'IDLE',
    statusText: 'Ekstensi siap digunakan'
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((error) => {
      console.error('[LMS-ServiceWorker Error]', error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true; // Keep message channel open for async response
});

async function handleMessage(message) {
  const { type, payload } = message || {};

  switch (type) {
    case 'ANALYZE_PAGE_TASKS': {
      const config = await self.LMSStorage.getConfig();
      const solution = await self.LMSAIClient.solvePageTasks(payload, config);
      return solution;
    }

    case 'TEST_API_KEY': {
      const currentConfig = await self.LMSStorage.getConfig();
      const testConfig = { ...currentConfig, ...(payload || {}) };
      return await self.LMSAIClient.testConnection(testConfig);
    }

    case 'GET_CONFIG': {
      return await self.LMSStorage.getConfig();
    }

    case 'SAVE_CONFIG': {
      return await self.LMSStorage.saveConfig(payload || {});
    }

    case 'GET_STATE': {
      return await self.LMSStorage.getState();
    }

    case 'UPDATE_STATE': {
      return await self.LMSStorage.updateState(payload || {});
    }

    case 'ADD_LOG': {
      return await self.LMSStorage.addLog(
        payload?.message || '',
        payload?.level || 'info'
      );
    }

    case 'OPEN_NEW_TAB': {
      if (payload?.url && chrome.tabs && chrome.tabs.create) {
        const tab = await chrome.tabs.create({ url: payload.url, active: true });
        return { tabId: tab?.id || null };
      }
      return { tabId: null };
    }

    case 'EXECUTE_AWS_LAB_PLAN': {
      const config = await self.LMSStorage.getConfig();
      return await self.LMSAIClient.executeAWSLabPlan(payload || {}, config);
    }

    default:
      throw new Error(`Tipe pesan tidak dikenali: ${type}`);
  }
}
