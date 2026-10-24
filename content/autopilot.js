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
    const hasVocLab = Boolean(
      scan.vocareumLab &&
        !scan.vocareumLab.isCompleted &&
        !this.completedTaskIds.has(scan.vocareumLab.labId)
    );
    return hasSim || hasPrompt || hasVideo || hasBlank || hasMcq || hasEssay || hasVocLab;
  },

  /**
   * Cek apakah frame saat ini memiliki child iframe cross-origin aktif yang berukuran besar
   * (seperti `#tool_content` atau `story.html` pada AWS Academy / NetAcad)
   */
  hasActiveCrossOriginContentIframe() {
    return window.LMSScanner.queryAllDeep('iframe, frame').some((f) => {
      if (!window.LMSScanner.isVisible(f)) return false;
      const rect = f.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 130) return false;
      try {
        return !f.contentDocument;
      } catch {
        return true;
      }
    });
  },

  /**
   * Tunggu hingga child iframe (seperti `#tool_content` / Articulate Storyline Knowledge Check atau Lab Menu di AWS Academy Canvas)
   * selesai memuat ("Loading content...") dan selesai mengerjakan tombol Start serta seluruh soal Knowledge Check per halaman kecil.
   */
  async waitForCrossOriginIframe(config) {
    const startWait = Date.now();
    const pageHeaderTxt = `${document.title || ''} ${document.querySelector('h1, h2, .page-title')?.innerText || ''}`;
    const isKnowledgeCheckOrLabPage = window.LMSScanner.isKnowledgeCheckOrLabTitle(pageHeaderTxt);

    // Berikan waktu tunggu awal yang cukup (hingga 30 detik) bagi Knowledge Check / Lab untuk melewati "Loading content..."
    const initialLoadGraceMs = isKnowledgeCheckOrLabPage
      ? 30000
      : Math.max(Number(config.pageLoadDelay) || 1500, 6500);
    const maxTotalWaitMs = isKnowledgeCheckOrLabPage ? 300000 : 95000;

    while (Date.now() - startWait < maxTotalWaitMs) {
      if (await this.checkShouldAbort()) return false;
      await window.LMSExecutor.sleep(600);

      const st = await window.LMSStorage.getState();
      if (!st.isRunning) return false;

      if (st.currentPhase === 'NAVIGATE_READY' && (st.lastIframeReadyAt || 0) >= startWait - 1000) {
        return true;
      }

      // Selama halaman masih menampilkan "Loading content...", jangan pernah timeout!
      if (window.LMSScanner.isPageOrFrameLoading()) {
        continue;
      }

      const lastBusy = st.lastIframeBusyAt || 0;
      const isIframeActivelyWorking = lastBusy > 0 && Date.now() - lastBusy < 15000;

      if (!isIframeActivelyWorking && Date.now() - startWait >= initialLoadGraceMs) {
        return true;
      }
    }

    return true;
  },

  async init() {
    // Jika berada di dalam sub-frame yang same-origin terhadap parent-nya,
    // biarkan parent memindai dokumen ini secara langsung melalui queryAllDeep() agar tidak terjadi double-click!
    // Namun jika cross-origin terhadap parent-nya, frame ini wajib menjalankan LMSAutoPilot sendiri.
    if (window !== window.top) {
      try {
        if (window.parent && window.parent !== window && window.parent.document) {
          return;
        }
      } catch {
        // Cross-origin terhadap parent: lanjutkan inisialisasi pada frame ini
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

    // Jika berada di dalam sub-iframe berukuran sangat kecil (misal tracker / pixel tersembunyi), abaikan sepenuhnya!
    if (window !== window.top) {
      const fw = window.innerWidth || document.documentElement?.clientWidth || 0;
      const fh = window.innerHeight || document.documentElement?.clientHeight || 0;
      if (fw < 160 || fh < 100) {
        return;
      }
    }

    this.isExecutingCycle = true;

    try {
      const config = await window.LMSStorage.getConfig();

      // Tunggu terlebih dahulu jika halaman / frame masih menampilkan "Loading content..." / spinner
      if (window.LMSScanner.isPageOrFrameLoading()) {
        await window.LMSStorage.updateState({
          currentPhase: 'SCANNING',
          ...(window !== window.top ? { lastIframeBusyAt: Date.now() } : {}),
          statusText: 'Menunggu menu Knowledge Check / Lab selesai dimuat...'
        });
        for (let w = 0; w < 40 && window.LMSScanner.isPageOrFrameLoading(); w++) {
          if (await this.checkShouldAbort()) return;
          if (window !== window.top) {
            await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
          }
          await window.LMSExecutor.sleep(750);
        }
      }

      let initialScan = window.LMSScanner.scanPage(config);
      if (window === window.top) {
        window.LMSHud.updateScanSummary(initialScan.summary);
      }

      let initialTotalTasks =
        initialScan.summary.simulationCount +
        initialScan.summary.mcqCount +
        initialScan.summary.essayCount;

      // KASUS KHUSUS 1: Halaman Daftar Modul / Modules Index (seperti `awsacademy.instructure.com/courses/184279/modules`)
      // Cari dan buka HANYA item Knowledge Check atau Lab yang belum selesai!
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
              `Membuka Knowledge Check / Lab: "${modNav.nextButtonLabel}"`,
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

      // KASUS KHUSUS 1B: Jika berada di halaman Canvas LMS (`#section-tabs`) yang BUKAN halaman `/modules`
      // dan halaman saat ini BUKAN Knowledge Check maupun Lab (misal halaman Video / Student Guide / Discussion),
      // langsung lompat ke Knowledge Check / Lab berikutnya!
      if (
        window === window.top &&
        !initialScan.isModulesIndexPage &&
        initialTotalTasks === 0 &&
        document.querySelector('#section-tabs')
      ) {
        const pageHeaderTxt = `${document.title || ''} ${document.querySelector('h1, h2, .page-title, .assignment-title')?.innerText || ''}`;
        if (!window.LMSScanner.isKnowledgeCheckOrLabTitle(pageHeaderTxt)) {
          const queuedKcOrLab = window.LMSScanner.getNextQueuedKnowledgeCheckOrLab();
          if (queuedKcOrLab && queuedKcOrLab.href) {
            await window.LMSStorage.updateState({
              currentPhase: 'NAVIGATING',
              statusText: `Melompat ke: ${queuedKcOrLab.label}...`
            });
            await window.LMSStorage.addLog(
              `Melewati materi non-kuis/lab, langsung menuju: "${queuedKcOrLab.label}"`,
              'action'
            );
            window.LMSScanner.markModuleUrlVisited(queuedKcOrLab.href);
            window.location.assign(queuedKcOrLab.href);
            return;
          }
          const modulesTabLink = document.querySelector(
            '#section-tabs a.modules, #section-tabs a[href$="/modules"], #section-tabs a[href*="/modules"]'
          );
          if (modulesTabLink && window.LMSScanner.isVisible(modulesTabLink)) {
            await window.LMSStorage.updateState({
              currentPhase: 'NAVIGATING',
              statusText: 'Membuka daftar Modules untuk mencari Knowledge Check & Lab...'
            });
            await window.LMSStorage.addLog(
              'Membuka daftar Modules untuk mencari Knowledge Check & Lab...',
              'action'
            );
            await window.LMSExecutor.navigateOrClick(modulesTabLink, '#06b6d4');
            return;
          }
        }
      }

      // KASUS KHUSUS 2: Jika frame ini adalah wrapper luar yang memiliki child iframe konten aktif
      // (seperti Canvas `window.top` atau SCORM LTI wrapper yang membungkus Articulate Storyline Knowledge Check),
      // tunggu hingga child iframe menyelesaikan tombol Start dan seluruh soal Knowledge Check!
      if (initialTotalTasks === 0 && this.hasActiveCrossOriginContentIframe()) {
        if (window === window.top) {
          const iframeDone = await this.waitForCrossOriginIframe(config);
          if (!iframeDone) return;
        } else {
          // Jika ini frame perantara (bukan window.top) yang membungkus child iframe, biarkan child iframe yang bekerja!
          return;
        }
      }

      // KASUS KHUSUS 3: Di dalam sub-iframe (misal Articulate Storyline 360 / Rise 360 / LTI External Tool),
      // menu kecil sering kali memuat tombol "Start" atau daftar soal beberapa detik setelah halaman tampil.
      // Tunggu & pindai ulang secara berkala sebelum menyatakan iframe selesai!
      if (
        window !== window.top &&
        initialTotalTasks === 0 &&
        !initialScan.navigation.submitButtonId &&
        !initialScan.navigation.nextButtonId
      ) {
        const looksLikeCoursePlayer =
          Boolean(
            document.querySelector(
              '#preso, #slide, .slide-container, .frame-wrap, #app, .rise-player, video, iframe, canvas, svg'
            )
          ) ||
          /\b(story|scorm|lti|quiz|knowledge|module|rise|player|vocareum|lab)\b/i.test(
            `${window.location.href} ${document.title}`
          );

        if (looksLikeCoursePlayer) {
          await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
          for (let waitPoll = 0; waitPoll < 25; waitPoll++) {
            if (await this.checkShouldAbort()) return;
            await window.LMSExecutor.sleep(650);
            initialScan = window.LMSScanner.scanPage(config);
            initialTotalTasks =
              initialScan.summary.simulationCount +
              initialScan.summary.mcqCount +
              initialScan.summary.essayCount;
            if (
              initialTotalTasks > 0 ||
              initialScan.navigation.submitButtonId ||
              initialScan.navigation.nextButtonId ||
              window.LMSScanner.isKnowledgeCheckCompletedScreen()
            ) {
              await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
              break;
            }
          }
        }
      }

      // Jika di dalam frame ini tetap tidak ada tugas sama sekali dan tidak ada tombol navigasi:
      if (
        initialTotalTasks === 0 &&
        !initialScan.navigation.submitButtonId &&
        !initialScan.navigation.nextButtonId
      ) {
        const scrolledOnce = await window.LMSExecutor.scrollPageDown();
        if (!scrolledOnce) {
          // PENTING: Sub-iframe HANYA boleh mengirim sinyal NAVIGATE_READY jika memang sudah menyelesaikan tugas
          // atau sudah berada di layar hasil akhir (Results / Score)!
          if (
            window !== window.top &&
            !this.hasActiveCrossOriginContentIframe() &&
            (this.completedTaskIds.size > 0 || window.LMSScanner.isKnowledgeCheckCompletedScreen())
          ) {
            await window.LMSStorage.updateState({
              currentPhase: 'NAVIGATE_READY',
              lastIframeReadyAt: Date.now(),
              statusText: 'Knowledge Check selesai, berpindah ke tugas berikutnya...'
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
      // Selesaikan tugas satu per satu, pindai ulang DOM setiap selesai 1 tugas (mendukung 10+ halaman kecil di dalam Knowledge Check),
      // dan scroll ke bawah hingga seluruh tugas pada halaman selesai dikerjakan.
      const maxPasses = 65;
      for (let pass = 0; pass < maxPasses; pass++) {
        if (await this.checkShouldAbort()) return;

        // Jika di tengah proses transisi slide muncul loading spinner, tunggu hingga selesai
        if (window.LMSScanner.isPageOrFrameLoading()) {
          for (let w = 0; w < 20 && window.LMSScanner.isPageOrFrameLoading(); w++) {
            if (await this.checkShouldAbort()) return;
            if (window !== window.top) {
              await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
            }
            await window.LMSExecutor.sleep(600);
          }
        }

        const pageData = pass === 0 ? initialScan : window.LMSScanner.scanPage(config);
        lastPageData = pageData;
        if (window === window.top) {
          window.LMSHud.updateScanSummary(pageData.summary);
        }

        // Jika setelah menekan tombol "Start / Launch / Resume" muncul child iframe modul (seperti SCORM / Rise 360 / Knowledge Check),
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

        // Prioritas 00: Jika berada di halaman Vocareum Lab Workbench (`labs.vocareum.com`),
        // pelajari terlebih dahulu seluruh instruksi di dalam Lab, mulai Lab (`Start Lab`), dan jalankan seluruh instruksi Task 1..N!
        if (
          pageData.vocareumLab &&
          !pageData.vocareumLab.isCompleted &&
          !this.completedTaskIds.has(pageData.vocareumLab.labId)
        ) {
          this.completedTaskIds.add(pageData.vocareumLab.labId);
          const labRes = await window.LMSExecutor.executeVocareumLab(
            pageData.vocareumLab,
            config,
            (msg, lvl) => window.LMSStorage.addLog(msg, lvl)
          );
          const currentState = await window.LMSStorage.getState();
          const stats = { ...(currentState.stats || window.LMSStorage.DEFAULT_STATE.stats) };
          stats.simulationsRun =
            (stats.simulationsRun || 0) + Math.max((pageData.vocareumLab.tasks || []).length, 1);
          stats.pagesCompleted = (stats.pagesCompleted || 0) + 1;
          await window.LMSStorage.updateState({
            isRunning: false,
            currentPhase: labRes && labRes.ok === false ? 'ERROR' : 'COMPLETED',
            statusText:
              labRes && labRes.ok === false
                ? `Lab selesai sebagian: ${labRes.reason || ''}`
                : 'Seluruh instruksi Lab selesai dijalankan!',
            stats
          });
          this.isExecutingCycle = false;
          return;
        }

        // Prioritas 0A: Jika ada tombol pemicu aktivitas / peluncur Knowledge Check ("Start", "Continue")
        // atau tombol pemulai Lab memakai nama Lab ("Load [Nama Lab] in a new window", "[Nama Lab]", "Start Lab"),
        // klik terlebih dahulu!
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
              statusText: `Menekan tombol: "${promptItem.label.slice(0, 45)}..."`
            });
            await window.LMSStorage.addLog(
              `Menekan tombol langkah/modul: "${promptItem.label}"`,
              'action'
            );
            promptEl.setAttribute('data-lms-completed', 'true');
            const navRes = await window.LMSExecutor.navigateOrClick(promptEl, '#f59e0b');

            // Jika tombol yang diklik membuka tab baru Lab (seperti `labs.vocareum.com`),
            // BIARKAN `isRunning: true` agar tab baru Vocareum otomatis mempelajari & menjalankan seluruh instruksi Lab!
            if (navRes && navRes.openedNewTab) {
              await window.LMSStorage.updateState({
                isRunning: true,
                currentPhase: 'SCANNING',
                statusText: 'Tab Lab dibuka — mempelajari & menjalankan instruksi Lab...'
              });
              await window.LMSStorage.addLog(
                `Tab baru Lab dibuka melalui "${promptItem.label}". Melanjutkan mempelajari & menjalankan instruksi di tab Lab...`,
                'info'
              );
              this.isExecutingCycle = false;
              return;
            }

            await window.LMSExecutor.sleep(Math.max(Number(config.actionDelay) || 500, 650));

            // Tunggu transisi halaman kecil / slide di dalam menu Knowledge Check (misal setelah klik "Start" atau "Continue")
            for (let poll = 0; poll < 8; poll++) {
              if (await this.checkShouldAbort()) return;
              const checkScan = window.LMSScanner.scanPage(config);
              if (this.hasPendingWork(checkScan) || window.LMSScanner.isKnowledgeCheckCompletedScreen()) {
                break;
              }
              await window.LMSExecutor.sleep(450);
            }
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

          // Prioritas 3: Eksekusi Soal Pilihan Ganda (MCQ - mendukung multi-soal sekaligus maupun per-halaman kecil di dalam Knowledge Check)
          if (pendingMcqs.length > 0) {
            await window.LMSStorage.updateState({
              currentPhase: 'MCQ',
              statusText: `Menjawab soal pilihan ganda (${pendingMcqs.length} di layar)...`
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
                // Reset status tombol Submit/Continue yang persisten di dalam menu kecil Knowledge Check (Articulate Storyline / Rise)
                window.LMSScanner.queryAllDeep('[data-lms-auto-id^="lms-nav-submit-"]').forEach((b) =>
                  b.removeAttribute('data-lms-completed')
                );
                window.LMSScanner.queryAllDeep('[data-lms-auto-id^="lms-nav-next-"]').forEach((b) =>
                  b.removeAttribute('data-lms-nav-visited')
                );
                window.LMSScanner.queryAllDeep('[data-lms-auto-id^="lms-action-prompt-"]').forEach((b) => {
                  const txt = window.LMSScanner.getElementText(b);
                  if (/^(?:continue|lanjutkan|ok|next)$/i.test(txt)) {
                    b.removeAttribute('data-lms-completed');
                    const pid = b.getAttribute('data-lms-auto-id');
                    if (pid) this.completedTaskIds.delete(pid);
                  }
                });
              }
            }

            // Jika ini adalah soal per-halaman kecil (1 soal per layar seperti pada Knowledge Check AWS Academy)
            // dan terdapat tombol SUBMIT di bagian bawah menu kecil, langsung klik SUBMIT lalu tunggu popup Continue / soal berikutnya!
            if (pendingMcqs.length === 1 && config.autoSubmit !== false) {
              const midNav = window.LMSScanner.scanNavigation(
                config.customSelectors || {},
                pageData.simulations
              );
              const midSubList =
                Array.isArray(midNav.submitButtonIds) && midNav.submitButtonIds.length > 0
                  ? midNav.submitButtonIds
                  : midNav.submitButtonId
                  ? [{ id: midNav.submitButtonId, label: midNav.submitButtonLabel }]
                  : [];

              if (midSubList.length > 0) {
                const subEl = window.LMSScanner.getElementById(midSubList[0].id);
                if (subEl && window.LMSScanner.isVisible(subEl) && !subEl.disabled) {
                  if (window !== window.top) {
                    await window.LMSStorage.updateState({ lastIframeBusyAt: Date.now() });
                  }
                  await window.LMSStorage.updateState({
                    currentPhase: 'SUBMITTING',
                    statusText: `Mengirim jawaban soal (${midSubList[0].label})...`
                  });
                  await window.LMSStorage.addLog(
                    `Menekan tombol Submit soal: "${midSubList[0].label}"`,
                    'action'
                  );
                  subEl.setAttribute('data-lms-completed', 'true');
                  await window.LMSExecutor.clickElement(subEl, '#10b981');
                  await window.LMSExecutor.sleep(Math.max(Number(config.actionDelay) || 500, 650));

                  // Tunggu hingga layer feedback "Continue" atau halaman soal berikutnya muncul di dalam menu kecil
                  for (let poll = 0; poll < 8; poll++) {
                    if (await this.checkShouldAbort()) return;
                    const afterSubScan = window.LMSScanner.scanPage(config);
                    if (this.hasPendingWork(afterSubScan) || window.LMSScanner.isKnowledgeCheckCompletedScreen()) {
                      break;
                    }
                    await window.LMSExecutor.sleep(450);
                  }
                  continue;
                }
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

      // Jika kita berada di dalam sub-iframe (misal iframe Knowledge Check AWS Academy / NetAcad) dan seluruh soal di dalam iframe ini telah selesai,
      // beri sinyal ke halaman induk agar halaman induk berpindah ke Knowledge Check / Lab berikutnya!
      if (window !== window.top) {
        if (
          !this.hasActiveCrossOriginContentIframe() &&
          (this.completedTaskIds.size > 0 || window.LMSScanner.isKnowledgeCheckCompletedScreen())
        ) {
          await window.LMSStorage.updateState({
            currentPhase: 'NAVIGATE_READY',
            lastIframeReadyAt: Date.now(),
            statusText: 'Tugas selesai, mencari Knowledge Check / Lab berikutnya...'
          });
        }
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
