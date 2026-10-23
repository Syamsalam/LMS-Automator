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
  completedTaskIds: new Set(),
  failedTaskIds: new Set(),

  hasPendingWork(scan) {
    if (!scan) return false;
    const hasSim = (scan.simulations || []).some(
      (s) => !s.isCompleted && !this.completedTaskIds.has(s.taskId)
    );
    const hasPrompt = (scan.actionPrompts || []).some(
      (p) => !p.isCompleted && !this.completedTaskIds.has(p.promptId)
    );
    const hasVideo = (scan.videos || []).some(
      (v) => !v.isCompleted && !this.completedTaskIds.has(v.videoId)
    );
    const hasBlank = (scan.inlineBlanks || []).some(
      (b) => !b.isFilled && !this.completedTaskIds.has(b.blankId)
    );
    const hasMcq = (scan.mcqs || []).some(
      (m) => !m.isCompleted && !this.completedTaskIds.has(m.questionId)
    );
    const hasEssay = (scan.essays || []).some(
      (e) => !e.isFilled && !this.completedTaskIds.has(e.essayId)
    );
    return hasSim || hasPrompt || hasVideo || hasBlank || hasMcq || hasEssay;
  },

  /**
   * Cek apakah halaman utama (`window.top`) memiliki cross-origin iframe aktif yang berukuran besar
   * (seperti SCORM / Articulate Rise / Knowledge Check / Lab Player pada AWS Academy Canvas, AWS Skill Builder, atau NetAcad)
   */
  hasActiveCrossOriginContentIframe() {
    if (window !== window.top) return false;
    return window.LMSScanner.queryAllDeep('iframe').some((f) => {
      if (!window.LMSScanner.isVisible(f)) return false;
      const rect = f.getBoundingClientRect();
      if (rect.width < 260 || rect.height < 180) return false;
      try {
        return !f.contentDocument;
      } catch {
        return true;
      }
    });
  },

  /**
   * Tunggu hingga cross-origin iframe (seperti `#tool_content` di AWS Academy Canvas) selesai memproses
   * video / Knowledge Check, atau lanjutkan setelah jeda singkat jika iframe hanya berisi bacaan/PDF statis.
   */
  async waitForCrossOriginIframe(config) {
    const startWait = Date.now();
    const idleGraceMs = Math.max(Number(config.pageLoadDelay) || 1500, 3200);
    const maxTotalWaitMs = 90000;

    while (Date.now() - startWait < maxTotalWaitMs) {
      if (await this.checkShouldAbort()) return false;
      await window.LMSExecutor.sleep(550);

      const st = await window.LMSStorage.getState();
      if (!st.isRunning) return false;

      if (st.currentPhase === 'NAVIGATE_READY' && (st.lastIframeReadyAt || 0) >= startWait - 1000) {
        return true;
      }

      const lastBusy = st.lastIframeBusyAt || 0;
      const isIframeActivelyWorking = lastBusy > 0 && Date.now() - lastBusy < 6500;

      // Jika setelah 3.2 detik sub-iframe tidak melaporkan aktivitas tugas (misal hanya berisi dokumen/PDF/slide statis),
      // lanjutkan agar halaman induk Canvas dapat menekan tombol "Next ›" di bagian bawah halaman!
      if (!isIframeActivelyWorking && Date.now() - startWait >= idleGraceMs) {
        return true;
      }
    }

    return true;
  },

  async init() {
    // Jika berada di dalam sub-frame:
    // 1. Abaikan iframe tersembunyi / tracker berukuran kecil (< 200x120)
    // 2. Jika same-origin terhadap parent, biarkan parent yang memindai melalui queryAllDeep
    if (window !== window.top) {
      const fw = window.innerWidth || document.documentElement?.clientWidth || 0;
      const fh = window.innerHeight || document.documentElement?.clientHeight || 0;
      if (fw < 200 || fh < 120) {
        return;
      }
      try {
        if (window.parent && window.parent !== window && window.parent.document) {
          return;
        }
      } catch {
        // Cross-origin content iframe berukuran penuh: tetap aktifkan listener untuk mengeksekusi tugas di dalam frame ini
      }
    }

    const config = await window.LMSStorage.getConfig();
    const state = await window.LMSStorage.getState();

    // Inisialisasi Floating HUD hanya di halaman utama (window.top)
    if (window === window.top) {
      window.LMSHud.init({
        onToggleAutoPilot: () => this.toggleAutoPilot(),
        onSolveSinglePage: () => this.runSinglePage(),
        onRescan: () => this.performScanOnly(),
        onToggleAutoNext: async (checked) => {
          await window.LMSStorage.saveConfig({ autoNextModule: checked });
        }
      });
    }

    // Lakukan pemindaian awal untuk menampilkan jumlah tugas di HUD
    this.performScanOnly();
    if (window === window.top) {
      window.LMSHud.updateState(state, config);
    }

    // Pantau perubahan DOM dinamis (SPA / lazy-rendered widget seperti sel kode Python)
    // Jika Auto-Pilot sedang aktif dan muncul tugas baru di layar, langsung jalankan siklus otomatis!
    let scanDebounceTimer = null;
    const domObserver = new MutationObserver((mutations) => {
      if (this.isExecutingCycle) return;
      const isHudMutation = mutations.every(
        (m) => m.target && m.target.closest && m.target.closest('#lms-autopilot-hud-host')
      );
      if (isHudMutation) return;
      clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(async () => {
        if (this.isExecutingCycle) return;
        const scan = this.performScanOnly();
        const latestState = await window.LMSStorage.getState();
        if (latestState.isRunning && !this.isExecutingCycle && this.hasPendingWork(scan)) {
          this.abortRequested = false;
          this.runCycle();
        }
      }, 650);
    });
    if (document.body) {
      domObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Dengarkan perubahan state/config dari Popup atau Background
    window.LMSStorage.onChanged(async ({ state: newState, config: newConfig }) => {
      const latestConfig = newConfig || (await window.LMSStorage.getConfig());
      const latestState = newState || (await window.LMSStorage.getState());
      if (window === window.top) {
        window.LMSHud.updateState(latestState, latestConfig);
      }

      // Jika sub-iframe sudah selesai mengerjakan tugasnya (NAVIGATE_READY) dan meminta window.top untuk pindah modul/sub-modul
      if (
        window === window.top &&
        latestState.isRunning &&
        latestState.currentPhase === 'NAVIGATE_READY' &&
        !this.isExecutingCycle
      ) {
        const nav = window.LMSScanner.scanNavigation(latestConfig.customSelectors || {}, []);
        if (nav.nextButtonId) {
          const nextEl = window.LMSScanner.getElementById(nav.nextButtonId);
          if (nextEl) {
            await window.LMSStorage.updateState({
              currentPhase: 'NAVIGATING',
              statusText: `Menuju modul berikutnya (${nav.nextButtonLabel})...`
            });
            await window.LMSStorage.addLog(
              `Berpindah modul: klik "${nav.nextButtonLabel}"`,
              'action'
            );
            nextEl.setAttribute('data-lms-nav-visited', 'true');
            await window.LMSExecutor.navigateOrClick(nextEl, '#06b6d4');
            await window.LMSExecutor.sleep(Number(latestConfig.pageLoadDelay) || 1400);
            const afterNavState = await window.LMSStorage.getState();
            if (afterNavState.isRunning && !this.isExecutingCycle) {
              this.completedTaskIds.clear();
              this.failedTaskIds.clear();
              this.runCycle();
            }
            return;
          }
        }
      }

      if (
        latestState.isRunning &&
        !this.isExecutingCycle &&
        latestState.currentPhase === 'SCANNING'
      ) {
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
    this.completedTaskIds.clear();
    this.failedTaskIds.clear();
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
      await this.runCycle();
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
   * Siklus Utama Penyelesaian Halaman Modul (Multi-Task Berkelanjutan + Auto-Scroll)
   * Tidak berhenti setelah 1 tugas: terus memindai ulang dan menggulir halaman ke bawah
   * hingga seluruh simulasi, pilihan hasil program ([...]), pilihan ganda, dan esai pada halaman selesai.
   */
  async runCycle() {
    if (this.isExecutingCycle) return;
    this.isExecutingCycle = true;

    try {
      const config = await window.LMSStorage.getConfig();
      const initialScan = window.LMSScanner.scanPage(config);
      if (window === window.top) {
        window.LMSHud.updateScanSummary(initialScan.summary);
      }

      const initialTotalTasks =
        initialScan.summary.simulationCount +
        initialScan.summary.mcqCount +
        initialScan.summary.essayCount;

      // KASUS KHUSUS 1: Halaman Daftar Modul / Modules Index (seperti `awsacademy.instructure.com/courses/184279/modules`)
      // Jangan memindai daftar modul sebagai soal Pilihan Ganda dan jangan scroll sampai ke bawah halaman!
      // Langsung cari item modul pertama yang belum selesai / belum dikunjungi, lalu masuk ke dalam halaman modul tersebut.
      if (window === window.top && initialScan.isModulesIndexPage) {
        let modNav = initialScan.navigation;
        for (let scrollAttempt = 0; scrollAttempt < 4 && !modNav.nextButtonId; scrollAttempt++) {
          const didScroll = await window.LMSExecutor.scrollPageDown();
          if (!didScroll) break;
          await window.LMSExecutor.sleep(400);
          modNav = window.LMSScanner.scanNavigation(config.customSelectors || {}, []);
        }

        if (modNav.nextButtonId) {
          const entryEl = window.LMSScanner.getElementById(modNav.nextButtonId);
          if (entryEl) {
            await window.LMSStorage.updateState({
              currentPhase: 'NAVIGATING',
              statusText: `${modNav.nextButtonLabel}...`
            });
            await window.LMSStorage.addLog(
              `Membuka item modul dari daftar: "${modNav.nextButtonLabel}"`,
              'action'
            );
            entryEl.setAttribute('data-lms-nav-visited', 'true');
            await window.LMSExecutor.navigateOrClick(entryEl, '#06b6d4');
            await window.LMSExecutor.sleep(Number(config.pageLoadDelay) || 1200);
            const afterEntryState = await window.LMSStorage.getState();
            if (afterEntryState.isRunning && !window.LMSScanner.isModulesIndexPage()) {
              this.isExecutingCycle = false;
              await this.runCycle();
            }
            return;
          }
        }
      }

      // KASUS KHUSUS 2: Halaman utama (`window.top`) memiliki cross-origin iframe aktif (seperti `#tool_content` di AWS Academy Canvas atau NetAcad)
      // Tunggu hingga sub-iframe menyelesaikan video / Knowledge Check, lalu lanjutkan ke tombol `Next ›` di halaman induk!
      if (window === window.top && initialTotalTasks === 0 && this.hasActiveCrossOriginContentIframe()) {
        const iframeDone = await this.waitForCrossOriginIframe(config);
        if (!iframeDone) return;
      }

      // Jika di dalam frame ini tidak ada tugas sama sekali dan tidak ada tombol navigasi:
      // Coba scroll sekali; jika tetap kosong dan ini sub-iframe, beri sinyal NAVIGATE_READY ke halaman induk!
      if (
        initialTotalTasks === 0 &&
        !initialScan.navigation.submitButtonId &&
        !initialScan.navigation.nextButtonId
      ) {
        const scrolledOnce = await window.LMSExecutor.scrollPageDown();
        if (!scrolledOnce) {
          if (window !== window.top) {
            await window.LMSStorage.updateState({
              currentPhase: 'NAVIGATE_READY',
              lastIframeReadyAt: Date.now(),
              statusText: 'Konten di dalam modul selesai, berpindah ke bagian berikutnya...'
            });
          }
          return;
        }
      }

      await window.LMSStorage.updateState({
        currentPhase: 'SCANNING',
        statusText: 'Memindai tugas pada halaman...'
      });

      if (initialTotalTasks > 0) {
        if (window !== window.top) {
          await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
        }
        await window.LMSStorage.addLog(
          `Terdeteksi: ${initialScan.summary.simulationCount} Simulasi/Aksi, ${initialScan.summary.mcqCount} PG, ${initialScan.summary.essayCount} Esai.`,
          'info'
        );
      }

      let hasFailedTask = false;
      const failureReasons = [];
      let lastPageData = initialScan;
      let loggedSolverSource = false;

      // LOOP PENYELESAIAN BERKELANJUTAN:
      // Selesaikan tugas satu per satu, pindai ulang DOM setiap selesai 1 tugas, dan scroll ke bawah
      // hingga seluruh tugas pada halaman selesai dikerjakan.
      const maxPasses = 25;
      for (let pass = 0; pass < maxPasses; pass++) {
        if (await this.checkShouldAbort()) return;

        const pageData = pass === 0 ? initialScan : window.LMSScanner.scanPage(config);
        lastPageData = pageData;
        if (window === window.top) {
          window.LMSHud.updateScanSummary(pageData.summary);
        }

        // Jika setelah menekan tombol "Start / Launch / Resume" muncul cross-origin iframe modul (seperti SCORM / Rise 360 / Knowledge Check),
        // tunggu iframe menyelesaikan tugasnya sebelum halaman induk melanjutkan navigasi!
        if (
          window === window.top &&
          !this.hasPendingWork(pageData) &&
          this.hasActiveCrossOriginContentIframe()
        ) {
          await this.waitForCrossOriginIframe(config);
          break;
        }

        const pendingPrompts = (pageData.actionPrompts || []).filter(
          (p) => !p.isCompleted && !this.completedTaskIds.has(p.promptId)
        );
        const pendingVideos = (pageData.videos || []).filter(
          (v) => !v.isCompleted && !this.completedTaskIds.has(v.videoId)
        );
        const pendingSims = (pageData.simulations || []).filter(
          (s) => !s.isCompleted && !this.completedTaskIds.has(s.taskId)
        );
        const pendingBlanks = (pageData.inlineBlanks || []).filter(
          (b) => !b.isFilled && !this.completedTaskIds.has(b.blankId)
        );
        const pendingMcqs = (pageData.mcqs || []).filter(
          (m) => !m.isCompleted && !this.completedTaskIds.has(m.questionId)
        );
        const pendingEssays = (pageData.essays || []).filter(
          (e) => !e.isFilled && !this.completedTaskIds.has(e.essayId)
        );

        // Prioritas 0A: Jika ada tombol pemicu aktivitas / peluncur modul ("Take the Survey", "Take the Quiz", "Start", "Resume", "Continue", "Click here to..."),
        // klik terlebih dahulu untuk masuk ke dalam modul / membuka simulasi / membuka soal!
        if (pendingPrompts.length > 0) {
          const promptItem = pendingPrompts[0];
          const promptEl = window.LMSScanner.getElementById(promptItem.promptId);
          this.completedTaskIds.add(promptItem.promptId);
          if (promptEl && window.LMSScanner.isVisible(promptEl)) {
            if (window !== window.top) {
              await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
            }
            await window.LMSStorage.updateState({
              currentPhase: 'SIMULATION',
              statusText: `Menekan tombol interaktif: "${promptItem.label.slice(0, 40)}..."`
            });
            await window.LMSStorage.addLog(
              `Menekan tombol langkah/modul: "${promptItem.label}"`,
              'action'
            );
            promptEl.setAttribute('data-lms-completed', 'true');
            await window.LMSExecutor.navigateOrClick(promptEl, '#f59e0b');
            await window.LMSExecutor.sleep(Math.max(Number(config.actionDelay) || 500, 750));
            continue;
          }
        }

        // Prioritas 0B: Jika ada materi Video (`<video>` pada AWS Academy / AWS Skill Builder / Canvas / Coursera) yang belum selesai,
        // putar & selesaikan progres videonya terlebih dahulu agar modul video tercentang selesai!
        if (pendingVideos.length > 0) {
          const videoItem = pendingVideos[0];
          this.completedTaskIds.add(videoItem.videoId);
          if (window !== window.top) {
            await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
          }
          await window.LMSStorage.updateState({
            currentPhase: 'SIMULATION',
            statusText: 'Menyelesaikan pemutaran materi video...'
          });
          const doneVideo = await window.LMSExecutor.executeVideo(
            videoItem,
            config,
            (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
          );
          if (doneVideo) {
            const currentState = await window.LMSStorage.getState();
            const stats = { ...(currentState.stats || window.LMSStorage.DEFAULT_STATE.stats) };
            stats.simulationsRun = (stats.simulationsRun || 0) + 1;
            await window.LMSStorage.updateState({ stats });
          }
          await window.LMSExecutor.sleep(450);
          continue;
        }

        const pendingCount =
          pendingSims.length + pendingBlanks.length + pendingMcqs.length + pendingEssays.length;

        if (pendingCount > 0) {
          if (window !== window.top) {
            await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
          }
          await window.LMSStorage.updateState({
            currentPhase: 'AI_THINKING',
            statusText: `Menganalisis tugas (${pendingCount} tersisa di layar)...`
          });

          const solution = await this.requestAISolution(pageData, config);
          if (solution.source && !loggedSolverSource) {
            loggedSolverSource = true;
            await window.LMSStorage.addLog(`Solver: ${solution.source}`, 'info');
          }

          if (await this.checkShouldAbort()) return;

          const currentState = await window.LMSStorage.getState();
          let stats = { ...(currentState.stats || window.LMSStorage.DEFAULT_STATE.stats) };

          // Prioritas 1: Eksekusi 1 Simulasi / Code-Builder yang belum selesai, lalu pindai ulang DOM
          if (pendingSims.length > 0) {
            const simScan = pendingSims[0];
            await window.LMSStorage.updateState({
              currentPhase: 'SIMULATION',
              statusText: `Menjalankan simulasi (${ stats.simulationsRun + 1 })...`
            });

            const simSol =
              (solution.simulations || []).find((s) => s.taskId === simScan.taskId) ||
              (solution.simulations || [])[0];

            const simResult = await window.LMSExecutor.executeSimulation(
              simScan,
              simSol,
              config,
              (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
            );

            // Tandai sudah diproses pada siklus ini agar tidak mengulang tanpa henti, dan lanjut ke tugas berikutnya!
            this.completedTaskIds.add(simScan.taskId);

            if (simResult && simResult.ok === false) {
              hasFailedTask = true;
              this.failedTaskIds.add(simScan.taskId);
              failureReasons.push(simResult.reason || 'Simulasi belum tepat');
            } else {
              stats.simulationsRun = (stats.simulationsRun || 0) + 1;
              await window.LMSStorage.updateState({ stats });
            }

            await window.LMSExecutor.sleep(350);
            continue;
          }

          // Prioritas 2: Eksekusi Pilihan Rumpang / Hasil Program (`There are [...] rows of data...`)
          if (pendingBlanks.length > 0) {
            await window.LMSStorage.updateState({
              currentPhase: 'MCQ',
              statusText: `Menjawab ${pendingBlanks.length} pilihan rumpang hasil program...`
            });

            const answeredBlanks = await window.LMSExecutor.executeInlineBlanks(
              document,
              pageData.moduleContext || '',
              config,
              (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
            );
            pendingBlanks.forEach((b) => this.completedTaskIds.add(b.blankId));

            if (answeredBlanks > 0) {
              stats.mcqAnswered = (stats.mcqAnswered || 0) + answeredBlanks;
              await window.LMSStorage.updateState({ stats });
            }

            await window.LMSExecutor.sleep(300);
            continue;
          }

          // Prioritas 3: Eksekusi Soal Pilihan Ganda (MCQ)
          if (pendingMcqs.length > 0) {
            await window.LMSStorage.updateState({
              currentPhase: 'MCQ',
              statusText: `Menjawab soal pilihan ganda (${pendingMcqs.length} tersisa)...`
            });

            for (const mcqScan of pendingMcqs) {
              if (await this.checkShouldAbort()) return;
              const mcqSol =
                (solution.mcqs || []).find((m) => m.questionId === mcqScan.questionId) ||
                (solution.mcqs || [])[0];

              const answered = await window.LMSExecutor.executeMCQ(
                mcqScan,
                mcqSol,
                config,
                (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
              );
              this.completedTaskIds.add(mcqScan.questionId);
              if (answered) {
                stats.mcqAnswered = (stats.mcqAnswered || 0) + 1;
                await window.LMSStorage.updateState({ stats });
              }
            }

            await window.LMSExecutor.sleep(300);
            continue;
          }

          // Prioritas 4: Eksekusi Soal Esai / Isian Teks
          if (pendingEssays.length > 0) {
            await window.LMSStorage.updateState({
              currentPhase: 'ESSAY',
              statusText: `Mengisi soal esai (${pendingEssays.length} tersisa)...`
            });

            for (const essayScan of pendingEssays) {
              if (await this.checkShouldAbort()) return;
              const essaySol =
                (solution.essays || []).find((e) => e.essayId === essayScan.essayId) ||
                (solution.essays || [])[0];

              const filled = await window.LMSExecutor.executeEssay(
                essayScan,
                essaySol,
                config,
                (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
              );
              this.completedTaskIds.add(essayScan.essayId);
              if (filled) {
                stats.essaysFilled = (stats.essaysFilled || 0) + 1;
                await window.LMSStorage.updateState({ stats });
              }
            }

            await window.LMSExecutor.sleep(300);
            continue;
          }
        }

        // Tidak ada tugas tertunda di area layar saat ini -> Coba scroll ke bawah untuk memuat tugas berikutnya!
        const scrolled = await window.LMSExecutor.scrollPageDown();
        if (scrolled) {
          await window.LMSStorage.updateState({
            currentPhase: 'SCANNING',
            statusText: 'Menggulir ke bawah untuk mencari tugas berikutnya...'
          });
          await window.LMSExecutor.sleep(550);
          continue;
        }

        // Sudah tidak bisa scroll lagi dan semua tugas di halaman telah diproses
        break;
      }

      if (await this.checkShouldAbort()) return;

      // JIKA ADA SIMULASI ATAU TUGAS YANG MASIH SALAH / BELUM LENGKAP:
      // JANGAN anggap selesai (COMPLETED) dan JANGAN pindah modul!
      if (hasFailedTask) {
        await window.LMSStorage.updateState({
          isRunning: false,
          currentPhase: 'ERROR',
          statusText: `Belum tepat: ${failureReasons[0]}`
        });
        await window.LMSStorage.addLog(
          `Simulasi TIDAK dianggap selesai karena masih salah/belum lengkap: ${failureReasons.join('; ')}`,
          'error'
        );
        this.isExecutingCycle = false;
        return;
      }

      // 4. Klik semua Tombol Submit / Periksa Jawaban yang masih aktif pada halaman (mendukung halaman Assessment dengan banyak tombol Submit)
      const freshNav = window.LMSScanner.scanNavigation(
        config.customSelectors || {},
        lastPageData.simulations
      );

      const submitList =
        Array.isArray(freshNav.submitButtonIds) && freshNav.submitButtonIds.length > 0
          ? freshNav.submitButtonIds
          : freshNav.submitButtonId
          ? [{ id: freshNav.submitButtonId, label: freshNav.submitButtonLabel }]
          : [];

      if (config.autoSubmit !== false && submitList.length > 0) {
        let clickedAnySubmit = false;
        for (const subItem of submitList) {
          if (await this.checkShouldAbort()) return;
          const submitEl = window.LMSScanner.getElementById(subItem.id);
          if (submitEl && window.LMSScanner.isVisible(submitEl) && !submitEl.disabled && submitEl.getAttribute('data-lms-completed') !== 'true') {
            await window.LMSStorage.updateState({
              currentPhase: 'SUBMITTING',
              statusText: `Mengirim jawaban (${subItem.label})...`
            });
            await window.LMSStorage.addLog(
              `Menekan tombol Submit: "${subItem.label}"`,
              'action'
            );
            submitEl.setAttribute('data-lms-completed', 'true');
            await window.LMSExecutor.clickElement(submitEl, '#10b981');
            clickedAnySubmit = true;
            await window.LMSExecutor.sleep(Number(config.actionDelay) + 400);
          }
        }

        if (clickedAnySubmit) {
          // Jika menekan Submit membuka langkah/tugas baru di bawahnya pada halaman yang sama,
          // langsung lanjutkan siklus untuk mengerjakan tugas baru tersebut!
          const postSubScan = window.LMSScanner.scanPage(config);
          if (this.hasPendingWork(postSubScan)) {
            this.isExecutingCycle = false;
            await this.runCycle();
            return;
          }
        }
      }

      const finalState = await window.LMSStorage.getState();
      const updatedStats = { ...(finalState.stats || window.LMSStorage.DEFAULT_STATE.stats) };
      updatedStats.pagesCompleted = (updatedStats.pagesCompleted || 0) + 1;
      await window.LMSStorage.updateState({ stats: updatedStats });

      // Jika mode hanya 1 halaman, selesai di sini
      if (finalState.mode === 'single-page' || !config.autoNextModule) {
        await window.LMSStorage.updateState({
          isRunning: false,
          currentPhase: 'COMPLETED',
          statusText: 'Halaman ini selesai dikerjakan!'
        });
        await window.LMSStorage.addLog('Seluruh tugas pada halaman ini telah selesai.', 'success');
        this.isExecutingCycle = false;
        return;
      }

      // 5. Pindai ulang tombol Next (kadang tombol Next baru muncul/aktif setelah Submit atau setelah semua tugas selesai!)
      await window.LMSExecutor.sleep(500);

      let postSubmitNav = window.LMSScanner.scanNavigation(
        config.customSelectors || {},
        lastPageData.simulations
      );

      // Jika satu-satunya navigasi yang ditemukan adalah item di Sidebar/Outline (`isOutlineNext`),
      // tetapi halaman saat ini sama sekali belum menjalankan tugas/submit apa pun (`completedTaskIds.size === 0`),
      // tunggu sejenak dan pindai ulang apakah ada tombol "Start / Launch / Resume" atau video/kuis yang baru dimuat secara asinkron!
      if (postSubmitNav.isOutlineNext && this.completedTaskIds.size === 0) {
        await window.LMSExecutor.sleep(1100);
        const delayedScan = window.LMSScanner.scanPage(config);
        if (this.hasPendingWork(delayedScan)) {
          this.isExecutingCycle = false;
          await this.runCycle();
          return;
        }
        postSubmitNav = delayedScan.navigation;
      }

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
          if (!postSubmitNav.isCarouselNext) {
            this.completedTaskIds.clear();
            this.failedTaskIds.clear();
            nextEl.setAttribute('data-lms-nav-visited', 'true');
          }
          await window.LMSExecutor.navigateOrClick(nextEl, '#06b6d4');

          // Tunggu apakah halaman / slide berpindah via SPA (tanpa reload penuh)
          const waitNavMs = postSubmitNav.isCarouselNext
            ? Math.min(Number(config.pageLoadDelay) || 900, 950)
            : Number(config.pageLoadDelay) || 1400;
          await window.LMSExecutor.sleep(waitNavMs);

          const afterState = await window.LMSStorage.getState();
          if (afterState.isRunning) {
            let newScan = window.LMSScanner.scanPage(config);

            // Jika tombol yang baru diklik adalah panah Carousel `>`, tetapi tidak ada soal baru yang muncul
            // (berarti sudah berada di soal terakhir pada Carousel Assessment), tandai panah `>` selesai lalu pindah ke sub-modul berikutnya (misal Reflections)!
            if (postSubmitNav.isCarouselNext && !this.hasPendingWork(newScan)) {
              nextEl.setAttribute('data-lms-nav-visited', 'true');
              const fallbackNav = window.LMSScanner.scanNavigation(
                config.customSelectors || {},
                lastPageData.simulations
              );
              if (fallbackNav.nextButtonId) {
                const outlineNextEl = window.LMSScanner.getElementById(fallbackNav.nextButtonId);
                if (outlineNextEl && !outlineNextEl.disabled) {
                  await window.LMSStorage.addLog(
                    `Berpindah sub-modul: klik "${fallbackNav.nextButtonLabel}"`,
                    'action'
                  );
                  this.completedTaskIds.clear();
                  this.failedTaskIds.clear();
                  outlineNextEl.setAttribute('data-lms-nav-visited', 'true');
                  await window.LMSExecutor.navigateOrClick(outlineNextEl, '#06b6d4');
                  await window.LMSExecutor.sleep(Number(config.pageLoadDelay) || 1400);
                  newScan = window.LMSScanner.scanPage(config);
                }
              }
            }

            if (
              this.hasPendingWork(newScan) ||
              Boolean(newScan.navigation.nextButtonId) ||
              window.location.href !== prevUrl
            ) {
              this.isExecutingCycle = false;
              await this.runCycle();
              return;
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

      // Jika kita berada di dalam sub-iframe (misal iframe latihan NetAcad / Articulate Rise AWS) dan tidak ada tombol Next di dalam iframe ini,
      // beri sinyal ke halaman induk agar halaman induk menekan tombol Next › di Canvas / Course Outline!
      if (window !== window.top) {
        await window.LMSStorage.updateState({
          currentPhase: 'NAVIGATE_READY',
          lastIframeReadyAt: Date.now(),
          statusText: 'Tugas selesai, mencari sub-modul berikutnya...'
        });
        this.isExecutingCycle = false;
        return;
      }

      // Jika di halaman utama ini tidak ada tugas sama sekali dan tidak ada tombol Next (misal sedang menunggu konten dimuat),
      // jangan langsung klaim "Tidak ada modul berikutnya lagi"
      if (this.completedTaskIds.size === 0 && initialTotalTasks === 0) {
        await window.LMSStorage.updateState({
          currentPhase: 'SCANNING',
          statusText: 'Menunggu aktivitas/tugas pada modul...'
        });
        this.isExecutingCycle = false;
        return;
      }

      // Tidak ada tombol modul berikutnya lagi di window utama -> Kursus/Modul telah tamat
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
