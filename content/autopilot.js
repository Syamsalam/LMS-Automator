/**
 * LMS Auto-Pilot - Full Auto-Pilot Orchestrator
 * Mengatur siklus otomatis:
 * Scan Halaman -> Analisis AI -> Tekan Urutan Tombol & Jalankan Program ->
 * Jawab Pilihan Ganda -> Isi Esai -> Klik Submit -> Pindah ke Modul Selanjutnya (Next).
 */

const LMSAutoPilot = {
  isExecutingCycle: false,
  abortRequested: false,
  lastProcessedSignature: '',

  async init() {
    const config = await window.LMSStorage.getConfig();
    const state = await window.LMSStorage.getState();

    // Inisialisasi Floating HUD di halaman
    window.LMSHud.init({
      onToggleAutoPilot: () => this.toggleAutoPilot(),
      onSolveSinglePage: () => this.runSinglePage(),
      onRescan: () => this.performScanOnly(),
      onToggleAutoNext: async (checked) => {
        await window.LMSStorage.saveConfig({ autoNextModule: checked });
      }
    });

    // Lakukan pemindaian awal untuk menampilkan jumlah tugas di HUD
    this.performScanOnly();
    window.LMSHud.updateState(state, config);

    // Dengarkan perubahan state/config dari Popup atau Background
    window.LMSStorage.onChanged(async ({ state: newState, config: newConfig }) => {
      const latestConfig = newConfig || (await window.LMSStorage.getConfig());
      const latestState = newState || (await window.LMSStorage.getState());
      window.LMSHud.updateState(latestState, latestConfig);

      if (latestState.isRunning && !this.isExecutingCycle) {
        this.abortRequested = false;
        this.runCycle();
      } else if (!latestState.isRunning && this.isExecutingCycle) {
        this.abortRequested = true;
      }
    });

    // Dengarkan perintah langsung dari Popup ekstensi
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (msg?.type === 'START_AUTOPILOT') {
          this.startAutoPilot('autopilot');
          sendResponse({ ok: true });
        } else if (msg?.type === 'STOP_AUTOPILOT') {
          this.stopAutoPilot('Dihentikan oleh pengguna');
          sendResponse({ ok: true });
        } else if (msg?.type === 'SOLVE_SINGLE_PAGE') {
          this.runSinglePage();
          sendResponse({ ok: true });
        } else if (msg?.type === 'RESCAN_PAGE') {
          const scan = this.performScanOnly();
          sendResponse({ ok: true, summary: scan.summary });
        }
        return true;
      });
    }

    // Jika halaman baru saja dimuat dan Auto-Pilot sedang aktif, lanjutkan otomatis!
    if (state.isRunning && state.mode === 'autopilot') {
      const waitMs = Number(config.pageLoadDelay) || 1200;
      await window.LMSExecutor.sleep(waitMs);
      const refreshedState = await window.LMSStorage.getState();
      if (refreshedState.isRunning) {
        this.runCycle();
      }
    }
  },

  performScanOnly() {
    const scan = window.LMSScanner.scanPage({});
    window.LMSHud.updateScanSummary(scan.summary);
    return scan;
  },

  async toggleAutoPilot() {
    const state = await window.LMSStorage.getState();
    if (state.isRunning) {
      await this.stopAutoPilot('Auto-Pilot dihentikan.');
    } else {
      await this.startAutoPilot('autopilot');
    }
  },

  async startAutoPilot(mode = 'autopilot') {
    this.abortRequested = false;
    await window.LMSStorage.updateState({
      isRunning: true,
      mode,
      currentPhase: 'SCANNING',
      statusText: 'Memulai Auto-Pilot...'
    });
    await window.LMSStorage.addLog(
      mode === 'autopilot'
        ? 'Mode Full Auto-Pilot diaktifkan.'
        : 'Menjalankan penyelesaian 1 halaman.',
      'info'
    );
    if (!this.isExecutingCycle) {
      this.runCycle();
    }
  },

  async runSinglePage() {
    await this.startAutoPilot('single-page');
  },

  async stopAutoPilot(reason = 'Dihentikan') {
    this.abortRequested = true;
    this.isExecutingCycle = false;
    await window.LMSStorage.updateState({
      isRunning: false,
      currentPhase: 'IDLE',
      statusText: reason
    });
    await window.LMSStorage.addLog(reason, 'warn');
  },

  async checkShouldAbort() {
    if (this.abortRequested) return true;
    const state = await window.LMSStorage.getState();
    return !state.isRunning;
  },

  /**
   * Kirim data halaman ke Service Worker AI (atau gunakan fallback lokal jika di luar ekstensi)
   */
  async requestAISolution(pageData, config) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'ANALYZE_PAGE_TASKS', payload: pageData },
          (response) => {
            if (chrome.runtime.lastError) {
              // Jika service worker tidak merespons, gunakan LMSAIClient jika tersedia
              if (window.LMSAIClient) {
                window.LMSAIClient.solvePageTasks(pageData, config).then(resolve).catch(reject);
              } else {
                reject(new Error(chrome.runtime.lastError.message));
              }
              return;
            }
            if (response && response.ok) {
              resolve(response.data);
            } else {
              reject(new Error(response?.error || 'Gagal mendapatkan solusi AI'));
            }
          }
        );
      });
    }

    if (window.LMSAIClient) {
      return await window.LMSAIClient.solvePageTasks(pageData, config);
    }

    throw new Error('Mesin AI tidak ditemukan.');
  },

  /**
   * Siklus Utama Penyelesaian Halaman Modul
   */
  async runCycle() {
    if (this.isExecutingCycle) return;
    this.isExecutingCycle = true;

    try {
      const config = await window.LMSStorage.getConfig();
      const state = await window.LMSStorage.getState();

      // 1. Pindai halaman aktif
      await window.LMSStorage.updateState({
        currentPhase: 'SCANNING',
        statusText: 'Memindai tugas pada halaman...'
      });

      const pageData = window.LMSScanner.scanPage(config);
      window.LMSHud.updateScanSummary(pageData.summary);

      const totalTasks =
        pageData.summary.simulationCount +
        pageData.summary.mcqCount +
        pageData.summary.essayCount;

      await window.LMSStorage.addLog(
        `Terdeteksi: ${pageData.summary.simulationCount} Simulasi, ${pageData.summary.mcqCount} PG, ${pageData.summary.essayCount} Esai.`,
        'info'
      );

      if (await this.checkShouldAbort()) return;

      let stats = { ...(state.stats || window.LMSStorage.DEFAULT_STATE.stats) };

      // 2. Jika ada tugas (Simulasi / PG / Esai), minta solusi ke AI
      if (totalTasks > 0) {
        await window.LMSStorage.updateState({
          currentPhase: 'AI_THINKING',
          statusText: 'Menganalisis jawaban dengan AI...'
        });

        const solution = await this.requestAISolution(pageData, config);
        if (solution.source) {
          await window.LMSStorage.addLog(`Solver: ${solution.source}`, 'info');
        }

        if (await this.checkShouldAbort()) return;

        // 3A. Eksekusi Tugas Simulasi Tombol & Jalankan Program
        if (pageData.simulations.length > 0) {
          await window.LMSStorage.updateState({
            currentPhase: 'SIMULATION',
            statusText: 'Menjalankan simulasi & program...'
          });

          for (const simScan of pageData.simulations) {
            if (await this.checkShouldAbort()) return;
            const simSol =
              (solution.simulations || []).find((s) => s.taskId === simScan.taskId) ||
              (solution.simulations || [])[0];

            await window.LMSExecutor.executeSimulation(
              simScan,
              simSol,
              config,
              (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
            );
            stats.simulationsRun = (stats.simulationsRun || 0) + 1;
            await window.LMSStorage.updateState({ stats });
          }
        }

        // 3B. Eksekusi Soal Pilihan Ganda (MCQ)
        if (pageData.mcqs.length > 0) {
          await window.LMSStorage.updateState({
            currentPhase: 'MCQ',
            statusText: `Menjawab ${pageData.mcqs.length} soal pilihan ganda...`
          });

          for (let i = 0; i < pageData.mcqs.length; i++) {
            if (await this.checkShouldAbort()) return;
            const mcqScan = pageData.mcqs[i];
            const mcqSol =
              (solution.mcqs || []).find((m) => m.questionId === mcqScan.questionId) ||
              (solution.mcqs || [])[i];

            const answered = await window.LMSExecutor.executeMCQ(
              mcqScan,
              mcqSol,
              config,
              (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
            );
            if (answered) {
              stats.mcqAnswered = (stats.mcqAnswered || 0) + 1;
              await window.LMSStorage.updateState({ stats });
            }
          }
        }

        // 3C. Eksekusi Soal Esai / Isian
        if (pageData.essays.length > 0) {
          await window.LMSStorage.updateState({
            currentPhase: 'ESSAY',
            statusText: `Mengisi ${pageData.essays.length} soal esai...`
          });

          for (let i = 0; i < pageData.essays.length; i++) {
            if (await this.checkShouldAbort()) return;
            const essayScan = pageData.essays[i];
            const essaySol =
              (solution.essays || []).find((e) => e.essayId === essayScan.essayId) ||
              (solution.essays || [])[i];

            const filled = await window.LMSExecutor.executeEssay(
              essayScan,
              essaySol,
              config,
              (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
            );
            if (filled) {
              stats.essaysFilled = (stats.essaysFilled || 0) + 1;
              await window.LMSStorage.updateState({ stats });
            }
          }
        }
      }

      if (await this.checkShouldAbort()) return;

      // 4. Klik Tombol Submit / Periksa Jawaban jika tersedia
      const freshNav = window.LMSScanner.scanNavigation(
        config.customSelectors || {},
        pageData.simulations
      );

      if (config.autoSubmit !== false && freshNav.submitButtonId) {
        const submitEl = window.LMSScanner.getElementById(freshNav.submitButtonId);
        if (submitEl && !submitEl.disabled) {
          await window.LMSStorage.updateState({
            currentPhase: 'SUBMITTING',
            statusText: `Mengirim jawaban (${freshNav.submitButtonLabel})...`
          });
          await window.LMSStorage.addLog(
            `Menekan tombol Submit: "${freshNav.submitButtonLabel}"`,
            'action'
          );
          await window.LMSExecutor.clickElement(submitEl, '#10b981');
          await window.LMSExecutor.sleep(Number(config.actionDelay) + 500);
        }
      }

      stats.pagesCompleted = (stats.pagesCompleted || 0) + 1;
      await window.LMSStorage.updateState({ stats });

      // Jika mode hanya 1 halaman, selesai di sini
      const latestState = await window.LMSStorage.getState();
      if (latestState.mode === 'single-page' || !config.autoNextModule) {
        await window.LMSStorage.updateState({
          isRunning: false,
          currentPhase: 'COMPLETED',
          statusText: 'Halaman ini selesai dikerjakan!'
        });
        await window.LMSStorage.addLog('Seluruh tugas pada halaman ini telah selesai.', 'success');
        this.isExecutingCycle = false;
        return;
      }

      // 5. Pindai ulang tombol Next (kadang tombol Next baru muncul/aktif setelah Submit ditekan!)
      await window.LMSExecutor.sleep(500);
      const postSubmitNav = window.LMSScanner.scanNavigation(
        config.customSelectors || {},
        pageData.simulations
      );

      if (postSubmitNav.nextButtonId) {
        const nextEl = window.LMSScanner.getElementById(postSubmitNav.nextButtonId);
        if (nextEl && !nextEl.disabled) {
          await window.LMSStorage.updateState({
            currentPhase: 'NAVIGATING',
            statusText: `Menuju modul berikutnya (${postSubmitNav.nextButtonLabel})...`
          });
          await window.LMSStorage.addLog(
            `Berpindah modul: klik "${postSubmitNav.nextButtonLabel}"`,
            'action'
          );

          const prevUrl = window.location.href;
          await window.LMSExecutor.clickElement(nextEl, '#06b6d4');

          // Tunggu apakah halaman berpindah via SPA (tanpa reload penuh)
          await window.LMSExecutor.sleep(Number(config.pageLoadDelay) || 1400);
          this.isExecutingCycle = false;

          const afterState = await window.LMSStorage.getState();
          if (afterState.isRunning) {
            // Jika halaman adalah SPA dan masih hidup di dokumen yang sama, jalankan siklus berikutnya
            const newScan = window.LMSScanner.scanPage(config);
            const hasNewUncompletedWork =
              newScan.simulations.some((s) => !s.isCompleted) ||
              newScan.mcqs.some((m) => !m.options.some((o) => o.isSelected)) ||
              newScan.essays.some((e) => !e.isFilled) ||
              window.location.href !== prevUrl;

            if (hasNewUncompletedWork) {
              this.runCycle();
            } else {
              await window.LMSStorage.updateState({
                isRunning: false,
                currentPhase: 'COMPLETED',
                statusText: 'Seluruh modul telah selesai!'
              });
              await window.LMSStorage.addLog(
                'Seluruh modul pembelajaran telah selesai dikerjakan!',
                'success'
              );
            }
          }
          return;
        }
      }

      // Tidak ada tombol modul berikutnya lagi -> Kursus/Modul telah tamat
      await window.LMSStorage.updateState({
        isRunning: false,
        currentPhase: 'COMPLETED',
        statusText: 'Seluruh modul selesai!'
      });
      await window.LMSStorage.addLog(
        'Selesai! Tidak ada modul berikutnya lagi.',
        'success'
      );
    } catch (error) {
      console.error('[LMSAutoPilot Error]', error);
      await window.LMSStorage.updateState({
        isRunning: false,
        currentPhase: 'ERROR',
        statusText: `Error: ${error.message}`
      });
      await window.LMSStorage.addLog(`Error: ${error.message}`, 'error');
    } finally {
      this.isExecutingCycle = false;
    }
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSAutoPilot = LMSAutoPilot;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => LMSAutoPilot.init());
} else {
  LMSAutoPilot.init();
}
