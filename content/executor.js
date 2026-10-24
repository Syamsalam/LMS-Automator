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
    if (!el || el.nodeType !== 1 || !el.style) return;
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
   * Scroll halaman (atau kontainer materi kursus seperti pada NetAcad, termasuk di dalam Shadow DOM / same-origin iframe)
   * ke bawah secara bertahap untuk menampilkan tugas berikutnya yang berada di bawah layar / lazy-rendered.
   * Mengembalikan true jika posisi scroll berhasil bergerak ke bawah, atau false jika sudah mentok di paling bawah.
   */
  async scrollPageDown() {
    const vh = window.innerHeight || document.documentElement.clientHeight || 700;
    const step = Math.max(280, Math.floor(vh * 0.65));

    // 1. Coba scroll window / document.scrollingElement (termasuk dokumen di dalam same-origin iframe)
    const roots = window.LMSScanner ? window.LMSScanner.getAccessibleRoots(document) : [document];
    for (const root of roots) {
      const doc = root.nodeType === 9 ? root : root.ownerDocument;
      const win = doc?.defaultView || window;
      const docScroller = doc ? doc.scrollingElement || doc.documentElement || doc.body : null;
      if (docScroller && docScroller.scrollHeight > docScroller.clientHeight + 20) {
        const prevTop = win.scrollY || docScroller.scrollTop || 0;
        if (prevTop + docScroller.clientHeight < docScroller.scrollHeight - 12) {
          win.scrollBy({ top: step, behavior: 'smooth' });
          await this.sleep(360);
          let newTop = win.scrollY || docScroller.scrollTop || 0;
          if (newTop <= prevTop + 5) {
            docScroller.scrollTop = Math.min(docScroller.scrollHeight, prevTop + step);
            await this.sleep(150);
            newTop = win.scrollY || docScroller.scrollTop || 0;
          }
          if (newTop > prevTop + 5) {
            return true;
          }
        }
      }
    }

    // 2. Cari kontainer scrollable di dalam halaman (misal panel materi pada LMS / NetAcad),
    //    PASTIKAN mengabaikan panel Sidebar / Course Outline di sebelah kiri!
    const rawElements = window.LMSScanner
      ? window.LMSScanner.queryAllDeep('main, article, [role="main"], .content, .course-content, .page-content, div, section')
      : Array.from(document.querySelectorAll('main, article, [role="main"], .content, .course-content, .page-content, div, section'));

    const candidates = rawElements.filter((el) => {
      if (!el || (el.closest && el.closest('#lms-autopilot-hud-host'))) return false;
      if (window.LMSScanner && window.LMSScanner.isInsideSidebarOrHeader(el)) return false;
      if (el.clientHeight < 200 || el.scrollHeight <= el.clientHeight + 30) return false;
      const rect = el.getBoundingClientRect();
      // Abaikan panel sempit di sisi kiri layar (sidebar)
      if ((window.innerWidth || 1024) >= 800 && rect.width <= 380 && rect.left <= 30) return false;
      const win = el.ownerDocument?.defaultView || window;
      const style = win.getComputedStyle(el);
      return /^(auto|scroll|overlay)$/i.test(style.overflowY || style.overflow || '');
    });

    // Urutkan dari kontainer dengan area terluas
    candidates.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);

    for (const box of candidates) {
      const prevTop = box.scrollTop;
      if (prevTop + box.clientHeight < box.scrollHeight - 12) {
        box.scrollBy({ top: step, behavior: 'smooth' });
        await this.sleep(360);
        if (box.scrollTop <= prevTop + 5) {
          box.scrollTop = Math.min(box.scrollHeight, prevTop + step);
          await this.sleep(150);
        }
        if (box.scrollTop > prevTop + 5) {
          return true;
        }
      }
    }

    return false;
  },

  /**
   * Simulasikan rangkaian event klik manusia (kompatibel dengan React synthetic events, Articulate Storyline 360 SVG/Canvas, & lintas iframe)
   */
  async clickElement(el, highlightColor = '#3b82f6') {
    if (!el) return false;
    await this.scrollIntoViewSafe(el);
    this.highlightElement(el, highlightColor, 850);

    const doc = el.ownerDocument || document;
    const win = doc.defaultView || window;
    const rect = el.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;

    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    const dispatchPointerAndMouse = (target) => {
      if (!target) return;
      try {
        const PtrEv = win.PointerEvent || PointerEvent;
        const MseEv = win.MouseEvent || MouseEvent;
        target.dispatchEvent(new PtrEv('pointerover', eventInit));
        target.dispatchEvent(new PtrEv('pointerenter', eventInit));
        target.dispatchEvent(new MseEv('mouseover', eventInit));
        target.dispatchEvent(new MseEv('mouseenter', eventInit));
        target.dispatchEvent(new PtrEv('pointerdown', eventInit));
        target.dispatchEvent(new MseEv('mousedown', eventInit));
        if (typeof target.focus === 'function') {
          target.focus({ preventScroll: true });
        }
        target.dispatchEvent(new PtrEv('pointerup', { ...eventInit, buttons: 0 }));
        target.dispatchEvent(new MseEv('mouseup', { ...eventInit, buttons: 0 }));
      } catch {
        // Abaikan jika browser membatasi konstruktor PointerEvent lintas frame
      }
    };

    dispatchPointerAndMouse(el);

    // Jika elemen adalah <label> yang membungkus input radio/checkbox, klik input atau label dengan tepat
    const linkedInput =
      (el.querySelector && el.querySelector('input[type="radio"], input[type="checkbox"]')) ||
      doc.querySelector(`[data-lms-auto-input-for="${CSS.escape(el.getAttribute('data-lms-auto-id') || '')}"]`);

    if (linkedInput && linkedInput !== el) {
      if (!linkedInput.checked) {
        linkedInput.click();
        const Ev = win.Event || Event;
        linkedInput.dispatchEvent(new Ev('change', { bubbles: true }));
      }
    } else if (typeof el.click === 'function') {
      el.click();
    } else {
      const MseEv = win.MouseEvent || MouseEvent;
      el.dispatchEvent(new MseEv('click', { ...eventInit, buttons: 0 }));
    }

    // Untuk Articulate Storyline 360 / SVG Canvas player:
    // 1. Jika di dalam el ada .event-layer / svg path / svg rect, kirim event pointer & mouse ke sana (tanpa menduplikasi click yang bubble)
    if (el.querySelector) {
      const svgTarget = el.querySelector('.event-layer, svg path, svg rect, svg');
      if (svgTarget && svgTarget !== el) {
        dispatchPointerAndMouse(svgTarget);
      }
    }

    // 2. Pastikan elemen teratas pada koordinat (clientX, clientY) yang BUKAN anak dari el serta pasangan .acc-element / .slide-object menerima event klik!
    try {
      const pointEl = doc.elementFromPoint ? doc.elementFromPoint(clientX, clientY) : null;
      if (
        pointEl &&
        pointEl !== el &&
        pointEl !== linkedInput &&
        !el.contains(pointEl) &&
        !(pointEl.closest && pointEl.closest('#lms-autopilot-hud-host'))
      ) {
        dispatchPointerAndMouse(pointEl);
        if (typeof pointEl.click === 'function') {
          pointEl.click();
        } else {
          const MseEv = win.MouseEvent || MouseEvent;
          pointEl.dispatchEvent(new MseEv('click', { ...eventInit, buttons: 0 }));
        }
      }

      // Jika berada di dalam Storyline player, picu juga pasangan .acc-element / .slide-object yang bertumpuk pada koordinat yang sama
      if (el.closest && el.closest('#preso, #slide, .slide-container, .frame-wrap')) {
        const overlays = Array.from(
          doc.querySelectorAll('.acc-element, [data-acc-text], .slide-object, button')
        ).filter((cand) => {
          if (cand === el || cand === pointEl || cand.contains(el) || el.contains(cand)) return false;
          const r = cand.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          return Math.abs(cx - clientX) <= 22 && Math.abs(cy - clientY) <= 18;
        });
        for (const ov of overlays.slice(0, 2)) {
          dispatchPointerAndMouse(ov);
          if (typeof ov.click === 'function') ov.click();
        }
      }
    } catch {}

    return true;
  },

  /**
   * Klik elemen navigasi / tautan modul (`<a href="...">` seperti pada daftar modul Canvas, tombol `Load <Nama Lab> in a new window`, atau `Next ›`)
   * Mengembalikan `{ clicked: true, openedNewTab: boolean }`.
   */
  async navigateOrClick(el, highlightColor = '#06b6d4') {
    if (!el) return { clicked: false, openedNewTab: false };

    const overrideHref = (el.getAttribute && el.getAttribute('data-lms-override-href')) || '';
    if (overrideHref) {
      this.highlightElement(el, highlightColor, 850);
      if (window.LMSScanner && typeof window.LMSScanner.markModuleUrlVisited === 'function') {
        window.LMSScanner.markModuleUrlVisited(overrideHref);
      }
      await this.sleep(180);
      try {
        window.location.assign(overrideHref);
      } catch {}
      return { clicked: true, openedNewTab: false };
    }

    const anchor = el.tagName === 'A' ? el : el.closest ? el.closest('a[href]') : null;
    const targetHref = anchor ? (anchor.href || anchor.getAttribute('href') || '').trim() : '';
    const elText = window.LMSScanner ? window.LMSScanner.getElementText(anchor || el) : '';
    const parentForm = el.closest ? el.closest('form[target="_blank"]') : null;
    const isBlankTarget =
      Boolean(anchor && anchor.getAttribute('target') === '_blank') ||
      Boolean(parentForm) ||
      /\bin\s+a\s+new\s+(?:window|tab)\b/i.test(elText);
    const prevUrl = window.location.href;

    if (targetHref && window.LMSScanner && typeof window.LMSScanner.markModuleUrlVisited === 'function') {
      window.LMSScanner.markModuleUrlVisited(targetHref);
    }

    // Jika tautan adalah peluncur Lab di tab baru (<a target="_blank" href="http...">),
    // gunakan chrome.tabs.create via Service Worker agar TIDAK PERNAH diblokir oleh popup blocker Chrome!
    if (
      anchor &&
      isBlankTarget &&
      anchor.href &&
      /^https?:\/\//i.test(anchor.href) &&
      typeof chrome !== 'undefined' &&
      chrome.runtime &&
      chrome.runtime.sendMessage
    ) {
      await this.scrollIntoViewSafe(anchor);
      this.highlightElement(anchor, highlightColor, 850);
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'OPEN_NEW_TAB', payload: { url: anchor.href } }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      });
      await this.sleep(350);
      return { clicked: true, openedNewTab: true };
    }

    await this.clickElement(anchor || el, highlightColor);

    if (isBlankTarget) {
      await this.sleep(450);
      return { clicked: true, openedNewTab: true };
    }

    // Jika elemen memiliki tautan <a href="..."> yang valid (bukan '#' atau 'javascript:') dan bukan tab baru,
    // pastikan navigasi halaman benar-benar terjadi!
    if (
      anchor &&
      targetHref &&
      !targetHref.startsWith('#') &&
      !/^javascript:/i.test(targetHref)
    ) {
      await this.sleep(320);
      if (window.location.href === prevUrl && anchor.href && anchor.href !== prevUrl) {
        try {
          window.location.assign(anchor.href);
        } catch {}
      }
    }

    // Cek juga apakah klik barusan membuka tab baru via window.open() (menyebabkan tab ini menjadi hidden)
    await this.sleep(250);
    const openedViaWindowOpen = document.visibilityState === 'hidden';
    return { clicked: true, openedNewTab: openedViaWindowOpen };
  },

  /**
   * Isi teks pada <textarea>, <input>, atau elemen [contenteditable="true"]
   * Menggunakan native prototype value setter dari window pemilik elemen (aman terhadap lintas iframe & menghindari "Illegal invocation")
   */
  async fillTextElement(el, text, options = {}) {
    if (!el || typeof text !== 'string') return false;
    const { simulateTyping = true } = options;

    await this.scrollIntoViewSafe(el);
    this.highlightElement(el, '#8b5cf6', 1200);

    const win = el.ownerDocument?.defaultView || window;
    const tag = (el.tagName || '').toUpperCase();

    if (typeof el.focus === 'function') {
      try {
        el.focus({ preventScroll: true });
      } catch {}
    }

    const dispatchInputEvent = (target, dataStr) => {
      try {
        const InputEv = win.InputEvent || InputEvent;
        target.dispatchEvent(new InputEv('input', { bubbles: true, data: dataStr, inputType: 'insertText' }));
      } catch {
        const Ev = win.Event || Event;
        target.dispatchEvent(new Ev('input', { bubbles: true }));
      }
    };

    const dispatchChangeAndBlur = (target) => {
      try {
        const Ev = win.Event || Event;
        const FocusEv = win.FocusEvent || FocusEvent;
        target.dispatchEvent(new Ev('change', { bubbles: true }));
        target.dispatchEvent(new FocusEv('blur', { bubbles: true }));
      } catch {}
    };

    // Jika elemen adalah Rich Text Editor (contenteditable atau non-input/textarea seperti .ql-editor / .ck-editor__editable)
    if (el.isContentEditable || (tag !== 'TEXTAREA' && tag !== 'INPUT')) {
      el.innerHTML = '';
      if (simulateTyping && text.length < 600) {
        const chunks = text.match(/.{1,12}/g) || [text];
        let current = '';
        for (const chunk of chunks) {
          current += chunk;
          el.innerText = current;
          dispatchInputEvent(el, chunk);
          await this.sleep(25);
        }
      } else {
        el.innerText = text;
        dispatchInputEvent(el, text);
      }
      dispatchChangeAndBlur(el);
      return true;
    }

    // Untuk <textarea> atau <input>: gunakan prototype dari window milik elemen tersebut (win)
    // agar tidak terjadi "TypeError: Illegal invocation" saat elemen berada di dalam iframe!
    const proto =
      tag === 'TEXTAREA'
        ? win.HTMLTextAreaElement?.prototype
        : win.HTMLInputElement?.prototype;
    const nativeSetter =
      (proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set) ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;

    const setValue = (val) => {
      try {
        if (nativeSetter) {
          nativeSetter.call(el, val);
        } else {
          el.value = val;
        }
      } catch {
        el.value = val;
      }
      dispatchInputEvent(el, val);
    };

    if (simulateTyping && text.length < 700) {
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

    dispatchChangeAndBlur(el);
    return true;
  },

  /**
   * Simulasikan Drag-and-Drop HTML5 & Mouse untuk blok kode yang harus diseret ke editor
   */
  async dragAndDropElement(sourceEl, targetEl) {
    if (!sourceEl || !targetEl) return false;
    const sRect = sourceEl.getBoundingClientRect();
    const tRect = targetEl.getBoundingClientRect();
    const sX = sRect.left + sRect.width / 2;
    const sY = sRect.top + sRect.height / 2;
    const tX = tRect.left + tRect.width / 2;
    const tY = tRect.top + tRect.height / 2;

    let dataTransfer = null;
    try {
      dataTransfer = new DataTransfer();
      const payload =
        sourceEl.getAttribute('data-code') ||
        sourceEl.getAttribute('data-value') ||
        sourceEl.id ||
        sourceEl.innerText ||
        '';
      dataTransfer.setData('text/plain', payload);
    } catch {}

    sourceEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sX, clientY: sY }));
    if (typeof DragEvent !== 'undefined') {
      sourceEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: sX, clientY: sY, dataTransfer }));
      targetEl.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: tX, clientY: tY, dataTransfer }));
      targetEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: tX, clientY: tY, dataTransfer }));
      targetEl.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: tX, clientY: tY, dataTransfer }));
      sourceEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, clientX: tX, clientY: tY, dataTransfer }));
    }
    targetEl.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: tX, clientY: tY }));
    targetEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: tX, clientY: tY }));
    return true;
  },

  /**
   * Isi slot kosong (`[▪]`) baik melalui sub-tile yang muncul maupun input teks inline di dalam editor/tile
   */
  async fillSlotOrClickSubTile(containerEl, slotVal, config, onLog) {
    if (!containerEl || !slotVal) return false;
    const cleanExpected = String(slotVal).trim();
    const unquotedExpected = cleanExpected.replace(/^['"]|['"]$/g, '');
    const delay = Math.min(Number(config.actionDelay) || 400, 450);

    // 1. Cek apakah ada <input> atau [contenteditable="true"] kosong di dalam container (misal di dalam kotak kode)
    const inlineInputs = window.LMSScanner.queryAllDeep(
      'input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="button"]):not([type="submit"]), [contenteditable="true"]',
      containerEl
    ).filter((el) => window.LMSScanner.isVisible(el) && !el.disabled && !el.readOnly);

    for (const inp of inlineInputs) {
      const currVal = window.LMSScanner.cleanText(inp.value || inp.innerText || '');
      if (!currVal || /^[_▪▫•?…\-\s]+$/.test(currVal)) {
        if (onLog) {
          await onLog(`Mengisi slot kode: "${cleanExpected}"`, 'action');
        }
        await this.fillTextElement(inp, cleanExpected, { simulateTyping: false });
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        await this.sleep(delay);
        return true;
      }
    }

    // 2. Cek apakah ada sub-tile di area pilihan yang cocok dengan nilai slot (misal `pd`, `'internet.csv'`, `internet`)
    const currentTiles = window.LMSScanner.collectCandidateTiles(containerEl, [], config.customSelectors || {});
    const matchingTile = currentTiles.find((t) => {
      if (t.isAlreadySelected) return false;
      const lbl = (t.rawLabel || t.label || '').trim();
      const unquotedLbl = lbl.replace(/^['"]|['"]$/g, '');
      if (lbl === cleanExpected || unquotedLbl === unquotedExpected) return true;
      // Jika mencari nama file .csv dan ada tile yang berakhiran .csv
      if (/\.csv$/i.test(unquotedExpected) && /\.csv['"]?$/i.test(lbl)) return true;
      return false;
    });

    if (matchingTile) {
      const tileEl = window.LMSScanner.getElementById(matchingTile.id);
      if (tileEl) {
        if (onLog) {
          await onLog(`Memilih isian slot: "${matchingTile.label}"`, 'action');
        }
        await this.clickElement(tileEl, '#38bdf8');
        await this.sleep(delay);
        return true;
      }
    }

    return false;
  },

  /**
   * Selesaikan satu elemen slot `[▪]` di dalam blok program (klik slot -> pilih dari balon popover / dropdown / input)
   */
  async resolveSlotElement(slotEl, expectedVal, slotIndex, tileLabel, containerEl, mainTileIds, editorBoxEl, config, onLog) {
    if (!slotEl) return false;
    const delay = Math.min(Number(config.actionDelay) || 400, 420);
    const cleanExpected = String(expectedVal || '').trim();

    // 1. Jika slot adalah elemen <select>
    if (slotEl.tagName === 'SELECT') {
      const opts = Array.from(slotEl.options)
        .filter((o) => o.value !== '' && !/^(pilih|select|--)/i.test(o.text))
        .map((o) => ({ text: o.text.trim(), value: o.value, el: o }));
      const chosen = window.LMSAIClient
        ? window.LMSAIClient.chooseBestSlotOption(opts, cleanExpected, slotIndex, tileLabel)
        : opts[0];
      if (chosen) {
        slotEl.value = chosen.value;
        slotEl.setAttribute('data-filled', 'true');
        slotEl.dispatchEvent(new Event('input', { bubbles: true }));
        slotEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (onLog) {
          await onLog(`Memilih opsi slot dalam blok: "${chosen.text}"`, 'action');
        }
        await this.sleep(delay);
        return true;
      }
    }

    // 2. Jika slot adalah <input> atau [contenteditable]
    if (
      slotEl.tagName === 'INPUT' ||
      slotEl.tagName === 'TEXTAREA' ||
      slotEl.isContentEditable
    ) {
      if (cleanExpected) {
        if (onLog) {
          await onLog(`Mengisi slot dalam blok: "${cleanExpected}"`, 'action');
        }
        await this.fillTextElement(slotEl, cleanExpected, { simulateTyping: false });
        slotEl.setAttribute('data-filled', 'true');
        await this.sleep(delay);
        return true;
      }
    }

    // 3. Slot berupa kotak interaktif `[▪]` yang memunculkan balon pilihan (popover) saat diklik
    let popoverOpts = window.LMSScanner.findPopoverOptionsForTarget(slotEl, null, mainTileIds, editorBoxEl, true);
    if (popoverOpts.length === 0) {
      const beforeSlotClick = new Set(
        window.LMSScanner.queryAllDeep('*').filter((el) => window.LMSScanner.isVisible(el))
      );
      await this.clickElement(slotEl, '#38bdf8');
      await this.sleep(250);
      popoverOpts = window.LMSScanner.findPopoverOptionsForTarget(slotEl, beforeSlotClick, mainTileIds, editorBoxEl, true);
    }

    if (popoverOpts.length > 0) {
      const primaryOpt = window.LMSAIClient
        ? window.LMSAIClient.chooseBestSlotOption(popoverOpts, cleanExpected, slotIndex, tileLabel)
        : popoverOpts[0];
      const orderedOpts = primaryOpt
        ? [primaryOpt, ...popoverOpts.filter((o) => o !== primaryOpt)]
        : popoverOpts;

      for (const candidateOpt of orderedOpts) {
        if (!candidateOpt || !candidateOpt.el || !window.LMSScanner.isVisible(candidateOpt.el)) continue;
        if (onLog) {
          await onLog(`Memilih opsi dalam blok kode: "${candidateOpt.text}"`, 'action');
        }
        await this.clickElement(candidateOpt.el, '#38bdf8');
        await this.sleep(delay);

        // Jika slot sudah terisi dan tidak ditandai salah, berhenti mencoba opsi lain
        if (
          !slotEl.isConnected ||
          (!window.LMSScanner.isSlotUnfilled(slotEl) && !window.LMSScanner.isElementMarkedWrong(slotEl))
        ) {
          if (slotEl.isConnected) {
            slotEl.setAttribute('data-filled', 'true');
          }
          return true;
        }
      }
    }

    // 4. Fallback: cek apakah ada sub-tile atau input inline di dalam container
    return await this.fillSlotOrClickSubTile(containerEl, cleanExpected, config, onLog);
  },

  /**
   * Selesaikan pertanyaan rumpang hasil program (`There are [...] rows of data...` dengan balon pilihan `[2] [34] [35]`)
   * Jika pilihan pertama ditolak/salah, otomatis mencoba opsi berikutnya hingga benar.
   */
  async executeInlineBlanks(scopeEl, pageContext = '', config = {}, onLog = null) {
    const delay = Math.min(Number(config.actionDelay) || 450, 500);
    const simulations = window.LMSScanner.scanSimulations(config.customSelectors || {});
    const allSimTileIds = new Set();
    simulations.forEach((s) => (s.candidateButtons || []).forEach((cb) => allSimTileIds.add(cb.id)));

    let blanks = window.LMSScanner.scanInlineBlanks(
      config.customSelectors || {},
      simulations,
      scopeEl || document
    );

    // Jika dipanggil untuk satu kontainer simulasi dan kalimat `There are [...]` berada di elemen sibling tepat di bawahnya
    if (blanks.length === 0 && scopeEl && scopeEl !== document && scopeEl.nextElementSibling) {
      const nextSib = scopeEl.nextElementSibling;
      const isNextSibAnotherSim = simulations.some((s) => {
        const sEl = window.LMSScanner.getElementById(s.taskId);
        return sEl && (sEl === nextSib || nextSib.contains(sEl));
      });
      if (!isNextSibAnotherSim) {
        blanks = window.LMSScanner.scanInlineBlanks(
          config.customSelectors || {},
          simulations,
          nextSib
        );
      }
    }

    if (blanks.length === 0) return 0;

    // Ekstrak fakta dari hasil yang ditampilkan program setelah `▶ run` dijalankan
    const outputFacts = window.LMSScanner.extractOutputFacts(scopeEl || document);
    let answeredCount = 0;

    for (const blank of blanks) {
      const trigEl = window.LMSScanner.getElementById(blank.blankId);
      if (!trigEl || !window.LMSScanner.isVisible(trigEl)) continue;
      if (!window.LMSScanner.isSlotUnfilled(trigEl) && !window.LMSScanner.isElementMarkedWrong(trigEl)) {
        continue;
      }

      // Jika elemen adalah <select>
      if (trigEl.tagName === 'SELECT') {
        const opts = Array.from(trigEl.options)
          .filter((o) => o.value !== '' && !/^(pilih|select|--|\.\.\.)/i.test(o.text))
          .map((o) => ({ text: o.text.trim(), value: o.value, el: o }));
        const ranked = window.LMSAIClient?.rankInlineBlankOptions
          ? window.LMSAIClient.rankInlineBlankOptions(blank.sentenceContext, opts, outputFacts, pageContext)
          : opts;

        for (const chosen of ranked) {
          trigEl.value = chosen.value;
          trigEl.dispatchEvent(new Event('input', { bubbles: true }));
          trigEl.dispatchEvent(new Event('change', { bubbles: true }));
          if (onLog) {
            await onLog(`Memilih hasil program: "${chosen.text}"`, 'action');
          }
          await this.sleep(delay);
          if (!window.LMSScanner.isElementMarkedWrong(trigEl)) {
            trigEl.setAttribute('data-filled', 'true');
            answeredCount++;
            break;
          }
        }
        continue;
      }

      // Cek apakah balon pilihan (`[2] [34] [35]`) sudah terbuka, jika belum klik `[...]` terlebih dahulu
      let popoverOpts = window.LMSScanner.findPopoverOptionsForTarget(trigEl, null, allSimTileIds, null, false);
      if (popoverOpts.length === 0) {
        const beforeClick = new Set(
          window.LMSScanner.queryAllDeep('*').filter((el) => window.LMSScanner.isVisible(el))
        );
        if (onLog) {
          await onLog(`Membuka pilihan hasil program pada "${blank.sentenceContext.slice(0, 55)}..."`, 'action');
        }
        await this.clickElement(trigEl, '#8b5cf6');
        await this.sleep(260);
        popoverOpts = window.LMSScanner.findPopoverOptionsForTarget(trigEl, beforeClick, allSimTileIds, null, false);
      }

      if (popoverOpts.length > 0) {
        const rankedOpts = window.LMSAIClient?.rankInlineBlankOptions
          ? window.LMSAIClient.rankInlineBlankOptions(
              blank.sentenceContext,
              popoverOpts,
              outputFacts,
              pageContext
            )
          : popoverOpts;

        for (let attemptIdx = 0; attemptIdx < rankedOpts.length; attemptIdx++) {
          let candidateOpt = rankedOpts[attemptIdx];
          if (attemptIdx > 0 && (!candidateOpt.el || !window.LMSScanner.isVisible(candidateOpt.el))) {
            const beforeReopen = new Set(
              window.LMSScanner.queryAllDeep('*').filter((el) => window.LMSScanner.isVisible(el))
            );
            await this.clickElement(trigEl, '#8b5cf6');
            await this.sleep(240);
            const reopenedOpts = window.LMSScanner.findPopoverOptionsForTarget(
              trigEl,
              beforeReopen,
              allSimTileIds,
              null,
              false
            );
            candidateOpt = reopenedOpts.find((o) => o.text === candidateOpt.text) || candidateOpt;
          }

          if (!candidateOpt || !candidateOpt.el || !window.LMSScanner.isVisible(candidateOpt.el)) continue;

          if (onLog) {
            await onLog(
              `Memilih jawaban hasil program: "${candidateOpt.text}" (${blank.sentenceContext.replace('___', `[${candidateOpt.text}]`).slice(0, 65)})`,
              'action'
            );
          }
          await this.clickElement(candidateOpt.el, '#10b981');
          await this.sleep(delay);

          const stillUnfilled = window.LMSScanner.isSlotUnfilled(trigEl);
          const markedWrong =
            window.LMSScanner.isElementMarkedWrong(trigEl) ||
            (candidateOpt.el.isConnected && window.LMSScanner.isElementMarkedWrong(candidateOpt.el));

          if (!stillUnfilled && !markedWrong) {
            trigEl.setAttribute('data-filled', 'true');
            answeredCount++;
            break;
          }

          if (onLog && attemptIdx + 1 < rankedOpts.length) {
            await onLog(
              `Pilihan "${candidateOpt.text}" belum tepat, mencoba opsi hasil program berikutnya...`,
              'warn'
            );
          }
        }
      }
    }

    return answeredCount;
  },

  /**
   * Jalankan 1 siklus penyusunan blok program, pengisian slot `[▪]`, dan eksekusi tombol `▶ run`
   */
  async runSingleSimulationAttempt(simScan, simSolution, config, onLog) {
    const delay = Number(config.actionDelay) || 600;
    const programWait = Number(config.programWaitTime || config.programWaitTimeout) || 1800;
    const sequenceIds = simSolution?.sequenceIds || [];
    const sequenceLabels = simSolution?.sequenceLabels || [];
    const tileSlotMap = simSolution?.tileSlotMap || {};
    const slotValues = [...(simSolution?.slotValues || [])];
    let globalSlotCursor = 0;

    const containerEl = window.LMSScanner.getElementById(simScan.taskId);
    const editorBoxEl = simScan.editorDropzoneId
      ? window.LMSScanner.getElementById(simScan.editorDropzoneId)
      : null;

    const mainTileIds = new Set((simScan.candidateButtons || []).map((b) => b.id));
    const runButtonId =
      simSolution?.runButtonId ||
      (simScan.runButtons && simScan.runButtons[0] ? simScan.runButtons[0].id : null);

    // Langkah A: Pilih setiap blok program secara berurutan & selesaikan pilihan di dalam blok program (`[▪]`)
    for (let i = 0; i < sequenceIds.length; i++) {
      const btnId = sequenceIds[i];
      const expectedLabel = sequenceLabels[i] || '';
      let btnEl = window.LMSScanner.getElementById(btnId);

      // Jika DOM di-render ulang / diacak ulang oleh LMS, cari ulang berdasarkan label
      if ((!btnEl || !btnEl.isConnected || !window.LMSScanner.isVisible(btnEl)) && containerEl && expectedLabel) {
        const refreshedTiles = window.LMSScanner.collectCandidateTiles(
          containerEl,
          [],
          config.customSelectors || {}
        );
        const match = refreshedTiles.find(
          (t) => !t.isAlreadySelected && (t.label === expectedLabel || t.rawLabel === expectedLabel)
        );
        if (match) {
          btnEl = window.LMSScanner.getElementById(match.id);
        }
      }

      if (!btnEl) continue;

      const label = expectedLabel || window.LMSScanner.cleanText(btnEl.innerText || btnEl.value || btnId);
      const slotsForThisTile =
        tileSlotMap[btnId] ||
        (label.includes('___') ? slotValues.slice(globalSlotCursor, globalSlotCursor + (label.split('___').length - 1)) : []);
      const hadSlotsInTile =
        slotsForThisTile.length > 0 ||
        window.LMSScanner.findUnfilledSlotsInScope(btnEl).length > 0;

      const isAlreadyActive =
        btnEl.classList.contains('active') ||
        btnEl.classList.contains('selected') ||
        btnEl.classList.contains('used') ||
        btnEl.getAttribute('aria-pressed') === 'true' ||
        btnEl.getAttribute('data-selected') === 'true';

      if (!isAlreadyActive) {
        if (onLog) {
          await onLog(`Memilih blok program (${i + 1}/${sequenceIds.length}): "${label}"`, 'action');
        }

        const beforeTileClick = new Set(
          window.LMSScanner.queryAllDeep('*').filter((el) => window.LMSScanner.isVisible(el))
        );
        const editorTextBefore = editorBoxEl ? editorBoxEl.innerText : '';

        // 1. Klik blok program terlebih dahulu
        await this.clickElement(btnEl, '#f59e0b');
        await this.sleep(Math.min(delay, 260));

        // Jika elemen mendukung drag-and-drop dan klik biasa belum memindahkannya ke editor
        if (
          editorBoxEl &&
          btnEl.isConnected &&
          window.LMSScanner.isVisible(btnEl) &&
          !btnEl.classList.contains('active') &&
          !btnEl.classList.contains('selected') &&
          !btnEl.classList.contains('used') &&
          editorBoxEl.innerText === editorTextBefore &&
          btnEl.getAttribute('draggable') === 'true'
        ) {
          await this.dragAndDropElement(btnEl, editorBoxEl);
          await this.sleep(220);
        }

        // 2. Cek apakah di dalam blok program ini ada pilihan lagi (slot `[▪]`)
        if (hadSlotsInTile) {
          let resolvedSlotsForTile = 0;

          // 2a. Cek apakah saat blok diklik, balon popover pilihan untuk slot pertama langsung terbuka
          const immediatePopoverOpts = window.LMSScanner.findPopoverOptionsForTarget(
            btnEl,
            beforeTileClick,
            mainTileIds,
            editorBoxEl,
            true
          );
          if (immediatePopoverOpts.length > 0) {
            const expVal = slotsForThisTile[0] || slotValues[globalSlotCursor] || '';
            const chosen = window.LMSAIClient
              ? window.LMSAIClient.chooseBestSlotOption(immediatePopoverOpts, expVal, 0, label)
              : immediatePopoverOpts[0];
            if (chosen && chosen.el) {
              if (onLog) {
                await onLog(`Memilih opsi dalam blok kode: "${chosen.text}"`, 'action');
              }
              await this.clickElement(chosen.el, '#38bdf8');
              resolvedSlotsForTile++;
              globalSlotCursor++;
              await this.sleep(240);
            }
          }

          // 2b. Cari slot `[▪]` yang masih belum terisi (utamakan di dalam editorBoxEl jika blok sudah masuk ke editor)
          const expectedSlotCount = Math.max(slotsForThisTile.length, 1);
          for (let sAttempt = resolvedSlotsForTile; sAttempt < expectedSlotCount; sAttempt++) {
            const slotsInEditor = editorBoxEl
              ? window.LMSScanner.findUnfilledSlotsInScope(editorBoxEl)
              : [];
            const tileMovedToEditor =
              btnEl.classList.contains('used') ||
              btnEl.classList.contains('active') ||
              btnEl.classList.contains('selected') ||
              (editorBoxEl && editorBoxEl.innerText !== editorTextBefore);

            const slotsInBtn =
              !tileMovedToEditor && btnEl.isConnected && window.LMSScanner.isVisible(btnEl)
                ? window.LMSScanner.findUnfilledSlotsInScope(btnEl)
                : [];
            const targetSlotEl = slotsInEditor[0] || slotsInBtn[0];
            if (!targetSlotEl) break;

            const expVal =
              slotsForThisTile[sAttempt] ||
              slotValues[globalSlotCursor] ||
              slotsForThisTile[slotsForThisTile.length - 1] ||
              '';

            const filled = await this.resolveSlotElement(
              targetSlotEl,
              expVal,
              sAttempt,
              label,
              containerEl,
              mainTileIds,
              editorBoxEl,
              config,
              onLog
            );
            if (filled) {
              resolvedSlotsForTile++;
              globalSlotCursor++;
            } else {
              break;
            }
          }

          // 2c. Jika slot diisi di dalam blok bawah dan bloknya belum pindah ke editorBoxEl, klik bloknya sekali lagi agar masuk ke editor
          if (
            btnEl.isConnected &&
            window.LMSScanner.isVisible(btnEl) &&
            !btnEl.classList.contains('used') &&
            !btnEl.classList.contains('active') &&
            !btnEl.classList.contains('selected') &&
            window.LMSScanner.findUnfilledSlotsInScope(btnEl).length === 0
          ) {
            await this.clickElement(btnEl, '#f59e0b');
            await this.sleep(220);
          }
        }

        await this.sleep(Math.min(delay, 350));
      }
    }

    // Langkah A-2 (Adaptive Pass): Jika LMS menolak klik blok pertama karena urutan ketat (sehingga sebagian blok belum masuk ke editor),
    // klik ulang blok yang belum masuk ke dalam editor sebelum menekan `▶ run`
    if (editorBoxEl && containerEl && simScan?.taskType === 'code-builder') {
      for (let extraPass = 0; extraPass < 2; extraPass++) {
        const placement = window.LMSScanner.areCodeBlocksInsideEditor(simScan, editorBoxEl);
        if (placement.allPlaced) break;

        const editorTextNow = window.LMSScanner.cleanText(editorBoxEl.innerText || '');
        for (let i = 0; i < sequenceIds.length; i++) {
          const btnId = sequenceIds[i];
          const expectedLabel = sequenceLabels[i] || '';
          const fragments = expectedLabel
            .split('___')
            .map((s) => window.LMSScanner.cleanText(s))
            .filter((s) => s.length >= 2)
            .sort((a, b) => b.length - a.length);
          const keyFrag = fragments[0] || '';
          if (keyFrag && editorTextNow.includes(keyFrag)) continue;

          const btnEl = window.LMSScanner.getElementById(btnId);
          if (!btnEl || !btnEl.isConnected || !window.LMSScanner.isVisible(btnEl)) continue;

          await this.clickElement(btnEl, '#f59e0b');
          await this.sleep(Math.min(delay, 260));

          const slotsForThisTile = tileSlotMap[btnId] || [];
          const unfilledNow = window.LMSScanner.findUnfilledSlotsInScope(editorBoxEl);
          for (let sIdx = 0; sIdx < unfilledNow.length; sIdx++) {
            const expVal = slotsForThisTile[sIdx] || slotValues[globalSlotCursor++] || '';
            await this.resolveSlotElement(
              unfilledNow[sIdx],
              expVal,
              sIdx,
              expectedLabel,
              containerEl,
              mainTileIds,
              editorBoxEl,
              config,
              onLog
            );
          }
        }
      }
    }

    // Langkah B: Pastikan tidak ada lagi slot `[▪]` yang masih kosong di dalam editor sebelum menjalankan `▶ run`
    if (editorBoxEl) {
      const leftoverSlots = window.LMSScanner.findUnfilledSlotsInScope(editorBoxEl);
      for (let k = 0; k < leftoverSlots.length; k++) {
        const expVal = slotValues[globalSlotCursor++] || '';
        await this.resolveSlotElement(
          leftoverSlots[k],
          expVal,
          k,
          '',
          containerEl,
          mainTileIds,
          editorBoxEl,
          config,
          onLog
        );
      }
    }

    // Langkah C: Setelah semua blok program dan pilihan di dalamnya selesai dipilih, BARU jalankan tombol `▶ run`!
    let runEl = runButtonId ? window.LMSScanner.getElementById(runButtonId) : null;
    if ((!runEl || !runEl.isConnected) && containerEl) {
      const potentialRuns = window.LMSScanner.queryAllDeep(
        'button, [role="button"], input[type="button"], a, div, span',
        containerEl
      ).filter((el) => window.LMSScanner.isRunButtonElement(el, config.customSelectors || {}));
      if (potentialRuns.length > 0) {
        runEl = potentialRuns[0];
      }
    }

    const outputEl = simScan.outputId ? window.LMSScanner.getElementById(simScan.outputId) : containerEl;
    if (runEl) {
      const runLabel = window.LMSScanner.cleanText(runEl.innerText || runEl.value || '▶ run');
      if (onLog) {
        await onLog(`Menjalankan program: klik tombol "${runLabel}"`, 'action');
      }
      await this.clickElement(runEl, '#10b981');

      // Tunggu program selesai berjalan dan menampilkan outputnya
      await this.waitForProgramCompletion(outputEl, programWait);
    }

    // Verifikasi terlebih dahulu apakah eksekusi blok program (`▶ run`) berhasil tanpa error/reset
    const codeExecStatus = window.LMSScanner.evaluateSimulationStatus(
      simScan,
      containerEl,
      editorBoxEl,
      outputEl,
      config.customSelectors || {},
      false,
      true
    );
    if (!codeExecStatus.ok) {
      return codeExecStatus;
    }

    // Langkah D: Hanya jika `▶ run` berhasil, selesaikan pilihan untuk hasil yang ditampilkan program (`There are [...] rows of data...`)
    await this.sleep(260);
    await this.executeInlineBlanks(containerEl || document, simScan.instruction || '', config, onLog);

    return window.LMSScanner.evaluateSimulationStatus(
      simScan,
      containerEl,
      editorBoxEl,
      outputEl,
      config.customSelectors || {},
      false,
      false
    );
  },

  /**
   * 1. Eksekusi Tugas Simulasi & Code-Builder dengan Verifikasi Kebenaran & Retry Otomatis:
   *    Jika hasil eksekusi SALAH / di-reset oleh LMS, sistem TIDAK menganggapnya selesai,
   *    melainkan mencoba memperbaiki urutan/opsi terlebih dahulu dan melaporkan status sebenarnya.
   */
  async executeSimulation(simScan, simSolution, config, onLog) {
    const containerEl = window.LMSScanner.getElementById(simScan.taskId);
    let statusEval = await this.runSingleSimulationAttempt(simScan, simSolution, config, onLog);

    // Jika percobaan pertama salah / belum lengkap, lakukan 1x percobaan perbaikan otomatis (misal tukar urutan import / opsi)
    if (!statusEval.ok && containerEl) {
      if (onLog) {
        await onLog(
          `Simulasi belum tepat (${statusEval.reason}). Mencoba memperbaiki urutan/opsi...`,
          'warn'
        );
      }

      // Jika blok belum di-reset otomatis oleh LMS, tekan tombol Reset jika tersedia
      if (!statusEval.isReset) {
        const resetBtn = window.LMSScanner.findResetButtonInContainer(containerEl);
        if (resetBtn) {
          await this.clickElement(resetBtn, '#ef4444');
          await this.sleep(350);
        }
      }

      // Pindai ulang kandidat tombol/blok terbaru di dalam containerEl
      const refreshedSims = window.LMSScanner.scanSimulations(config.customSelectors || {});
      const refreshedScan =
        refreshedSims.find((s) => s.taskId === simScan.taskId) || refreshedSims[0] || simScan;

      if (window.LMSAIClient?.buildAlternativeSimulationSolution) {
        const altSolution = window.LMSAIClient.buildAlternativeSimulationSolution(
          refreshedScan,
          simSolution,
          { moduleContext: simScan.instruction || '' }
        );
        statusEval = await this.runSingleSimulationAttempt(refreshedScan, altSolution, config, onLog);
      }
    }

    if (statusEval.ok) {
      if (containerEl) {
        containerEl.setAttribute('data-lms-completed', 'true');
      }
      const editorBoxEl = simScan.editorDropzoneId
        ? window.LMSScanner.getElementById(simScan.editorDropzoneId)
        : null;
      if (editorBoxEl) {
        editorBoxEl.setAttribute('data-lms-completed', 'true');
      }
      for (const rb of simScan.runButtons || []) {
        const rbEl = window.LMSScanner.getElementById(rb.id);
        if (rbEl) rbEl.setAttribute('data-lms-completed', 'true');
      }
      const outputEl = simScan.outputId ? window.LMSScanner.getElementById(simScan.outputId) : containerEl;
      const outPreview = outputEl
        ? window.LMSScanner.cleanText(outputEl.innerText).slice(0, 90)
        : 'Eksekusi berhasil';
      if (onLog) {
        await onLog(`Program berhasil dijalankan & terverifikasi: ${outPreview}`, 'success');
      }
      return { ok: true, reason: statusEval.reason };
    }

    if (onLog) {
      await onLog(`Simulasi belum tepat / gagal: ${statusEval.reason}`, 'error');
    }
    return { ok: false, reason: statusEval.reason };
  },

  /**
   * Tunggu hingga output program muncul / berhenti berubah atau batas waktu tercapai
   */
  waitForProgramCompletion(outputEl, maxWaitMs = 1800) {
    return new Promise((resolve) => {
      if (!outputEl) {
        setTimeout(resolve, Math.min(maxWaitMs, 600));
        return;
      }

      const isLoadingText = (txt) =>
        /\b(running|menjalankan|mengekseskusi|mengeksekusi|loading|waiting)\b/i.test(txt) &&
        !/\b(berhasil|sukses|success|selesai|completed|passed|dataframe|100%|error|incorrect|wrong|gagal)\b/i.test(txt);

      let settledTimer = null;
      const maxTimer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, maxWaitMs);

      const scheduleResolveIfSettled = (delayMs = 380) => {
        const currentTxt = (outputEl.innerText || '').toLowerCase();
        if (!isLoadingText(currentTxt)) {
          clearTimeout(settledTimer);
          settledTimer = setTimeout(() => {
            clearTimeout(maxTimer);
            observer.disconnect();
            resolve();
          }, delayMs);
        }
      };

      const observer = new MutationObserver(() => {
        scheduleResolveIfSettled(350);
      });

      observer.observe(outputEl, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true
      });

      // Jika perubahan output sudah terjadi secara sinkron tepat saat tombol Run diklik
      scheduleResolveIfSettled(480);
    });
  },

  /**
   * Ambil snapshot gaya visual elemen opsi PG sebelum diklik (untuk mendeteksi apakah klik berhasil mengubah status opsi)
   */
  getOptionStyleSnapshot(...elements) {
    return elements.map((el) => {
      if (!el || el.nodeType !== 1) return '';
      const win = el.ownerDocument?.defaultView || window;
      const st = win.getComputedStyle(el);
      return [
        el.className || '',
        el.getAttribute('aria-checked') || '',
        el.getAttribute('aria-selected') || '',
        el.getAttribute('data-selected') || '',
        el.checked ? '1' : '0',
        st.backgroundColor || '',
        st.borderColor || '',
        st.color || '',
        st.boxShadow || ''
      ].join('|');
    });
  },

  /**
   * 2. Eksekusi Soal Pilihan Ganda (termasuk opsi baris kode, lencana A/B/C/D, tombol Check lokal per-soal, & retry otomatis)
   * PENTING: Pada halaman Assessment multi-soal (misal 9 soal), JANGAN pernah menekan tombol Submit utama sebelum ke-9 soal selesai dijawab!
   */
  async executeMCQ(mcqScan, mcqSolution, config, onLog) {
    const delay = Number(config.actionDelay) || 600;
    const selectedIds = mcqSolution?.selectedOptionIds || [];
    if (selectedIds.length === 0) return false;

    const qAnchor = window.LMSScanner.getElementById(mcqScan.questionId);

    // Untuk soal dropdown `<select>` (seperti pada Canvas Pre-Course Survey / Matching Question)
    if (mcqScan.inputType === 'select' && qAnchor && qAnchor.tagName === 'SELECT') {
      const chosenOptObj =
        (mcqScan.options || []).find((o) => o.id === selectedIds[0]) || (mcqScan.options || [])[0];
      if (!chosenOptObj) return false;

      await this.scrollIntoViewSafe(qAnchor);
      this.highlightElement(qAnchor, '#3b82f6', 850);
      if (onLog) {
        await onLog(`Memilih dropdown PG: "${chosenOptObj.text.slice(0, 65)}"`, 'action');
      }

      const win = qAnchor.ownerDocument?.defaultView || window;
      const Ev = win.Event || Event;
      qAnchor.value = chosenOptObj.selectValue ?? chosenOptObj.text;
      qAnchor.dispatchEvent(new Ev('input', { bubbles: true }));
      qAnchor.dispatchEvent(new Ev('change', { bubbles: true }));
      qAnchor.setAttribute('data-lms-completed', 'true');
      await this.sleep(Math.min(delay, 350));
      return true;
    }

    // Untuk soal multi-select (checkbox atau soal dengan instruksi "Select TWO" / "Choose two"), klik semua opsi terpilih
    if (selectedIds.length > 1) {
      for (const optId of selectedIds) {
        const optEl = window.LMSScanner.getElementById(optId);
        if (!optEl) continue;
        const optObj = (mcqScan.options || []).find((o) => o.id === optId);
        const optLabel = optObj ? optObj.text.slice(0, 65) : optId;
        if (onLog) {
          await onLog(`Memilih jawaban PG: "${optLabel}"`, 'action');
        }
        await this.clickElement(optEl, '#3b82f6');
        await this.sleep(Math.min(delay, 450));
      }
      if (config.autoSubmit !== false && qAnchor) {
        const localSub = this.findLocalQuestionSubmitButton(qAnchor);
        if (localSub) {
          localSub.setAttribute('data-lms-completed', 'true');
          await this.clickElement(localSub, '#10b981');
          await this.sleep(Math.min(delay, 450));
        }
      }
      if (qAnchor) {
        qAnchor.setAttribute('data-lms-completed', 'true');
      }
      return true;
    }

    // Untuk soal single-choice (radio / kartu opsi / baris kode): siapkan urutan kandidat untuk auto-retry jika LMS memberi feedback salah langsung
    const allOptIds = (mcqScan.options || []).map((o) => o.id);
    const rankedIds = Array.isArray(mcqSolution?.rankedOptionIds) && mcqSolution.rankedOptionIds.length > 0
      ? mcqSolution.rankedOptionIds
      : [...selectedIds, ...allOptIds.filter((id) => !selectedIds.includes(id))];

    for (let attempt = 0; attempt < rankedIds.length; attempt++) {
      const optId = rankedIds[attempt];
      const optObj = (mcqScan.options || []).find((o) => o.id === optId);
      const optEl = window.LMSScanner.getElementById(optId);
      const badgeEl = optObj?.badgeId ? window.LMSScanner.getElementById(optObj.badgeId) : null;
      const rowEl = optObj?.rowId ? window.LMSScanner.getElementById(optObj.rowId) : null;

      const primaryTarget =
        (optEl && window.LMSScanner.isVisible(optEl) && optEl) ||
        (rowEl && window.LMSScanner.isVisible(rowEl) && rowEl) ||
        (badgeEl && window.LMSScanner.isVisible(badgeEl) && badgeEl);

      if (!primaryTarget) continue;

      const optLabel = optObj ? optObj.text.slice(0, 65) : optId;

      if (onLog) {
        await onLog(`Memilih jawaban PG: "${optLabel}"`, 'action');
      }

      const beforeSnap = this.getOptionStyleSnapshot(primaryTarget, rowEl, badgeEl);

      await this.clickElement(primaryTarget, '#3b82f6');
      await this.sleep(150);

      const checkSelectionRegistered = () => {
        if (
          window.LMSScanner.isOptionElementSelected(primaryTarget) ||
          (rowEl && window.LMSScanner.isOptionElementSelected(rowEl)) ||
          (badgeEl && window.LMSScanner.isOptionElementSelected(badgeEl))
        ) {
          return true;
        }
        const nowSnap = this.getOptionStyleSnapshot(primaryTarget, rowEl, badgeEl);
        return nowSnap.some((s, idx) => s && s !== beforeSnap[idx]);
      };

      // Jika klik pada kotak kode (primaryTarget) belum mengubah status/gaya visual karena event listener ada pada lencana (A/B/C/D) atau rowEl,
      // klik juga rowEl dan badgeEl!
      if (!checkSelectionRegistered()) {
        if (rowEl && rowEl !== primaryTarget && window.LMSScanner.isVisible(rowEl)) {
          await this.clickElement(rowEl, '#3b82f6');
          await this.sleep(120);
        }
        if (!checkSelectionRegistered() && badgeEl && badgeEl !== primaryTarget && window.LMSScanner.isVisible(badgeEl)) {
          await this.clickElement(badgeEl, '#3b82f6');
          await this.sleep(120);
        }
      }

      // Tandai elemen opsi sebagai terpilih agar pelacakan konsisten
      primaryTarget.setAttribute('data-lms-selected', 'true');
      if (rowEl) rowEl.setAttribute('data-lms-selected', 'true');

      await this.sleep(Math.min(delay, 350));

      // Hanya klik tombol Check lokal jika ini kartu soal tunggal (BUKAN halaman Assessment multi-soal!)
      if (config.autoSubmit !== false && qAnchor) {
        const localSub = this.findLocalQuestionSubmitButton(qAnchor);
        if (localSub && !localSub.disabled) {
          await this.clickElement(localSub, '#10b981');
          await this.sleep(Math.min(delay, 450));
        }
      }

      // Cek apakah opsi yang baru dipilih langsung ditandai salah (incorrect / merah) oleh LMS
      const singleCard = this.findSingleQuestionCard(qAnchor);
      const isOptionWrong =
        window.LMSScanner.isElementMarkedWrong(primaryTarget) ||
        (rowEl && window.LMSScanner.isElementMarkedWrong(rowEl)) ||
        (badgeEl && window.LMSScanner.isElementMarkedWrong(badgeEl)) ||
        Boolean(
          singleCard &&
            singleCard.querySelector(
              '.is-incorrect, .incorrect, .is-wrong, .wrong-answer, [data-correct="false"]'
            )
        );

      if (!isOptionWrong) {
        if (config.autoSubmit !== false && qAnchor) {
          const localSub = this.findLocalQuestionSubmitButton(qAnchor);
          if (localSub) localSub.setAttribute('data-lms-completed', 'true');
        }
        if (qAnchor) {
          qAnchor.setAttribute('data-lms-completed', 'true');
        }
        return true;
      }

      // Jika ditandai salah dan masih ada opsi berikutnya, klik tombol Try Again / Reset di dalam kartu soal jika ada
      if (singleCard && attempt + 1 < rankedIds.length) {
        const retryBtn = window.LMSScanner.findResetButtonInContainer(singleCard);
        if (retryBtn) {
          await this.clickElement(retryBtn, '#f59e0b');
          await this.sleep(300);
        }
      }
    }

    if (qAnchor) {
      qAnchor.setAttribute('data-lms-completed', 'true');
    }
    return true;
  },

  /**
   * Cari kontainer kartu yang HANYA membungkus 1 soal ini saja (bukan kontainer Assessment yang membungkus banyak soal)
   */
  findSingleQuestionCard(qAnchor) {
    if (!qAnchor || qAnchor.nodeType !== 1) return null;
    let card = null;
    let curr = qAnchor.parentElement;
    for (let d = 0; d < 4 && curr; d++) {
      if (curr.tagName === 'BODY' || curr.tagName === 'MAIN' || curr.tagName === 'HTML') break;
      const qAnchorsInside = curr.querySelectorAll('[data-lms-question-id]').length;
      if (qAnchorsInside > 1) break;
      const txt = window.LMSScanner ? window.LMSScanner.cleanText(curr.innerText || '') : '';
      if (/\(\s*\d+\s*questions?\s*\)/i.test(txt)) break;
      if (/\b1\s*[\.\)]\s+\S[\s\S]*\b2\s*[\.\)]\s+\S/.test(txt)) break;
      card = curr;
      curr = curr.parentElement;
    }
    return card;
  },

  /**
   * Cari tombol Check lokal yang khusus berada di dalam satu kartu soal tunggal.
   * PENTING: Jangan pernah mengembalikan tombol Submit milik halaman Assessment multi-soal (seperti "Coding for Answers Assessment (9 questions)")!
   */
  findLocalQuestionSubmitButton(qAnchor) {
    if (!qAnchor) return null;
    // Jika di halaman terdapat > 1 soal pilihan ganda, JANGAN klik tombol Submit di tengah jalan (biarkan Step 4 di autopilot.js yang melakukan Submit setelah semua soal dijawab!)
    const totalQuestionsOnPage = window.LMSScanner
      ? window.LMSScanner.queryAllDeep('[data-lms-question-id]').length
      : document.querySelectorAll('[data-lms-question-id]').length;

    const singleCard = this.findSingleQuestionCard(qAnchor);
    if (!singleCard) return null;

    const radioGroupsInside = new Set(
      Array.from(singleCard.querySelectorAll('input[type="radio"]'))
        .map((r) => r.name)
        .filter(Boolean)
    );
    if (radioGroupsInside.size > 1) return null;
    if (singleCard.querySelectorAll('textarea').length > 0) return null;

    // Jika ada lebih dari 1 soal di halaman, hanya izinkan tombol "Check / Periksa / Verify" lokal (bukan "Submit")
    const checkOnlyRegex = /^(?:check|periksa|verify|verifikasi)$|\b(check\s*answer|periksa\s*jawaban)\b/i;
    const submitOrCheckRegex =
      /^(?:submit|kirim|check|periksa|verify|verifikasi)$|\b(kirim\s*jawaban|submit\s*answer|check\s*answer|periksa\s*jawaban)\b/i;
    const targetRegex = totalQuestionsOnPage > 1 ? checkOnlyRegex : submitOrCheckRegex;
    const nextRegex = /\b(next|selanjutnya|berikutnya|lanjut|continue)\b/i;

    const btns = Array.from(
      singleCard.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
    ).filter((b) => window.LMSScanner.isVisible(b) && !b.disabled);

    if (btns.some((b) => nextRegex.test(window.LMSScanner.cleanText(b.innerText || b.value || '')))) {
      return null;
    }

    const anchorRect = qAnchor.getBoundingClientRect();
    return (
      btns.find((b) => {
        const bRect = b.getBoundingClientRect();
        // Pastikan tombol berada di dekat soal ini (tidak jauh di paling bawah halaman 9 soal)
        if (bRect.top - anchorRect.bottom > 340) return false;
        const txt = window.LMSScanner.cleanText(b.innerText || b.value || b.getAttribute('aria-label') || '');
        return targetRegex.test(txt);
      }) || null
    );
  },

  /**
   * 3. Eksekusi Soal Esai / Isian Teks (beserta tombol Submit lokal untuk esai tersebut jika ada)
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
    el.setAttribute('data-lms-completed', 'true');

    const delay = Number(config.actionDelay) || 500;
    await this.sleep(delay);

    // Cari apakah ada tombol Submit lokal khusus untuk esai ini (seperti pada NetAcad di mana tiap esai punya tombol Submit sendiri untuk membuka langkah berikutnya)
    if (config.autoSubmit !== false) {
      const localSubmitBtn = this.findLocalEssaySubmitButton(el);
      if (localSubmitBtn && !localSubmitBtn.disabled && localSubmitBtn.getAttribute('data-lms-completed') !== 'true') {
        const subLabel = window.LMSScanner.cleanText(
          localSubmitBtn.innerText || localSubmitBtn.value || 'Submit'
        );
        if (onLog) {
          await onLog(`Menekan tombol Submit esai: "${subLabel}"`, 'action');
        }
        localSubmitBtn.setAttribute('data-lms-completed', 'true');
        await this.clickElement(localSubmitBtn, '#10b981');
        await this.sleep(delay + 350);
      }
    }

    return true;
  },

  /**
   * Cari tombol Submit yang berada tepat di dekat elemen esai (<textarea>)
   */
  findLocalEssaySubmitButton(essayEl) {
    if (!essayEl) return null;
    const submitRegex =
      /^(?:submit|kirim|send|save|simpan|check|periksa|done|selesai)$|\b(kirim\s*jawaban|submit\s*answer|submit\s*response|simpan\s*jawaban|check\s*answer)\b/i;

    // 1. Cek di dalam kontainer soal terdekat (maksimal 3 level ke atas, asalkan tidak mencakup seluruh halaman)
    let curr = essayEl.parentElement;
    for (let depth = 0; depth < 3 && curr; depth++) {
      const tag = (curr.tagName || '').toUpperCase();
      if (tag === 'BODY' || tag === 'HTML' || tag === 'MAIN') break;

      const btns = Array.from(
        curr.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a.btn')
      ).filter(
        (b) =>
          window.LMSScanner.isVisible(b) &&
          !b.disabled &&
          b.getAttribute('data-lms-completed') !== 'true' &&
          !window.LMSScanner.isRunButtonElement(b)
      );

      const match = btns.find((b) => {
        const txt = window.LMSScanner.cleanText(b.innerText || b.value || b.getAttribute('aria-label') || '');
        return submitRegex.test(txt);
      });

      if (match) {
        const eRect = essayEl.getBoundingClientRect();
        const bRect = match.getBoundingClientRect();
        if (bRect.top >= eRect.top - 20 && bRect.top - eRect.bottom <= 180) {
          return match;
        }
      }

      curr = curr.parentElement;
    }

    return null;
  },

  /**
   * 4. Selesaikan Materi Video (`<video>` HTML5 / Video.js / JWPlayer pada modul AWS Skill Builder, Canvas, Coursera, dll.)
   *    Memutar, mempercepat (`playbackRate = 16`), dan memajukan progres ke akhir durasi (`ended`) agar modul video tercentang selesai!
   */
  async executeVideo(videoScan, config, onLog) {
    const v = window.LMSScanner.getElementById(videoScan.videoId);
    if (!v || v.tagName !== 'VIDEO') return false;

    if (onLog) {
      await onLog('Memproses penyelesaian materi video pada modul...', 'action');
    }

    await this.scrollIntoViewSafe(v);
    this.highlightElement(v, '#f59e0b', 1000);

    try {
      v.muted = true;
      try {
        v.playbackRate = 16;
      } catch {
        try {
          v.playbackRate = 4;
        } catch {}
      }

      // Coba klik tombol Play overlay (seperti .vjs-big-play-button pada Video.js di AWS Skill Builder) jika video masih paused
      if (v.paused) {
        const container = v.parentElement?.parentElement || v.parentElement;
        if (container) {
          const playBtn = container.querySelector(
            '.vjs-big-play-button, .vjs-play-control, [aria-label*="Play" i], button[title*="Play" i]'
          );
          if (playBtn && window.LMSScanner.isVisible(playBtn)) {
            await this.clickElement(playBtn, '#f59e0b');
            await this.sleep(250);
          }
        }
        try {
          await v.play();
        } catch {}
      }

      await this.sleep(350);

      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const win = v.ownerDocument?.defaultView || window;
      const Ev = win.Event || Event;

      if (dur > 1) {
        // Majukan ke 99% terlebih dahulu agar LMS mencatat timeupdate menjelang akhir, lalu ke akhir durasi
        try {
          v.currentTime = Math.max(0, dur - 0.4);
          v.dispatchEvent(new Ev('timeupdate', { bubbles: true }));
          await this.sleep(300);
          v.currentTime = dur;
        } catch {}
      }

      v.dispatchEvent(new Ev('timeupdate', { bubbles: true }));
      v.dispatchEvent(new Ev('ended', { bubbles: true }));
    } catch {
      // Abaikan jika pemutar video membatasi manipulasi properti
    }

    v.setAttribute('data-lms-completed', 'true');
    await this.sleep(350);
    return true;
  },

  /**
   * Ekstrak kredensial sementara AWS CLI (`aws_access_key_id`, `aws_secret_access_key`, `aws_session_token`)
   * dari panel / modal `AWS Details` -> `Show` pada Vocareum Workbench.
   */
  async extractVocareumAwsCredentials(awsDetailsBtnId = null, clickDetailsIfNeeded = true) {
    const parseCredsFromDom = () => {
      const nodes = window.LMSScanner.queryAllDeep('pre, code, textarea, input, div, span, p');
      for (const el of nodes) {
        const raw = `${el.value || ''}\n${el.innerText || ''}\n${el.textContent || ''}`;
        if (!/aws_access_key_id/i.test(raw)) continue;
        const idMatch = raw.match(/aws_access_key_id\s*[=:]\s*([A-Z0-9]{16,40})/i);
        const secMatch = raw.match(/aws_secret_access_key\s*[=:]\s*([A-Za-z0-9/+=]{20,120})/i);
        const tokMatch = raw.match(/aws_session_token\s*[=:]\s*([A-Za-z0-9/+=._-]{40,2500})/i);
        if (idMatch && secMatch) {
          return {
            accessKeyId: idMatch[1].trim(),
            secretAccessKey: secMatch[1].trim(),
            sessionToken: tokMatch ? tokMatch[1].trim() : ''
          };
        }
      }
      return null;
    };

    let creds = parseCredsFromDom();
    if (creds) return creds;

    if (!clickDetailsIfNeeded) return null;

    const findShowCliBtns = () =>
      window.LMSScanner.queryAllDeep('button, a, input[type="button"], [role="button"], span').filter((el) => {
        if (!window.LMSScanner.isVisible(el)) return false;
        const txt = window.LMSScanner.cleanText(el.innerText || el.value || '');
        return /^show(?:\s+aws\s+cli)?$/i.test(txt);
      });

    // 1. Hanya klik tombol "AWS Details" di toolbar atas jika tombol "Show" (AWS CLI) belum terlihat di layar
    let showBtns = findShowCliBtns();
    if (showBtns.length === 0) {
      const detailsBtn =
        (awsDetailsBtnId && window.LMSScanner.getElementById(awsDetailsBtnId)) ||
        window.LMSScanner.queryAllDeep('button, a, [role="button"], span').find(
          (el) =>
            window.LMSScanner.isVisible(el) &&
            /^aws\s+details$/i.test(window.LMSScanner.cleanText(el.innerText || ''))
        );

      if (detailsBtn && window.LMSScanner.isVisible(detailsBtn)) {
        await this.clickElement(detailsBtn, '#0284c7');
        await this.sleep(650);
      }
      creds = parseCredsFromDom();
      if (creds) return creds;
      showBtns = findShowCliBtns();
    }

    // 2. Klik tombol "Show" di sebelah "AWS CLI:" di dalam panel AWS Details
    for (const sBtn of showBtns.slice(0, 3)) {
      await this.clickElement(sBtn, '#0284c7');
      await this.sleep(550);
      creds = parseCredsFromDom();
      if (creds) return creds;
    }

    return parseCredsFromDom();
  },

  /**
   * 5. Pelajari Seluruh Instruksi Lab & Jalankan Seluruh Instruksi pada Vocareum Workbench (`labs.vocareum.com`)
   *    Alur:
   *    1) Scroll & pelajari semua instruksi di dalam Lab (`Lab Overview`, `Topics covered`, `Task 1`..`Task N`, parameter & kode)
   *    2) Klik `Start Lab` (jika belum berjalan) dan tunggu hingga status `AWS` siap (`AWS 🟢` & kredensial tersedia)
   *    3) Ambil kredensial sesi Lab dari `AWS Details` -> `Show`
   *    4) Eksekusi seluruh Task Lab (`Task 1`..`Task N`) secara berurutan terhadap environment AWS Lab
   *    5) Klik tombol `Submit` di Vocareum Workbench untuk menilai Lab
   */
  async executeVocareumLab(vocLab, config, onLog) {
    const rootMarker = document.documentElement || document.body;

    // TAHAP 1: Pelajari seluruh instruksi di dalam Lab dari atas ke bawah
    if (onLog) {
      await onLog(`📚 Mempelajari seluruh instruksi Lab: "${vocLab.labTitle}"...`, 'info');
    }
    await window.LMSStorage.updateState({
      currentPhase: 'SCANNING',
      statusText: `Mempelajari instruksi: ${vocLab.labTitle.slice(0, 42)}...`
    });

    // Gulir panel instruksi ke bawah secara bertahap untuk membaca seluruh bagian Task 1..N, lalu kembali ke atas
    for (let s = 0; s < 5; s++) {
      const moved = await this.scrollPageDown();
      if (!moved) break;
      await this.sleep(220);
    }
    try {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      window.LMSScanner.queryAllDeep('div, section, main, article').forEach((box) => {
        if (box.scrollTop > 0 && !window.LMSScanner.isInsideSidebarOrHeader(box)) {
          box.scrollTop = 0;
        }
      });
    } catch {}
    await this.sleep(300);

    const studiedLab = window.LMSScanner.scanVocareumLab() || vocLab;
    await window.LMSStorage.updateState({ activeLabPlan: studiedLab });

    if (onLog) {
      const taskCount = (studiedLab.tasks || []).length;
      await onLog(
        `📋 Selesai mempelajari instruksi "${studiedLab.labTitle}" (${taskCount} Task & ${Object.keys(studiedLab.allParameters || {}).length} parameter teridentifikasi):`,
        'info'
      );
      for (const t of studiedLab.tasks || []) {
        await onLog(`  • ${t.title}`, 'info');
      }
    }

    // TAHAP 2: Pastikan environment Lab sudah dimulai (`Start Lab`) dan tunggu hingga siap (`AWS 🟢`)
    let creds = await this.extractVocareumAwsCredentials(studiedLab.awsDetailsBtnId, true);

    if (!creds) {
      const freshLabCheck = window.LMSScanner.scanVocareumLab() || studiedLab;
      if (freshLabCheck.awsStatus === 'stopped' && freshLabCheck.startLabBtnId) {
        const startBtn = window.LMSScanner.getElementById(freshLabCheck.startLabBtnId);
        if (startBtn && window.LMSScanner.isVisible(startBtn)) {
          if (onLog) {
            await onLog('🚀 Menekan tombol "Start Lab" untuk memulai environment AWS Lab...', 'action');
          }
          await window.LMSStorage.updateState({
            currentPhase: 'SIMULATION',
            statusText: 'Memulai environment AWS Lab (Start Lab)...'
          });
          await this.clickElement(startBtn, '#f59e0b');
          await this.sleep(1500);
        }
      }

      // Tunggu hingga environment AWS selesai disiapkan (indikator AWS berubah hijau / kredensial AWS Details muncul)
      if (onLog) {
        await onLog('⏳ Menunggu environment AWS Lab siap digunakan (AWS 🟢)...', 'info');
      }
      for (let waitIdx = 0; waitIdx < 80; waitIdx++) {
        const st = await window.LMSStorage.getState();
        if (!st.isRunning) return { ok: false, reason: 'Dihentikan oleh pengguna' };

        await window.LMSStorage.updateState({
          currentPhase: 'SIMULATION',
          statusText: `Menunggu environment AWS Lab siap (${(waitIdx + 1) * 3}d)...`
        });

        // Cek kembali apakah kredensial sudah tersedia di AWS Details
        if (waitIdx % 2 === 0) {
          const detailsBtn = studiedLab.awsDetailsBtnId
            ? window.LMSScanner.getElementById(studiedLab.awsDetailsBtnId)
            : null;
          if (detailsBtn) detailsBtn.removeAttribute('data-lms-details-opened');
        }
        creds = await this.extractVocareumAwsCredentials(studiedLab.awsDetailsBtnId, true);
        if (creds && creds.accessKeyId && creds.secretAccessKey) {
          break;
        }

        const nowLab = window.LMSScanner.scanVocareumLab();
        if (nowLab && nowLab.awsStatus === 'ready') {
          creds = await this.extractVocareumAwsCredentials(nowLab.awsDetailsBtnId, true);
          break;
        }

        await this.sleep(3000);
      }
    }

    // TAHAP 3: Jalankan seluruh instruksi Task 1..N yang telah dipelajari
    if (creds && creds.accessKeyId && creds.secretAccessKey) {
      if (onLog) {
        await onLog(
          `🔑 Environment AWS siap (${creds.accessKeyId.slice(0, 8)}...). Menjalankan seluruh instruksi Lab...`,
          'action'
        );
      }
      await window.LMSStorage.updateState({
        currentPhase: 'SIMULATION',
        statusText: `Menjalankan instruksi ${studiedLab.labTitle}...`
      });

      const execResponse = await this.invokeAWSLabPlanExecutor(creds, studiedLab, config);
      if (execResponse && Array.isArray(execResponse.logs)) {
        for (const item of execResponse.logs) {
          if (onLog) {
            await onLog(item.message, item.level || 'action');
          }
          await window.LMSStorage.updateState({
            currentPhase: 'SIMULATION',
            statusText: item.message.slice(0, 60)
          });
          await this.sleep(250);
        }
      }

      if (execResponse && execResponse.ok === false) {
        if (onLog) {
          await onLog(`⚠️ Catatan eksekusi Lab: ${execResponse.error || 'Beberapa langkah memerlukan konsol'}`, 'warn');
        }
      }
    } else {
      // Jika kredensial CLI tidak ditampilkan di halaman, buka konsol AWS
      const awsBtn = studiedLab.awsConsoleBtnId
        ? window.LMSScanner.getElementById(studiedLab.awsConsoleBtnId)
        : null;
      if (awsBtn && window.LMSScanner.isVisible(awsBtn)) {
        if (onLog) {
          await onLog('🌐 Membuka AWS Management Console untuk menjalankan instruksi Lab...', 'action');
        }
        await this.clickElement(awsBtn, '#f59e0b');
        await this.sleep(1500);
      }
    }

    // TAHAP 4: Klik tombol "Submit" pada Vocareum Workbench untuk menilai pekerjaan Lab
    const refreshedLab = window.LMSScanner.scanVocareumLab() || studiedLab;
    if (config.autoSubmit !== false && refreshedLab.submitLabBtnId) {
      const submitBtn = window.LMSScanner.getElementById(refreshedLab.submitLabBtnId);
      if (submitBtn && window.LMSScanner.isVisible(submitBtn)) {
        if (onLog) {
          await onLog('📤 Menekan tombol "Submit" pada Lab untuk memverifikasi & menilai seluruh Task...', 'action');
        }
        await window.LMSStorage.updateState({
          currentPhase: 'SUBMITTING',
          statusText: 'Mengirim & menilai hasil pengerjaan Lab (Submit)...'
        });
        await this.clickElement(submitBtn, '#10b981');
        await this.sleep(900);

        // Jika muncul dialog konfirmasi Submit ("Yes" / "OK" / "Confirm") di Vocareum, klik otomatis
        const confirmBtn = window.LMSScanner.queryAllDeep('button, a, input[type="button"], [role="button"]').find(
          (el) => {
            if (!window.LMSScanner.isVisible(el) || el === submitBtn) return false;
            const t = window.LMSScanner.cleanText(el.innerText || el.value || '');
            return /^(?:yes|ok|confirm|ya|submit\s+lab)$/i.test(t);
          }
        );
        if (confirmBtn) {
          await this.clickElement(confirmBtn, '#10b981');
          await this.sleep(900);
        }
      }
    }

    rootMarker.setAttribute('data-lms-lab-completed', 'true');
    if (onLog) {
      await onLog(`🎉 Seluruh instruksi pada "${studiedLab.labTitle}" telah selesai dijalankan!`, 'success');
    }
    return { ok: true };
  },

  /**
   * Panggil eksekutor rencana Lab AWS di Service Worker (atau langsung melalui LMSAIClient jika tersedia di window)
   */
  async invokeAWSLabPlanExecutor(credentials, labPlan, config) {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'EXECUTE_AWS_LAB_PLAN',
            payload: { credentials, labPlan, config }
          },
          (response) => {
            if (chrome.runtime.lastError || !response) {
              if (window.LMSAIClient && typeof window.LMSAIClient.executeAWSLabPlan === 'function') {
                window.LMSAIClient.executeAWSLabPlan({ credentials, labPlan }, config)
                  .then(resolve)
                  .catch((err) => resolve({ ok: false, error: err.message, logs: [] }));
              } else {
                resolve({ ok: false, error: chrome.runtime.lastError?.message || 'No response', logs: [] });
              }
              return;
            }
            resolve(response.data || response);
          }
        );
      });
    }

    if (window.LMSAIClient && typeof window.LMSAIClient.executeAWSLabPlan === 'function') {
      return await window.LMSAIClient.executeAWSLabPlan({ credentials, labPlan }, config);
    }
    return { ok: false, error: 'AWS Lab Executor tidak ditemukan', logs: [] };
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSExecutor = LMSExecutor;
}
