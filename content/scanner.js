/**
 * LMS Auto-Pilot - Universal DOM Scanner & Task Detector
 * Mendeteksi:
 * 1. Tugas Simulasi Tombol Interaktif + Tombol Jalankan Program (Run/Execute)
 * 2. Soal Pilihan Ganda (Radio, Checkbox, Kartu Opsi Kustom)
 * 3. Soal Esai & Isian Teks (Textarea, Input Teks, ContentEditable Rich Editor)
 * 4. Tombol Submit Jawaban & Navigasi Modul Berikutnya (Next)
 */

let autoIdCounter = 1;

const LMSScanner = {
  /**
   * Berikan ID unik pada elemen DOM agar dapat diakses kembali oleh Executor
   */
  tagElement(el, prefix = 'el') {
    if (!el) return null;
    let existing = el.getAttribute('data-lms-auto-id');
    if (!existing) {
      existing = `lms-${prefix}-${autoIdCounter++}`;
      el.setAttribute('data-lms-auto-id', existing);
    }
    return existing;
  },

  getElementById(autoId) {
    if (!autoId) return null;
    return document.querySelector(`[data-lms-auto-id="${CSS.escape(autoId)}"]`);
  },

  isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.closest('#lms-autopilot-hud-host')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  },

  cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
  },

  /**
   * Pindai seluruh halaman aktif dan kembalikan struktur data lengkap
   */
  scanPage(config = {}) {
    const customSelectors = config.customSelectors || {};
    const pageTitle = this.cleanText(document.title);
    const moduleContext = this.extractModuleContext();

    const simulations = this.scanSimulations(customSelectors);
    const mcqs = this.scanMCQs(customSelectors);
    const essays = this.scanEssays(customSelectors);
    const navigation = this.scanNavigation(customSelectors, simulations);

    return {
      url: window.location.href,
      pageTitle,
      moduleContext,
      simulations,
      mcqs,
      essays,
      navigation,
      summary: {
        simulationCount: simulations.length,
        mcqCount: mcqs.length,
        essayCount: essays.length,
        hasSubmit: Boolean(navigation.submitButtonId),
        hasNext: Boolean(navigation.nextButtonId)
      }
    };
  },

  /**
   * Ekstrak teks materi pembelajaran pada halaman modul untuk konteks AI
   */
  extractModuleContext() {
    const mainSelectors = [
      'main',
      'article',
      '[role="main"]',
      '.module-content',
      '.lesson-content',
      '.course-content',
      '.learning-content',
      '#region-main',
      '.content-wrapper'
    ];

    let root = null;
    for (const sel of mainSelectors) {
      const candidate = document.querySelector(sel);
      if (candidate && this.isVisible(candidate)) {
        root = candidate;
        break;
      }
    }
    if (!root) root = document.body;

    const clone = root.cloneNode(true);
    const ignored = clone.querySelectorAll(
      'script, style, noscript, nav, footer, header, #lms-autopilot-hud-host, svg, button, .options-list, .sim-buttons-grid, .nav-footer'
    );
    ignored.forEach((n) => n.remove());

    const rawText = clone.innerText || clone.textContent || '';
    return rawText
      .split(/\n+/)
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n')
      .slice(0, 6000);
  },

  /**
   * 1. Pindai Tugas Simulasi Tombol Interaktif & Tombol Jalankan Program
   */
  scanSimulations(customSelectors = {}) {
    const simulations = [];
    const runRegex = /\b(jalankan\s*program|jalankan\s*simulasi|jalankan\s*kode|jalankan|run\s*program|run\s*code|run\s*simulation|eksekusi\s*program|eksekusi|execute|simulasikan|play\s*simulation|compile\s*&\s*run)\b/i;

    // Cari kontainer simulasi eksplisit atau kontainer yang memiliki tombol "Jalankan Program / Run"
    const containerSelectors = [
      '[data-simulation]',
      '[data-task-type="simulation"]',
      '.simulation-container',
      '.simulation-box',
      '.interactive-lab',
      '.lab-container',
      '.program-runner',
      '.code-simulation',
      '.interactive-task',
      '.sim-workspace'
    ];

    const containers = new Set();
    for (const sel of containerSelectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (this.isVisible(el)) containers.add(el);
      });
    }

    // Jika tidak ada kontainer khusus, cari tombol Run Program lalu ambil kontainer induknya
    const allButtons = Array.from(
      document.querySelectorAll('button, [role="button"], input[type="button"]')
    ).filter((el) => this.isVisible(el));

    for (const btn of allButtons) {
      const text = this.cleanText(btn.innerText || btn.value || btn.getAttribute('aria-label') || '');
      const isCustomRun =
        customSelectors.runProgramButton && btn.matches(customSelectors.runProgramButton);
      const isRunBtn =
        isCustomRun ||
        btn.hasAttribute('data-run-program') ||
        btn.classList.contains('run-program-btn') ||
        runRegex.test(text);

      if (isRunBtn) {
        const parentContainer =
          btn.closest(
            'section, .card, .module-section, .task-card, .activity-card, .panel, .workspace, main, form, div[class*="sim"], div[class*="task"], div[class*="lab"]'
          ) || btn.parentElement;

        if (parentContainer) {
          let alreadyInside = false;
          for (const existing of containers) {
            if (existing.contains(parentContainer) || parentContainer.contains(existing)) {
              alreadyInside = true;
              break;
            }
          }
          if (!alreadyInside) {
            containers.add(parentContainer);
          }
        }
      }
    }

    let simIdx = 1;
    for (const container of containers) {
      const taskId = this.tagElement(container, `sim-box-${simIdx++}`);

      // Ekstrak instruksi tugas di dalam kontainer simulasi
      const instructionEls = container.querySelectorAll(
        '.sim-instruction, .task-instruction, .instruction, .prompt, [data-instruction], h2, h3, h4, p, ol, ul, .alert, .callout'
      );
      const instructionParts = [];
      instructionEls.forEach((el) => {
        if (el.closest('button')) return;
        const txt = this.cleanText(el.innerText);
        if (txt && txt.length > 5 && !instructionParts.includes(txt)) {
          instructionParts.push(txt);
        }
      });
      const instruction =
        instructionParts.join(' | ').slice(0, 1500) ||
        this.cleanText(container.innerText).slice(0, 800);

      // Kumpulkan semua tombol di dalam kontainer simulasi
      let rawButtons = Array.from(
        container.querySelectorAll('button, [role="button"], .sim-btn, .step-btn, [data-sim-step]')
      ).filter((el) => this.isVisible(el) && !el.disabled);

      if (customSelectors.simulationButtons) {
        try {
          const customBtns = Array.from(
            container.querySelectorAll(customSelectors.simulationButtons)
          ).filter((el) => this.isVisible(el));
          rawButtons = Array.from(new Set([...rawButtons, ...customBtns]));
        } catch {
          // Abaikan jika selector kustom tidak valid
        }
      }

      const candidateButtons = [];
      const runButtons = [];

      for (const btn of rawButtons) {
        const label = this.cleanText(
          btn.innerText || btn.value || btn.getAttribute('aria-label') || btn.getAttribute('title') || ''
        );
        if (!label) continue;

        const isCustomRun =
          customSelectors.runProgramButton &&
          (() => {
            try {
              return btn.matches(customSelectors.runProgramButton);
            } catch {
              return false;
            }
          })();

        const isRun =
          isCustomRun ||
          btn.hasAttribute('data-run-program') ||
          btn.getAttribute('data-action') === 'run' ||
          btn.classList.contains('run-program-btn') ||
          runRegex.test(label);

        if (isRun) {
          const runId = this.tagElement(btn, 'run-btn');
          runButtons.push({ id: runId, label });
          continue;
        }

        // Abaikan tombol navigasi modul atau submit kuis umum
        if (/\b(selanjutnya|next\s*module|kirim\s*semua|previous|sebelumnya)\b/i.test(label)) {
          continue;
        }

        const btnId = this.tagElement(btn, 'sim-btn');
        const isAlreadySelected =
          btn.classList.contains('active') ||
          btn.classList.contains('selected') ||
          btn.classList.contains('pressed') ||
          btn.getAttribute('aria-pressed') === 'true' ||
          btn.getAttribute('data-selected') === 'true';

        candidateButtons.push({
          id: btnId,
          label,
          stepOrder: btn.getAttribute('data-step') || btn.getAttribute('data-order') || null,
          isCorrect: btn.getAttribute('data-correct') || null,
          isAlreadySelected
        });
      }

      // Cari elemen output/status program di dalam kontainer simulasi
      const outputEl = container.querySelector(
        '.sim-output, .program-output, .console-output, .execution-result, [data-sim-output], pre, code, .result-box'
      );
      const outputId = outputEl ? this.tagElement(outputEl, 'sim-out') : null;
      const isCompleted =
        container.getAttribute('data-completed') === 'true' ||
        container.classList.contains('completed') ||
        (outputEl && /\b(berhasil|sukses|success|completed|passed|100%)\b/i.test(outputEl.innerText || ''));

      if (candidateButtons.length > 0 || runButtons.length > 0) {
        simulations.push({
          taskId,
          instruction,
          candidateButtons,
          runButtons,
          outputId,
          isCompleted
        });
      }
    }

    return simulations;
  },

  /**
   * 2. Pindai Soal Pilihan Ganda (Radio, Checkbox, dan Kartu Opsi Kustom)
   */
  scanMCQs(customSelectors = {}) {
    const mcqs = [];
    const processedInputs = new Set();
    const processedContainers = new Set();

    // A. Input Radio & Checkbox Standar yang dikelompokkan berdasarkan atribut `name` atau kontainer soal
    const inputs = Array.from(
      document.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    ).filter((el) => !el.closest('#lms-autopilot-hud-host') && !el.disabled);

    const groups = new Map();
    for (const input of inputs) {
      // Abaikan toggle non-soal (misal switch tema)
      if (input.closest('nav, header, footer')) continue;

      const groupKey =
        input.name ||
        this.tagElement(
          input.closest('.question, .quiz-item, .mcq-question, fieldset, .form-group') ||
            input.parentElement,
          'mcq-grp'
        );

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(input);
      processedInputs.add(input);
    }

    let qIndex = 1;
    for (const [, groupInputs] of groups.entries()) {
      if (groupInputs.length < 2) continue; // Pilihan ganda minimal memiliki 2 opsi

      const firstInput = groupInputs[0];
      const questionContainer =
        firstInput.closest(
          '.question-card, .quiz-question, .mcq-item, .question-container, .que, fieldset, [data-question], .assessment-item'
        ) || firstInput.parentElement?.parentElement;

      if (questionContainer) {
        processedContainers.add(questionContainer);
      }

      const questionId = this.tagElement(questionContainer || firstInput, `mcq-${qIndex++}`);
      const questionText = this.extractQuestionPrompt(questionContainer, groupInputs);

      const options = groupInputs.map((inp) => {
        const labelEl =
          inp.closest('label') ||
          (inp.id ? document.querySelector(`label[for="${CSS.escape(inp.id)}"]`) : null) ||
          inp.parentElement;

        const clickTarget = labelEl || inp;
        const optId = this.tagElement(clickTarget, 'mcq-opt');
        // Simpan juga referensi ke input asli
        inp.setAttribute('data-lms-auto-input-for', optId);

        const text = this.cleanText(
          (labelEl ? labelEl.innerText : '') ||
            inp.getAttribute('aria-label') ||
            inp.value ||
            ''
        );

        return {
          id: optId,
          text,
          isSelected: Boolean(inp.checked),
          isCorrect:
            inp.getAttribute('data-correct') ||
            (labelEl && labelEl.getAttribute('data-correct')) ||
            null
        };
      });

      mcqs.push({
        questionId,
        questionText,
        inputType: firstInput.type === 'checkbox' ? 'checkbox' : 'radio',
        options
      });
    }

    // B. Komponen Pilihan Ganda Kustom (role="radiogroup" / kartu opsi tanpa <input> standar)
    const customGroupSelectors = [
      '[role="radiogroup"]',
      '[data-question-type="mcq"]',
      '.mcq-options-group',
      '.custom-quiz-question'
    ];
    if (customSelectors.mcqContainer) {
      customGroupSelectors.push(customSelectors.mcqContainer);
    }

    for (const sel of customGroupSelectors) {
      let containers = [];
      try {
        containers = Array.from(document.querySelectorAll(sel));
      } catch {
        continue;
      }

      for (const container of containers) {
        if (!this.isVisible(container) || processedContainers.has(container)) continue;
        if (container.querySelector('input[type="radio"], input[type="checkbox"]')) continue;

        const optionEls = Array.from(
          container.querySelectorAll(
            '[role="radio"], [role="option"], .quiz-option, .option-card, .choice-item, [data-option]'
          )
        ).filter((el) => this.isVisible(el));

        if (optionEls.length < 2) continue;

        processedContainers.add(container);
        const questionId = this.tagElement(container, `mcq-custom-${qIndex++}`);
        const questionText = this.extractQuestionPrompt(container, optionEls);

        const options = optionEls.map((optEl) => {
          const optId = this.tagElement(optEl, 'mcq-copt');
          const isSelected =
            optEl.getAttribute('aria-checked') === 'true' ||
            optEl.getAttribute('aria-selected') === 'true' ||
            optEl.classList.contains('selected') ||
            optEl.classList.contains('active');

          return {
            id: optId,
            text: this.cleanText(optEl.innerText),
            isSelected,
            isCorrect: optEl.getAttribute('data-correct') || null
          };
        });

        mcqs.push({
          questionId,
          questionText,
          inputType: 'radio',
          options
        });
      }
    }

    return mcqs;
  },

  extractQuestionPrompt(container, optionElements = []) {
    if (!container) return 'Pertanyaan Kuis';

    // Cari elemen teks pertanyaan eksplisit di dalam kontainer
    const promptSelectors = [
      '.question-text',
      '.qtext',
      '.question-title',
      '.question-prompt',
      'legend',
      'h3',
      'h4',
      'p'
    ];

    for (const sel of promptSelectors) {
      const el = container.querySelector(sel);
      if (el && !optionElements.some((opt) => el.contains(opt) || opt.contains(el))) {
        const txt = this.cleanText(el.innerText);
        if (txt.length > 3) return txt;
      }
    }

    // Fallback: kloning kontainer dan hapus semua elemen opsi
    const clone = container.cloneNode(true);
    clone
      .querySelectorAll('label, input, [role="radio"], [role="option"], .quiz-option, .option-card')
      .forEach((n) => n.remove());
    return this.cleanText(clone.innerText).slice(0, 600) || 'Pertanyaan Pilihan Ganda';
  },

  /**
   * 3. Pindai Soal Esai & Isian Teks (Textarea, Input Teks, dan Rich-Text Editor)
   */
  scanEssays(customSelectors = {}) {
    const essays = [];
    const candidates = new Set();

    // Textarea standar
    document.querySelectorAll('textarea').forEach((el) => {
      if (this.isVisible(el) && !el.disabled && !el.readOnly) {
        candidates.add(el);
      }
    });

    // Rich text editors (ContentEditable, Quill, CKEditor, TinyMCE inline)
    document
      .querySelectorAll('[contenteditable="true"], .ql-editor, .ck-editor__editable')
      .forEach((el) => {
        if (this.isVisible(el)) {
          candidates.add(el);
        }
      });

    // Input teks yang berada di dalam kontainer soal/tugas (bukan search bar atau navigasi)
    document
      .querySelectorAll(
        '.question input[type="text"], .quiz-question input[type="text"], .essay-question input[type="text"], [data-question] input[type="text"], .task-card input[type="text"]'
      )
      .forEach((el) => {
        if (this.isVisible(el) && !el.disabled && !el.readOnly) {
          candidates.add(el);
        }
      });

    if (customSelectors.essayInput) {
      try {
        document.querySelectorAll(customSelectors.essayInput).forEach((el) => {
          if (this.isVisible(el)) candidates.add(el);
        });
      } catch {
        // Abaikan selector kustom tidak valid
      }
    }

    let eIndex = 1;
    for (const el of candidates) {
      if (el.closest('nav, header, footer, #lms-autopilot-hud-host')) continue;

      const essayId = this.tagElement(el, `essay-${eIndex++}`);
      const questionContainer = el.closest(
        '.essay-question, .question-card, .quiz-question, .task-card, .que, .form-group, fieldset, section'
      );

      let questionText = '';
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) questionText = this.cleanText(lbl.innerText);
      }

      if (!questionText && questionContainer) {
        const promptEl = questionContainer.querySelector(
          'label, .question-text, .qtext, .essay-prompt, .question-title, h3, h4, p'
        );
        if (promptEl && !promptEl.contains(el)) {
          questionText = this.cleanText(promptEl.innerText);
        } else {
          questionText = this.cleanText(questionContainer.innerText).slice(0, 500);
        }
      }

      if (!questionText) {
        questionText =
          el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          'Jelaskan kesimpulan dari materi pada modul ini.';
      }

      const currentValue = el.isContentEditable
        ? this.cleanText(el.innerText)
        : this.cleanText(el.value);

      essays.push({
        essayId,
        questionText,
        placeholder: el.getAttribute('placeholder') || '',
        isContentEditable: Boolean(el.isContentEditable),
        currentValue,
        isFilled: currentValue.length > 15
      });
    }

    return essays;
  },

  /**
   * 4. Pindai Tombol Submit / Verifikasi Jawaban & Tombol Navigasi Modul Berikutnya (Next)
   */
  scanNavigation(customSelectors = {}, simulations = []) {
    const runBtnIds = new Set();
    simulations.forEach((s) => s.runButtons.forEach((rb) => runBtnIds.add(rb.id)));

    const clickables = Array.from(
      document.querySelectorAll('button, a.btn, a[role="button"], input[type="submit"], input[type="button"], [role="button"], a[class*="next"], a[class*="nav"]')
    ).filter((el) => this.isVisible(el) && !el.disabled);

    let submitButtonId = null;
    let submitButtonLabel = null;
    let nextButtonId = null;
    let nextButtonLabel = null;

    // Cek selector kustom terlebih dahulu
    if (customSelectors.submitButton) {
      try {
        const customSub = document.querySelector(customSelectors.submitButton);
        if (customSub && this.isVisible(customSub)) {
          submitButtonId = this.tagElement(customSub, 'nav-submit');
          submitButtonLabel = this.cleanText(customSub.innerText || customSub.value || 'Submit');
        }
      } catch {}
    }

    if (customSelectors.nextButton) {
      try {
        const customNext = document.querySelector(customSelectors.nextButton);
        if (customNext && this.isVisible(customNext)) {
          nextButtonId = this.tagElement(customNext, 'nav-next');
          nextButtonLabel = this.cleanText(customNext.innerText || customNext.value || 'Next');
        }
      } catch {}
    }

    const submitRegex = /\b(kirim\s*jawaban|kirim\s*tugas|submit\s*quiz|submit\s*answer|submit|periksa\s*jawaban|cek\s*jawaban|simpan\s*&\s*kirim|verifikasi\s*jawaban|selesai\s*kuis|finish\s*attempt)\b/i;
    const nextRegex = /\b(modul\s*selanjutnya|modul\s*berikutnya|materi\s*selanjutnya|materi\s*berikutnya|halaman\s*berikutnya|selanjutnya|berikutnya|lanjutkan\s*modul|lanjutkan|lanjut|next\s*module|next\s*lesson|next\s*activity|next\s*page|next|continue|tandai\s*selesai\s*&\s*lanjut|selesai\s*&\s*lanjut)\b/i;

    for (const el of clickables) {
      const existingId = el.getAttribute('data-lms-auto-id');
      if (existingId && runBtnIds.has(existingId)) continue;

      const text = this.cleanText(
        el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || ''
      );
      if (!text) continue;

      if (!submitButtonId && (el.hasAttribute('data-submit-quiz') || submitRegex.test(text))) {
        // Jika tombol menggabungkan "Kirim & Lanjut", prioritaskan sebagai submit atau next sesuai konteks
        submitButtonId = this.tagElement(el, 'nav-submit');
        submitButtonLabel = text;
        continue;
      }

      if (!nextButtonId && (el.hasAttribute('data-next-module') || nextRegex.test(text))) {
        nextButtonId = this.tagElement(el, 'nav-next');
        nextButtonLabel = text;
      }
    }

    return {
      submitButtonId,
      submitButtonLabel,
      nextButtonId,
      nextButtonLabel
    };
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSScanner = LMSScanner;
}
