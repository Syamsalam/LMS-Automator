/**
 * LMS Auto-Pilot - Realistic DOM Action Executor
 * Menjalankan klik tombol interaktif, eksekusi program simulasi,
 * pengisian pilihan ganda, dan pengetikan esai yang kompatibel dengan React/Vue/Angular/Moodle.
 */

const LMSExecutor = {
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  /**
   * Berikan efek highlight visual pada elemen yang sedang dieksekusi oleh Auto-Pilot
   */
  highlightElement(el, color = '#10b981', duration = 900) {
    if (!el || !(el instanceof HTMLElement)) return;
    const prevOutline = el.style.outline;
    const prevOutlineOffset = el.style.outlineOffset;
    const prevTransition = el.style.transition;
    const prevBoxShadow = el.style.boxShadow;

    el.style.transition = 'all 0.25s ease';
    el.style.outline = `2.5px solid ${color}`;
    el.style.outlineOffset = '2px';
    el.style.boxShadow = `0 0 14px ${color}66`;

    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOutlineOffset;
      el.style.boxShadow = prevBoxShadow;
      el.style.transition = prevTransition;
    }, duration);
  },

  /**
   * Scroll halus agar elemen terlihat di layar sebelum diklik/diisi
   */
  async scrollIntoViewSafe(el) {
    if (!el) return;
    try {
      const rect = el.getBoundingClientRect();
      const isInViewport =
        rect.top >= 60 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) - 60;
      if (!isInViewport) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        await this.sleep(220);
      }
    } catch {
      // Abaikan jika gagal scroll
    }
  },

  /**
   * Simulasikan rangkaian event klik manusia (kompatibel dengan React synthetic events & event listener standar)
   */
  async clickElement(el, highlightColor = '#3b82f6') {
    if (!el) return false;
    await this.scrollIntoViewSafe(el);
    this.highlightElement(el, highlightColor, 850);

    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY
    };

    el.dispatchEvent(new PointerEvent('pointerover', eventInit));
    el.dispatchEvent(new MouseEvent('mouseover', eventInit));
    el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    el.dispatchEvent(new MouseEvent('mousedown', eventInit));
    if (typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }
    el.dispatchEvent(new PointerEvent('pointerup', eventInit));
    el.dispatchEvent(new MouseEvent('mouseup', eventInit));

    // Jika elemen adalah <label> yang membungkus input radio/checkbox, klik input atau label dengan tepat
    const linkedInput =
      el.querySelector('input[type="radio"], input[type="checkbox"]') ||
      document.querySelector(`[data-lms-auto-input-for="${el.getAttribute('data-lms-auto-id') || ''}"]`);

    if (linkedInput && linkedInput !== el) {
      if (!linkedInput.checked) {
        linkedInput.click();
        linkedInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else if (typeof el.click === 'function') {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent('click', eventInit));
    }

    return true;
  },

  /**
   * Isi teks pada <textarea>, <input>, atau elemen [contenteditable="true"]
   * Menggunakan native prototype value setter agar state React / Vue / Angular ikut ter-update
   */
  async fillTextElement(el, text, options = {}) {
    if (!el || typeof text !== 'string') return false;
    const { simulateTyping = true } = options;

    await this.scrollIntoViewSafe(el);
    this.highlightElement(el, '#8b5cf6', 1200);

    if (typeof el.focus === 'function') {
      el.focus({ preventScroll: true });
    }

    // Jika elemen adalah Rich Text Editor (contenteditable)
    if (el.isContentEditable) {
      el.innerHTML = '';
      if (simulateTyping && text.length < 600) {
        const chunks = text.match(/.{1,12}/g) || [text];
        let current = '';
        for (const chunk of chunks) {
          current += chunk;
          el.innerText = current;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: chunk, inputType: 'insertText' }));
          await this.sleep(25);
        }
      } else {
        el.innerText = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      return true;
    }

    // Untuk <textarea> atau <input>
    const prototype =
      el instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;

    const setValue = (val) => {
      if (nativeSetter) {
        nativeSetter.call(el, val);
      } else {
        el.value = val;
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
    };

    if (simulateTyping && text.length < 700) {
      // Simulasikan pengetikan cepat per potongan kata agar terlihat natural dan memicu key/input listener
      const words = text.split(' ');
      let current = '';
      const stepSize = Math.max(1, Math.ceil(words.length / 18));
      for (let i = 0; i < words.length; i += stepSize) {
        const slice = words.slice(i, i + stepSize).join(' ');
        current = current ? `${current} ${slice}` : slice;
        setValue(current);
        await this.sleep(30);
      }
    } else {
      setValue(text);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    return true;
  },

  /**
   * 1. Eksekusi Tugas Simulasi:
   *    Tekan urutan tombol yang benar satu per satu -> Tekan tombol Jalankan Program -> Tunggu selesai
   */
  async executeSimulation(simScan, simSolution, config, onLog) {
    const delay = Number(config.actionDelay) || 600;
    const programWait = Number(config.programWaitTime) || 1800;
    const sequenceIds = simSolution?.sequenceIds || [];
    const runButtonId =
      simSolution?.runButtonId ||
      (simScan.runButtons && simScan.runButtons[0] ? simScan.runButtons[0].id : null);

    // Langkah A: Klik urutan tombol interaktif yang benar
    for (let i = 0; i < sequenceIds.length; i++) {
      const btnId = sequenceIds[i];
      const btnEl = window.LMSScanner.getElementById(btnId);
      if (!btnEl) continue;

      const label = window.LMSScanner.cleanText(btnEl.innerText || btnEl.value || btnId);
      const isAlreadyActive =
        btnEl.classList.contains('active') ||
        btnEl.classList.contains('selected') ||
        btnEl.getAttribute('aria-pressed') === 'true' ||
        btnEl.getAttribute('data-selected') === 'true';

      if (!isAlreadyActive) {
        if (onLog) {
          await onLog(`Menekan tombol langkah (${i + 1}/${sequenceIds.length}): "${label}"`, 'action');
        }
        await this.clickElement(btnEl, '#f59e0b');
        await this.sleep(delay);
      }
    }

    // Langkah B: Klik tombol Jalankan Program (Run / Execute)
    if (runButtonId) {
      const runEl = window.LMSScanner.getElementById(runButtonId);
      if (runEl) {
        const runLabel = window.LMSScanner.cleanText(runEl.innerText || runEl.value || 'Jalankan Program');
        if (onLog) {
          await onLog(`Menjalankan program: klik tombol "${runLabel}"`, 'action');
        }
        await this.clickElement(runEl, '#10b981');

        // Tunggu program selesai berjalan (pantau perubahan output DOM atau tunggu programWaitTime)
        const outputEl = simScan.outputId ? window.LMSScanner.getElementById(simScan.outputId) : null;
        await this.waitForProgramCompletion(outputEl, programWait);

        if (onLog) {
          const outPreview = outputEl
            ? window.LMSScanner.cleanText(outputEl.innerText).slice(0, 90)
            : 'Eksekusi selesai';
          await onLog(`Program selesai dijalankan: ${outPreview}`, 'success');
        }
      }
    }

    return true;
  },

  /**
   * Tunggu hingga output program muncul / berhenti berubah atau batas waktu tercapai
   */
  waitForProgramCompletion(outputEl, maxWaitMs = 1800) {
    return new Promise((resolve) => {
      if (!outputEl) {
        setTimeout(resolve, maxWaitMs);
        return;
      }

      let settledTimer = null;
      const maxTimer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, maxWaitMs);

      const observer = new MutationObserver(() => {
        const txt = (outputEl.innerText || '').toLowerCase();
        if (/\b(berhasil|sukses|success|selesai|completed|output|passed)\b/i.test(txt)) {
          clearTimeout(settledTimer);
          settledTimer = setTimeout(() => {
            clearTimeout(maxTimer);
            observer.disconnect();
            resolve();
          }, 350);
        }
      });

      observer.observe(outputEl, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });
    });
  },

  /**
   * 2. Eksekusi Soal Pilihan Ganda
   */
  async executeMCQ(mcqScan, mcqSolution, config, onLog) {
    const delay = Number(config.actionDelay) || 600;
    const selectedIds = mcqSolution?.selectedOptionIds || [];
    if (selectedIds.length === 0) return false;

    for (const optId of selectedIds) {
      const optEl = window.LMSScanner.getElementById(optId);
      if (!optEl) continue;

      const optObj = (mcqScan.options || []).find((o) => o.id === optId);
      const optLabel = optObj ? optObj.text.slice(0, 65) : optId;

      if (onLog) {
        await onLog(`Memilih jawaban PG: "${optLabel}"`, 'action');
      }
      await this.clickElement(optEl, '#3b82f6');
      await this.sleep(Math.min(delay, 500));
    }
    return true;
  },

  /**
   * 3. Eksekusi Soal Esai / Isian Teks
   */
  async executeEssay(essayScan, essaySolution, config, onLog) {
    const answerText = (essaySolution?.answerText || '').trim();
    if (!answerText) return false;

    const el = window.LMSScanner.getElementById(essayScan.essayId);
    if (!el) return false;

    if (onLog) {
      await onLog(`Mengisi jawaban esai (${answerText.split(/\s+/).length} kata)...`, 'action');
    }

    await this.fillTextElement(el, answerText, {
      simulateTyping: config.simulateTyping !== false
    });

    await this.sleep(Number(config.actionDelay) || 500);
    return true;
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSExecutor = LMSExecutor;
}
