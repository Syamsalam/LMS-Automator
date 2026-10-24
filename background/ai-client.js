/**
 * LMS Auto-Pilot - Multi-Provider AI Client & Smart Heuristic Solver
 * Mendukung:
 * - Mode Lokal (Smart Contextual Engine - 100% Gratis & Tanpa API Key)
 * - Pollinations Free Cloud AI (100% Gratis & Tanpa API Key)
 * - Ollama / LM Studio Lokal (http://localhost:11434 - 100% Gratis & Tanpa API Key)
 * - Google Gemini (Free Tier di Google AI Studio)
 * - Groq Cloud (Free Tier Llama 3.3)
 * - OpenRouter (Model :free)
 * - OpenAI / Custom Endpoint
 */

const LMSAIClient = {
  /**
   * Cek apakah provider memerlukan API Key atau bisa berjalan tanpa API Key
   */
  isKeylessProvider(provider) {
    const p = (provider || '').toLowerCase();
    return p === 'local' || p === 'pollinations' || p === 'ollama';
  },

  /**
   * Panggil LLM API dan kembalikan objek JSON terurai
   */
  async callLLMJson(systemPrompt, userPrompt, config) {
    const provider = (config.aiProvider || 'gemini').toLowerCase();
    const apiKey = (config.apiKey || '').trim();

    if (provider === 'local') {
      return { status: 'ok', message: 'Mode Smart Contextual Engine (Lokal) aktif tanpa API Key!' };
    }

    if (!apiKey && !this.isKeylessProvider(provider) && provider !== 'custom') {
      throw new Error('NO_API_KEY: API Key belum diatur.');
    }

    if (provider === 'gemini') {
      const model = config.model || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }]
            }
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
          }
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API Error (${response.status}): ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return this.safeParseJson(rawText);
    }

    // OpenAI / Groq / Pollinations (Free Keyless) / Ollama (Local Keyless) / OpenRouter / Custom
    let endpoint = 'https://api.openai.com/v1/chat/completions';
    let defaultModel = 'gpt-4o-mini';

    if (provider === 'groq') {
      endpoint = 'https://api.groq.com/openai/v1/chat/completions';
      defaultModel = 'llama-3.3-70b-versatile';
    } else if (provider === 'pollinations') {
      endpoint = 'https://text.pollinations.ai/openai';
      defaultModel = 'openai';
    } else if (provider === 'ollama') {
      endpoint = (config.customEndpoint || '').trim() || 'http://localhost:11434/v1/chat/completions';
      defaultModel = 'qwen2.5-coder:7b';
    } else if (provider === 'openrouter') {
      endpoint = 'https://openrouter.ai/api/v1/chat/completions';
      defaultModel = 'meta-llama/llama-3.3-70b-instruct:free';
    } else if (provider === 'custom' && config.customEndpoint) {
      endpoint = config.customEndpoint;
    }

    const model = config.model || defaultModel;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`${provider.toUpperCase()} API Error (${response.status}): ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const rawText = data?.choices?.[0]?.message?.content || '{}';
    return this.safeParseJson(rawText);
  },

  safeParseJson(rawText) {
    if (!rawText) return {};
    try {
      return JSON.parse(rawText);
    } catch {
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      try {
        return JSON.parse(cleaned);
      } catch {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) {
          return JSON.parse(match[0]);
        }
        throw new Error('Gagal mengurai respons JSON dari AI.');
      }
    }
  },

  /**
   * Uji koneksi API Key
   */
  async testConnection(config) {
    const sys = 'Return a valid JSON object confirming connection.';
    const usr = 'Respond with {"status":"ok","message":"Koneksi AI berhasil!"}';
    const res = await this.callLLMJson(sys, usr, config);
    return {
      ok: true,
      provider: config.aiProvider,
      model: config.model,
      message: res.message || 'Koneksi AI berhasil!'
    };
  },

  /**
   * Selesaikan seluruh tugas pada halaman modul sekaligus (Simulasi Tombol, Pilihan Ganda, Esai)
   */
  async solvePageTasks(pageData, config) {
    const provider = (config.aiProvider || 'gemini').toLowerCase();
    const hasApiKey = Boolean((config.apiKey || '').trim());
    const isLocalCustom =
      provider === 'custom' && /^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(config.customEndpoint || '');
    const canCallLLM =
      provider !== 'local' && (hasApiKey || provider === 'pollinations' || provider === 'ollama' || isLocalCustom);

    if (canCallLLM) {
      try {
        const aiResult = await this.solvePageTasksWithLLM(pageData, config);
        return {
          source: `AI (${config.aiProvider}:${config.model})`,
          ...aiResult
        };
      } catch (err) {
        console.warn('[LMSAIClient] AI API error, checking fallback:', err.message);
        if (!config.useSmartFallback) {
          throw err;
        }
        const fallbackResult = this.solveWithSmartHeuristics(pageData, config);
        return {
          source: `Smart Heuristic (Fallback: ${err.message.slice(0, 60)})`,
          ...fallbackResult
        };
      }
    }

    if (provider === 'local' || config.useSmartFallback !== false) {
      const fallbackResult = this.solveWithSmartHeuristics(pageData, config);
      return {
        source: 'Smart Contextual Engine (Local)',
        ...fallbackResult
      };
    }

    throw new Error('API Key belum diisi. Buka pengaturan ekstensi untuk memasukkan API Key atau aktifkan Smart Fallback.');
  },

  async solvePageTasksWithLLM(pageData, config) {
    const langInstruction =
      config.essayLanguage === 'en'
        ? 'Write essay answers in clear, academic English.'
        : config.essayLanguage === 'id'
        ? 'Tulis jawaban esai dalam Bahasa Indonesia yang baik, jelas, dan akademis.'
        : 'Write essay answers in the same language as the question.';

    const lengthInstruction =
      config.essayLength === 'short'
        ? 'Keep essay answers concise (1-2 sentences).'
        : config.essayLength === 'detailed'
        ? 'Provide comprehensive, well-structured essay answers (1-2 paragraphs with clear explanation).'
        : 'Provide a clear, natural essay answer (3-4 sentences).';

    const systemPrompt = `Anda adalah asisten otomatis penyelesai modul pembelajaran (LMS).
Tugas Anda adalah menganalisis materi modul, instruksi tugas simulasi interaktif (termasuk tugas menyusun blok kode / Code-Builder seperti sel Python/SQL/JS dengan slot isian "___" dan tombol "▶ run"), soal pilihan ganda, dan soal esai pada halaman, lalu mengembalikan solusi tepat dalam format JSON.

ATURAN PENTING:
1. SIMULASI TOMBOL, SUSUN KODE (CODE-BUILDER), & JALANKAN PROGRAM (simulations):
   - Baca instruksi tugas simulasi dan perhatikan daftar "candidateButtons".
   - Jika "candidateButtons" berupa potongan baris kode (misal: "import pandas as pd", "import matplotlib.pyplot as plt", "internet = ___.read_csv( ___ )", "___ #display the dataframe"):
     * Urutkan "sequenceIds" sesuai urutan eksekusi kode yang valid secara sintaksis dan logis (contoh: pernyataan import pustaka utama seperti pandas terlebih dahulu, diikuti import pendukung seperti matplotlib, lalu pembacaan data/deklarasi variabel seperti read_csv, dan terakhir penampilan hasil/dataframe atau print/plot).
     * Jika terdapat placeholder "___" pada blok kode, isi array "slotValues" secara berurutan dengan nilai kode yang tepat untuk mengisi tiap titik "___" tersebut (misal: ["pd", "'internet.csv'", "internet"]).
   - Jangan masukkan tombol "Run / Jalankan Program" atau tombol "Reset" ke dalam "sequenceIds".
   - Tentukan "runButtonId" yaitu ID tombol untuk menjalankan/mengeksekusi program setelah urutan tombol/kode selesai disusun.
2. PILIHAN GANDA (mcqs):
   - Pilih ID opsi jawaban yang paling tepat berdasarkan materi modul dan pengetahuan umum.
   - Kembalikan dalam array "selectedOptionIds" (1 ID untuk radio/single choice, bisa lebih dari 1 untuk checkbox jika diminta).
3. ESAI / ISIAN TEKS (essays):
   - ${langInstruction}
   - ${lengthInstruction}
   - Jawaban harus langsung menjawab inti pertanyaan berdasarkan konteks materi modul (tanpa awalan seperti "Berikut adalah jawabannya:").

KEMBALIKAN HANYA JSON VALID DENGAN SKEMA BERIKUT:
{
  "simulations": [
    {
      "taskId": "string",
      "sequenceIds": ["id_tombol_1", "id_tombol_2"],
      "slotValues": ["nilai_slot_1", "nilai_slot_2"],
      "runButtonId": "id_tombol_run",
      "reasoning": "penjelasan singkat"
    }
  ],
  "mcqs": [
    {
      "questionId": "string",
      "selectedOptionIds": ["id_opsi_benar"],
      "reasoning": "penjelasan singkat"
    }
  ],
  "essays": [
    {
      "essayId": "string",
      "answerText": "teks jawaban esai lengkap"
    }
  ]
}`;

    const userPayload = {
      pageTitle: pageData.pageTitle,
      moduleContext: (pageData.moduleContext || '').slice(0, 5000),
      simulations: (pageData.simulations || []).map((s) => ({
        taskId: s.taskId,
        taskType: s.taskType,
        instruction: s.instruction,
        candidateButtons: s.candidateButtons,
        runButtons: s.runButtons
      })),
      mcqs: (pageData.mcqs || []).map((q) => ({
        questionId: q.questionId,
        questionText: q.questionText,
        inputType: q.inputType,
        options: q.options
      })),
      essays: (pageData.essays || []).map((e) => ({
        essayId: e.essayId,
        questionText: e.questionText,
        placeholder: e.placeholder
      }))
    };

    const parsed = await this.callLLMJson(
      systemPrompt,
      JSON.stringify(userPayload, null, 2),
      config
    );

    const heuristicFallback = this.solveWithSmartHeuristics(pageData, config);
    const enrichedSimulations = (Array.isArray(parsed.simulations) ? parsed.simulations : []).map((simSol, idx) => {
      const scanSim = (pageData.simulations || []).find((s) => s.taskId === simSol.taskId) || (pageData.simulations || [])[idx];
      const heurSim = (heuristicFallback.simulations || []).find((s) => s.taskId === simSol.taskId) || (heuristicFallback.simulations || [])[idx] || {};
      const seqIds = Array.isArray(simSol.sequenceIds) && simSol.sequenceIds.length > 0
        ? simSol.sequenceIds
        : (heurSim.sequenceIds || []);
      const seqLabels = seqIds.map((id) => {
        const found = (scanSim?.candidateButtons || []).find((b) => b.id === id);
        return found ? found.label : '';
      });
      return {
        ...heurSim,
        ...simSol,
        sequenceIds: seqIds,
        sequenceLabels: seqLabels,
        slotValues:
          Array.isArray(simSol.slotValues) && simSol.slotValues.length > 0
            ? simSol.slotValues
            : (heurSim.slotValues || []),
        tileSlotMap: heurSim.tileSlotMap || {}
      };
    });

    return {
      simulations: enrichedSimulations,
      mcqs: Array.isArray(parsed.mcqs) ? parsed.mcqs : [],
      essays: Array.isArray(parsed.essays) ? parsed.essays : []
    };
  },

  /**
   * Deteksi apakah tugas simulasi adalah penyusunan blok kode (Code-Builder / Parsons Problem)
   */
  isCodeSimulation(sim) {
    if (!sim) return false;
    if (sim.taskType === 'code-builder') return true;
    const candidates = sim.candidateButtons || [];
    const codePattern =
      /\b(import\s+\w+|from\s+\w+\s+import|def\s+\w+|class\s+\w+|return\b|print\s*\(|console\.log|\.read_csv|\.DataFrame|\.plot\(|plt\.|pd\.|np\.|SELECT\s+|FROM\s+|WHERE\s+)\b|#\s*\w+|___\s*\.|\w+\s*=\s*[\w_]/i;
    return candidates.some((c) => (c.slotCount || 0) > 0 || codePattern.test(c.label || ''));
  },

  /**
   * Analisis urutan blok kode & nilai isian slot kosong (`___`) untuk widget Code-Builder
   * seperti `[1] python` + `▶ run` dengan blok `import pandas as pd`, `internet = ___.read_csv( ___ )`, dll.
   */
  solveCodeBuilderHeuristic(sim, pageData) {
    const candidates = (sim.candidateButtons || []).filter(
      (b) => !/\b(reset|batal|cancel|clear|hapus)\b/i.test(b.label || '')
    );
    const runButtons = sim.runButtons || [];
    const instruction = `${sim.instruction || ''}\n${pageData.moduleContext || ''}`;
    const instructionLower = instruction.toLowerCase();

    // Pisahkan antara tile baris kode (statement) vs tile token tunggal (jika sub-tile sudah muncul di layar)
    const isStatementTile = (label) => {
      const t = (label || '').trim();
      return (
        /\s/.test(t) ||
        /[=()#.]/.test(t) ||
        /^(import|from|def|class|return|print|for|while|if|elif|else|SELECT|FROM|WHERE)\b/i.test(t)
      );
    };

    const statementTiles = candidates.filter((c) => isStatementTile(c.label));
    const activeTiles = statementTiles.length > 0 ? statementTiles : candidates;

    // Ekstrak konteks kode dari seluruh tile yang ada
    const allLabels = candidates.map((c) => c.label || '');
    const allCodeText = allLabels.join('\n');

    let pandasAlias = 'pd';
    let pltAlias = 'plt';
    let npAlias = 'np';

    for (const lbl of allLabels) {
      const pdMatch = lbl.match(/import\s+pandas\s+as\s+([a-zA-Z_]\w*)/i);
      if (pdMatch) pandasAlias = pdMatch[1];
      const pltMatch = lbl.match(/import\s+matplotlib(?:\.pyplot)?\s+as\s+([a-zA-Z_]\w*)/i);
      if (pltMatch) pltAlias = pltMatch[1];
      const npMatch = lbl.match(/import\s+numpy\s+as\s+([a-zA-Z_]\w*)/i);
      if (npMatch) npAlias = npMatch[1];
    }

    // Cari nama variabel utama yang dideklarasikan (contoh: `internet = ___.read_csv( ___ )` -> `internet`)
    const assignedVars = [];
    for (const lbl of allLabels) {
      const assignMatch = lbl.match(/^\s*([a-zA-Z_]\w*)\s*=\s*[^=]/);
      if (assignMatch && !['import', 'from', 'def', 'return'].includes(assignMatch[1])) {
        assignedVars.push(assignMatch[1]);
      }
    }
    const primaryVar = assignedVars[0] || 'df';

    // Cari nama file dataset (.csv / .json / .xlsx) dari instruksi atau nama variabel
    const fileMatch = instruction.match(/['"]?([a-zA-Z0-9_/-]+\.(?:csv|json|xlsx|txt|tsv))['"]?/i);
    const datasetFile = fileMatch ? fileMatch[1] : `${primaryVar}.csv`;

    // Hitung skor urutan eksekusi baris kode secara logis
    const scored = activeTiles.map((btn, idx) => {
      const lbl = (btn.label || '').trim();
      const lblLower = lbl.toLowerCase();

      // Jika elemen memiliki atribut urutan eksplisit
      if (btn.stepOrder && Number(btn.stepOrder) > 0) {
        return { btn, stage: Number(btn.stepOrder), subOrder: 0, idx };
      }

      let stage = 30;
      let subOrder = idx;

      // Tahap 10: Pernyataan Import (`import ...` / `from ... import ...`)
      if (/^\s*(import|from)\s+/i.test(lbl)) {
        stage = 10;
        // Dahulukan pustaka yang metodenya langsung dipakai di baris kode berikutnya (misal pandas untuk read_csv)
        if (/pandas/i.test(lbl) && /\.read_csv|\.DataFrame/i.test(allCodeText)) {
          subOrder = 1;
        } else if (/numpy/i.test(lbl)) {
          subOrder = 2;
        } else if (/pandas/i.test(lbl)) {
          subOrder = 3;
        } else if (/matplotlib|seaborn/i.test(lbl)) {
          subOrder = 4;
        } else {
          subOrder = 5;
        }
      }
      // Tahap 20: Definisi fungsi atau kelas (`def ...`, `class ...`)
      else if (/^\s*(def|class|function)\s+/i.test(lbl)) {
        stage = 20;
      }
      // Tahap 30: Pembacaan data / inisialisasi variabel (`internet = ___.read_csv( ___ )`)
      else if (/^\s*[a-zA-Z_]\w*\s*=\s*[^=]/.test(lbl)) {
        if (/read_csv|read_excel|read_json|DataFrame|load|open\s*\(/i.test(lbl)) {
          stage = 30;
          subOrder = 1;
        } else {
          stage = 32;
          subOrder = 2;
        }
      }
      // Tahap 50: Baris penampilan hasil / output (`___ #display the dataframe`, `print(...)`, `plt.show()`)
      else if (
        /#\s*(display|show|print|output|tampilkan|lihat)/i.test(lbl) ||
        /^\s*(print\s*\(|display\s*\(|plt\.show\s*\(|return\b)/i.test(lbl) ||
        /\.(head|tail|info|describe)\s*\(/i.test(lbl)
      ) {
        stage = 50;
      }
      // Tahap 40: Operasi pemrosesan / transformasi / plotting
      else {
        stage = 40;
      }

      // Gunakan posisi kata kunci di dalam teks instruksi sebagai tie-breaker jika ada
      const posInInstr = instructionLower.indexOf(lblLower.replace(/___/g, '').trim());
      const instrTie = posInInstr >= 0 ? posInInstr / 10000 : idx / 100;

      return { btn, stage, subOrder: subOrder + instrTie, idx };
    });

    scored.sort((a, b) => (a.stage !== b.stage ? a.stage - b.stage : a.subOrder - b.subOrder));

    const sequenceIds = scored.map((s) => s.btn.id);
    const sequenceLabels = scored.map((s) => s.btn.label);

    // Inferensi nilai untuk setiap slot kosong `___` pada masing-masing tile
    const slotValues = [];
    const tileSlotMap = {};

    for (const item of scored) {
      const btn = item.btn;
      const lbl = btn.label || '';
      if (!lbl.includes('___') && (!btn.slotCount || btn.slotCount <= 0)) continue;

      const tileSlots = [];
      // Analisis konteks di sekitar setiap `___`
      const segments = lbl.split('___');
      const numSlots = Math.max(segments.length - 1, btn.slotCount || 0);

      for (let sIdx = 0; sIdx < numSlots; sIdx++) {
        const before = (segments[sIdx] || '').trim();
        const after = (segments[sIdx + 1] || '').trim();

        let inferred = '';

        // Pola 1: `___.read_csv(...)` atau `___.DataFrame(...)` -> `pd`
        if (/^\.\s*(read_csv|read_excel|read_json|DataFrame|Series|concat|merge)\b/.test(after)) {
          inferred = pandasAlias;
        }
        // Pola 2: `___.plot(...)` / `___.show()` / `___.xlabel(...)` -> `plt` atau `primaryVar`
        else if (/^\.\s*(show|xlabel|ylabel|title|figure|subplot|legend|grid|scatter|bar|hist)\b/.test(after)) {
          inferred = pltAlias;
        }
        // Pola 3: `___.array(...)` / `___.arange(...)` -> `np`
        else if (/^\.\s*(array|arange|linspace|zeros|ones|mean|std)\b/.test(after)) {
          inferred = npAlias;
        }
        // Pola 4: `.read_csv( ___ )` -> `'internet.csv'`
        else if (/read_(?:csv|excel|json|table)\s*\(\s*$/.test(before) && /^\)/.test(after)) {
          inferred = `'${datasetFile}'`;
        }
        // Pola 5: `___ #display the dataframe` atau `___.head()` atau `print( ___ )` -> `internet`
        else if (
          /^#\s*(display|show|print|output|tampilkan)/i.test(after) ||
          /^\.\s*(head|tail|info|describe|shape|columns)\b/.test(after) ||
          /\b(print|display)\s*\(\s*$/.test(before)
        ) {
          inferred = primaryVar;
        }
        // Fallback umum berdasarkan posisi
        else {
          inferred = primaryVar;
        }

        tileSlots.push(inferred);
        slotValues.push(inferred);
      }

      tileSlotMap[btn.id] = tileSlots;
    }

    return {
      taskId: sim.taskId,
      sequenceIds,
      sequenceLabels,
      slotValues,
      tileSlotMap,
      runButtonId: runButtons.length > 0 ? runButtons[0].id : null,
      reasoning: 'Urutan blok kode dan isian slot dianalisis berdasarkan struktur sintaksis program.'
    };
  },

  /**
   * Mesin Heuristik Kontekstual Cerdas
   * Menganalisis instruksi halaman, urutan langkah, blok kode interaktif, pencocokan materi modul, dan atribut semantik
   */
  solveWithSmartHeuristics(pageData, config) {
    const contextText = (pageData.moduleContext || '').toLowerCase();

    // 1. Selesaikan Tugas Simulasi Tombol, Code-Builder, & Jalankan Program
    const simulations = (pageData.simulations || []).map((sim) => {
      if (this.isCodeSimulation(sim)) {
        return this.solveCodeBuilderHeuristic(sim, pageData);
      }

      const instruction = sim.instruction || '';
      const instructionLower = instruction.toLowerCase();
      const candidates = sim.candidateButtons || [];
      const runButtons = sim.runButtons || [];

      let sequenceIds = [];

      // Cek apakah ada atribut urutan eksplisit atau kecocokan posisi di teks instruksi
      const scoredCandidates = [];
      for (const btn of candidates) {
        const label = (btn.label || '').trim();
        const labelLower = label.toLowerCase();
        if (!labelLower) continue;

        // Jangan pilih tombol jebakan/error/reset kecuali diminta eksplisit
        const isTrap =
          /\b(reset|batal|cancel|hapus|clear|matikan paksa|format|error|corrupt|skip)\b/i.test(label) &&
          !instructionLower.includes(labelLower);
        if (isTrap) continue;

        // Cek atribut petunjuk pada elemen (jika ada di LMS / simulasi)
        if (btn.stepOrder && Number(btn.stepOrder) > 0) {
          scoredCandidates.push({
            id: btn.id,
            order: Number(btn.stepOrder),
            matched: true
          });
          continue;
        }

        if (btn.isCorrect === 'true' || btn.isCorrect === true) {
          const idxInText = instructionLower.indexOf(labelLower);
          scoredCandidates.push({
            id: btn.id,
            order: idxInText >= 0 ? idxInText : 999,
            matched: true
          });
          continue;
        }

        // Cari posisi kemunculan nama tombol di dalam teks instruksi tugas
        const exactIdx = instructionLower.indexOf(labelLower);
        if (exactIdx !== -1) {
          scoredCandidates.push({
            id: btn.id,
            order: exactIdx,
            matched: true
          });
          continue;
        }

        // Pencocokan token kata penting dari label tombol terhadap instruksi
        const cleanTokens = labelLower
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length >= 3 && !['tombol', 'klik', 'langkah', 'step', 'mode', 'pilih'].includes(w));

        if (cleanTokens.length > 0) {
          let firstPos = Infinity;
          let matchedTokens = 0;
          for (const tok of cleanTokens) {
            const pos = instructionLower.indexOf(tok);
            if (pos !== -1) {
              matchedTokens++;
              if (pos < firstPos) firstPos = pos;
            }
          }
          if (matchedTokens >= Math.ceil(cleanTokens.length * 0.6)) {
            scoredCandidates.push({
              id: btn.id,
              order: firstPos,
              matched: true
            });
          }
        }
      }

      if (scoredCandidates.length > 0) {
        scoredCandidates.sort((a, b) => a.order - b.order);
        sequenceIds = scoredCandidates.map((c) => c.id);
      } else if (candidates.length > 0) {
        // Jika tidak ada kecocokan teks eksplisit, pilih tombol aksi positif non-reset
        sequenceIds = candidates
          .filter((b) => !/\b(reset|batal|cancel|clear|hapus|salah)\b/i.test(b.label || ''))
          .map((b) => b.id);
      }

      const sequenceLabels = sequenceIds.map((id) => {
        const found = candidates.find((b) => b.id === id);
        return found ? found.label : '';
      });

      const runButtonId = runButtons.length > 0 ? runButtons[0].id : null;

      return {
        taskId: sim.taskId,
        sequenceIds,
        sequenceLabels,
        slotValues: [],
        tileSlotMap: {},
        runButtonId,
        reasoning: 'Urutan tombol dianalisis dari instruksi langkah modul.'
      };
    });

    // 2. Selesaikan Soal Pilihan Ganda (termasuk Evaluasi Baris Program / Pandas DataFrame `df.query(...)`, `sort_values`, dll.)
    const mcqs = (pageData.mcqs || []).map((q) => {
      const rawQText = q.questionText || '';
      const qText = rawQText.toLowerCase();
      const options = q.options || [];
      if (options.length === 0) {
        return { questionId: q.questionId, selectedOptionIds: [] };
      }

      // Ekstrak petunjuk perubahan kolom tabel (misal [ChangedColumn: vitamin_c ...] dan [UnchangedColumn: fruit])
      const changedCols = Array.from(rawQText.matchAll(/\[ChangedColumn:\s*([^\s(\]]+)/gi)).map((m) =>
        m[1].toLowerCase()
      );
      const unchangedCols = Array.from(rawQText.matchAll(/\[UnchangedColumn:\s*([^\s\]]+)/gi)).map((m) =>
        m[1].toLowerCase()
      );

      // Evaluasi khusus untuk opsi berbentuk baris program (Python/Pandas DataFrame seperti `df.query('count == 16')`)
      const codeOptionBonusMap = this.evaluatePandasCodeOptions(rawQText, options, q.tableData || null);
      // Evaluasi khusus untuk konsep AWS Cloud Computing (AWS Academy / AWS Skill Builder Knowledge Check)
      const awsBonusMap = this.evaluateAWSCloudKnowledgeOptions(rawQText, options);

      // Skor setiap opsi berdasarkan konteks materi halaman, tabel DataFrame, & heuristik semantik
      const scored = options.map((opt, idx) => {
        let score = (codeOptionBonusMap.get(opt.id) || 0) + (awsBonusMap.get(opt.id) || 0);
        const optText = (opt.text || '').trim();
        const optLower = optText.toLowerCase();

        if (opt.isCorrect === 'true' || opt.isCorrect === true) {
          score += 1000;
        }

        // A. Analisis literal string / simbol di dalam opsi kode (contoh: `'%'` vs `'$'`, `'vitamin_c'` vs `'fruit'`)
        // Abaikan literal yang merupakan ekspresi query (`count == 16`) karena sudah dievaluasi oleh evaluatePandasCodeOptions
        const quotedLiterals = Array.from(optText.matchAll(/['"]([^'"]+)['"]/g))
          .map((m) => m[1].trim())
          .filter((s) => s.length > 0 && !/[=!<>]=|[<>]|\band\b|\bor\b/i.test(s));

        for (const lit of quotedLiterals) {
          const litLower = lit.toLowerCase();
          // Cek apakah literal ini adalah kolom yang berubah vs tidak berubah pada tabel
          if (changedCols.includes(litLower)) {
            score += 45;
          } else if (unchangedCols.includes(litLower)) {
            score -= 25;
          }

          // Cek apakah simbol/literal (seperti '%' atau '$') benar-benar ada di teks soal/tabel
          if (qText.includes(litLower) || contextText.includes(litLower)) {
            score += 25;
          } else {
            score -= 35;
          }
        }

        // B. Cek kemunculan frasa opsi di dalam materi modul
        const words = optLower
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3);

        for (const w of words) {
          if (changedCols.includes(w)) {
            score += 20;
          }
          if (contextText.includes(w)) {
            score += 3;
          }
          if (qText.includes(w)) {
            score += 1;
          }
        }

        // Cek kecocokan kalimat di materi modul yang mengandung kata kunci pertanyaan + kata kunci opsi
        const sentences = contextText.split(/[.\n!?]+/);
        const qKeywords = qText
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3 && !['yang', 'apakah', 'bagaimana', 'berikut', 'adalah', 'untuk', 'dalam', 'pada'].includes(w));

        for (const sentence of sentences) {
          const hasQWord = qKeywords.some((kw) => sentence.includes(kw));
          if (hasQWord) {
            const matchedOptWords = words.filter((w) => sentence.includes(w)).length;
            if (matchedOptWords > 0) {
              score += matchedOptWords * 8;
            }
            if (optLower.length > 5 && sentence.includes(optLower)) {
              score += 40;
            }
          }
        }

        // Jawaban yang komprehensif dan spesifik di LMS sering kali memiliki penjelasan yang lebih lengkap
        if (optText.length > 25 && optText.length < 220) {
          score += 2;
        }
        if (/semua jawaban benar|all of the above/i.test(optText)) {
          score += 4;
        }

        return { id: opt.id, score, idx };
      });

      scored.sort((a, b) => b.score - a.score);

      // Deteksi apakah soal meminta memilih 2 atau 3 jawaban (misal "(Select TWO.)" atau "Choose two." pada AWS Knowledge Check)
      const asksForThree = /\b(?:select|choose|pick|pilih)\s+(?:three|3|tiga)\b/i.test(rawQText);
      const asksForTwo = /\b(?:select|choose|pick|pilih)\s+(?:two|2|dua)\b/i.test(rawQText);
      const targetMultiCount = asksForThree ? 3 : asksForTwo ? 2 : 0;

      let selectedOptionIds = [];
      if (targetMultiCount > 0) {
        selectedOptionIds = scored.slice(0, Math.min(targetMultiCount, scored.length)).map((s) => s.id);
      } else if (q.inputType === 'checkbox') {
        selectedOptionIds = scored
          .filter((s) => s.score >= scored[0].score * 0.7 && s.score > 0)
          .slice(0, 3)
          .map((s) => s.id);
        if (selectedOptionIds.length === 0) {
          selectedOptionIds = scored.slice(0, Math.min(2, scored.length)).map((s) => s.id);
        }
      } else {
        selectedOptionIds = [scored[0].id];
      }

      if (selectedOptionIds.length === 0 && options[0]) {
        selectedOptionIds.push(options[0].id);
      }

      return {
        questionId: q.questionId,
        selectedOptionIds,
        rankedOptionIds: scored.map((s) => s.id),
        reasoning: 'Dipilih berdasarkan relevansi tertinggi dengan materi modul & evaluasi ekspresi DataFrame.'
      };
    });

    // 3. Selesaikan Soal Esai / Isian Teks
    const essays = (pageData.essays || []).map((e) => {
      const answerText = this.generateSmartEssayAnswer(
        e.questionText || '',
        pageData.moduleContext || '',
        pageData.pageTitle || '',
        config
      );
      return {
        essayId: e.essayId,
        answerText
      };
    });

    return { simulations, mcqs, essays };
  },

  generateSmartEssayAnswer(questionText, moduleContext, pageTitle, config) {
    const cleanQuestion = questionText.replace(/^\d+[\.\)]\s*/, '').trim();
    const qLower = cleanQuestion.toLowerCase();

    // Ekstrak kata kunci dari pertanyaan esai
    const stopWords = new Set([
      'jelaskan', 'apa', 'apakah', 'bagaimana', 'mengapa', 'sebutkan', 'tuliskan',
      'uraikan', 'analisis', 'menurut', 'anda', 'yang', 'dimaksud', 'dengan',
      'pada', 'dalam', 'untuk', 'dari', 'dan', 'atau', 'serta', 'berikut', 'ini',
      'what', 'how', 'why', 'explain', 'describe', 'the', 'and', 'for', 'with'
    ]);

    const keywords = qLower
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));

    // Cari kalimat relevan dari materi modul di halaman
    const rawSentences = (moduleContext || '')
      .split(/(?<=[.!?])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 35 && s.length < 350 && !s.includes('?') && s !== cleanQuestion);

    const scoredSentences = rawSentences.map((sentence) => {
      const sLower = sentence.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (sLower.includes(kw)) score += 5;
      }
      if (/\b(adalah|merupakan|berfungsi|bertujuan|proses|langkah|penting|karena|sehingga)\b/i.test(sentence)) {
        score += 3;
      }
      return { sentence, score };
    });

    scoredSentences.sort((a, b) => b.score - a.score);
    const topSentences = scoredSentences
      .filter((s) => s.score > 0)
      .slice(0, 3)
      .map((s) => s.sentence);

    if (config.essayLanguage === 'en') {
      if (topSentences.length > 0) {
        return `Based on the module material, ${topSentences.join(' ')} Therefore, implementing this concept systematically ensures optimal accuracy, efficiency, and reliability in execution.`;
      }
      return `Regarding ${cleanQuestion || pageTitle}, the fundamental principle involves initializing the required parameters in sequence, validating the input state, and executing the process systematically to achieve accurate and reliable results.`;
    }

    if (topSentences.length > 0) {
      const joined = topSentences.join(' ');
      if (config.essayLength === 'short') {
        return topSentences[0];
      }
      return `Berdasarkan materi pada modul ini, ${joined} Dengan menerapkan tahapan dan prinsip tersebut secara sistematis, proses eksekusi program maupun pengolahan data dapat berjalan secara optimal, akurat, dan sesuai spesifikasi.`;
    }

    const topic = keywords.length > 0 ? keywords.slice(0, 4).join(' ') : (pageTitle || 'materi modul ini');
    return `Berdasarkan konsep pada ${topic}, tahapan utama dimulai dengan menyiapkan konfigurasi parameter yang tepat, memvalidasi urutan instruksi kerja, serta menjalankan proses eksekusi secara terstruktur. Hal ini penting untuk memastikan sistem bekerja secara akurat, efisien, dan menghasilkan output yang sesuai dengan tujuan pembelajaran.`;
  },

  /**
   * Pilih opsi terbaik dari balon pilihan (popover) yang muncul ketika mengisi slot `[▪]` di dalam blok kode
   */
  chooseBestSlotOption(optionsList = [], expectedVal = '', slotIndex = 0, tileLabel = '') {
    if (!optionsList || optionsList.length === 0) return null;
    const cleanExp = String(expectedVal || '').trim();
    const unquotedExp = cleanExp.replace(/^['"]|['"]$/g, '');

    // 1. Pencocokan langsung dengan expectedVal dari solver
    if (cleanExp) {
      const exact = optionsList.find((o) => {
        const t = (o.text || '').trim();
        const u = t.replace(/^['"]|['"]$/g, '');
        return t === cleanExp || u === unquotedExp;
      });
      if (exact) return exact;

      // Jika mengharapkan file .csv / .json / .xlsx, cari opsi yang berakhiran ekstensi tersebut
      if (/\.(csv|json|xlsx|txt|tsv)$/i.test(unquotedExp)) {
        const extMatch = optionsList.find((o) => /\.(csv|json|xlsx|txt|tsv)['"]?$/i.test((o.text || '').trim()));
        if (extMatch) return extMatch;
      }
    }

    // 2. Analisis berdasarkan posisi slot di dalam tileLabel (misal `internet = ___ .read_csv( ___ )`)
    const segments = (tileLabel || '').split('___');
    const before = (segments[slotIndex] || '').trim();
    const after = (segments[slotIndex + 1] || '').trim();

    if (/^\.\s*(read_csv|read_excel|read_json|DataFrame|Series|concat|merge)\b/.test(after)) {
      const pdOpt = optionsList.find((o) => /^(pd|pandas)$/i.test((o.text || '').trim()));
      if (pdOpt) return pdOpt;
    }

    if (/read_(?:csv|excel|json|table)\s*\(\s*$/.test(before)) {
      const fileOpt = optionsList.find((o) => /\.(csv|json|xlsx|txt)['"]?$/i.test((o.text || '').trim()) || /^['"].+['"]$/.test((o.text || '').trim()));
      if (fileOpt) return fileOpt;
    }

    if (/^#\s*(display|show|print|output|tampilkan)/i.test(after) || /^\.\s*(head|tail|info|describe)\b/.test(after)) {
      const varOpt = optionsList.find(
        (o) => !/^(pd|plt|np|import)$/i.test((o.text || '').trim()) && !/\.csv['"]?$/i.test((o.text || '').trim())
      );
      if (varOpt) return varOpt;
    }

    return optionsList[0];
  },

  /**
   * Pilih opsi terbaik untuk pertanyaan rumpang hasil program (`There are [...] rows of data...`)
   * berdasarkan fakta output program yang baru saja dijalankan oleh `▶ run`
   */
  chooseBestInlineBlankOption(sentenceContext = '', optionsList = [], outputFacts = {}, moduleContext = '') {
    if (!optionsList || optionsList.length === 0) return null;
    const sLower = (sentenceContext || '').toLowerCase();
    const rawOut = (outputFacts?.rawText || '').toLowerCase();
    const modLower = (moduleContext || '').toLowerCase();

    // Cek bagian kalimat tepat di sekitar `___`
    const parts = sLower.split('___');
    const beforeBlank = (parts[0] || '').trim();
    const afterBlank = (parts[1] || '').trim();

    // A. Pertanyaan tentang jumlah baris (`rows of data`, `rows`, `baris`, `records`, `observations`)
    if (
      /^\s*(rows|baris|records|entries|observations|data\s*points)\b/i.test(afterBlank) ||
      /\b(how\s+many\s+rows|jumlah\s+baris|banyak\s+baris|rows\s+of\s+data)\b/i.test(sLower)
    ) {
      // 1. Cek explicitRows dari teks output (misal "35 rows")
      if (outputFacts?.explicitRows != null) {
        const match = optionsList.find((o) => Number((o.text || '').trim()) === outputFacts.explicitRows);
        if (match) return match;
      }
      // 2. Cek inferredRowsFromZeroIndex (jika indeks DataFrame 0..34, maka jumlah baris adalah 35)
      if (outputFacts?.inferredRowsFromZeroIndex != null) {
        const match = optionsList.find(
          (o) => Number((o.text || '').trim()) === outputFacts.inferredRowsFromZeroIndex
        );
        if (match) return match;
      }
      // 3. Cek tableRowCount dari elemen <table>
      if (outputFacts?.tableRowCount != null) {
        const match = optionsList.find((o) => Number((o.text || '').trim()) === outputFacts.tableRowCount);
        if (match) return match;
      }
      // 4. Heuristik khusus DataFrame 0-indexed: jika opsi memiliki pasangan N dan N+1 (seperti 34 dan 35),
      //    di mana 34 adalah indeks terakhir dan 35 adalah jumlah baris ("rows of data"), pilih N+1 (35)
      const numericOpts = optionsList
        .map((o) => ({ opt: o, num: Number((o.text || '').trim()) }))
        .filter((x) => !Number.isNaN(x.num) && x.num > 0)
        .sort((a, b) => a.num - b.num);

      for (let i = 0; i < numericOpts.length - 1; i++) {
        if (numericOpts[i + 1].num === numericOpts[i].num + 1 && numericOpts[i].num >= 5) {
          return numericOpts[i + 1].opt;
        }
      }
    }

    // B. Pertanyaan tentang jumlah kolom (`columns`, `cols`, `kolom`, `variables`, `features`)
    if (
      /^\s*(columns|cols|kolom|features|variables|fields)\b/i.test(afterBlank) ||
      /\b(how\s+many\s+columns|jumlah\s+kolom|banyak\s+kolom)\b/i.test(sLower)
    ) {
      if (outputFacts?.explicitCols != null) {
        const match = optionsList.find((o) => Number((o.text || '').trim()) === outputFacts.explicitCols);
        if (match) return match;
      }
      if (outputFacts?.tableColCount != null) {
        const match = optionsList.find((o) => Number((o.text || '').trim()) === outputFacts.tableColCount);
        if (match) return match;
      }
    }

    // C. Pertanyaan tentang indeks terakhir (`last index`, `indeks terakhir`)
    if (/\b(last\s+index|final\s+index|indeks\s+terakhir)\b/i.test(sLower) && outputFacts?.lastIndexValue != null) {
      const match = optionsList.find((o) => Number((o.text || '').trim()) === outputFacts.lastIndexValue);
      if (match) return match;
    }

    // D. Skor umum berdasarkan kemunculan opsi di dalam teks output program & materi modul
    const scored = optionsList.map((opt, idx) => {
      const t = (opt.text || '').trim();
      const tLower = t.toLowerCase();
      let score = 0;

      if (tLower && rawOut.includes(tLower)) score += 20;
      if (tLower && modLower.includes(tLower)) score += 10;

      const numVal = Number(t);
      if (!Number.isNaN(numVal) && Array.isArray(outputFacts?.numbersInOutput)) {
        if (outputFacts.numbersInOutput.includes(numVal)) score += 15;
      }

      return { opt, score, idx };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].opt;
  },

  /**
   * Urutkan seluruh opsi rumpang hasil program dari yang paling tepat hingga alternatifnya
   * (agar jika pilihan pertama ditolak/salah oleh LMS, sistem dapat mencoba opsi berikutnya)
   */
  rankInlineBlankOptions(sentenceContext = '', optionsList = [], outputFacts = {}, moduleContext = '') {
    if (!optionsList || optionsList.length === 0) return [];
    const best = this.chooseBestInlineBlankOption(sentenceContext, optionsList, outputFacts, moduleContext);
    const rest = optionsList.filter((o) => o !== best);
    // Urutkan sisa opsi dari angka terbesar ke terkecil (misal 34 lalu 2)
    rest.sort((a, b) => {
      const nA = Number((a.text || '').trim());
      const nB = Number((b.text || '').trim());
      if (!Number.isNaN(nA) && !Number.isNaN(nB)) return nB - nA;
      return 0;
    });
    return best ? [best, ...rest] : rest;
  },

  /**
   * Bangun solusi urutan alternatif untuk percobaan ulang (Retry) jika percobaan pertama ditolak oleh LMS
   * Contoh: menukar urutan antara `import pandas as pd` dan `import matplotlib.pyplot as plt`
   */
  buildAlternativeSimulationSolution(simScan, prevSolution, pageData) {
    if (!this.isCodeSimulation(simScan)) {
      const heur = this.solveWithSmartHeuristics(
        {
          simulations: [simScan],
          mcqs: [],
          essays: [],
          moduleContext: pageData?.moduleContext || simScan?.instruction || ''
        },
        {}
      );
      const baseSim = (heur.simulations && heur.simulations[0]) || prevSolution || {};
      const seqIds = [...(baseSim.sequenceIds || [])];
      const seqLabels = [...(baseSim.sequenceLabels || [])];
      if (seqIds.length >= 2) {
        [seqIds[0], seqIds[1]] = [seqIds[1], seqIds[0]];
        [seqLabels[0], seqLabels[1]] = [seqLabels[1], seqLabels[0]];
      }
      return {
        ...baseSim,
        sequenceIds: seqIds,
        sequenceLabels: seqLabels
      };
    }

    const freshHeur = this.solveCodeBuilderHeuristic(simScan, pageData || {});
    const seqIds = [...(freshHeur.sequenceIds || [])];
    const seqLabels = [...(freshHeur.sequenceLabels || [])];

    // Cari dua pernyataan sejenis (misal dua baris `import ...`) lalu tukar posisinya
    if (seqLabels.length >= 2 && /^\s*(import|from)\s+/i.test(seqLabels[0]) && /^\s*(import|from)\s+/i.test(seqLabels[1])) {
      [seqIds[0], seqIds[1]] = [seqIds[1], seqIds[0]];
      [seqLabels[0], seqLabels[1]] = [seqLabels[1], seqLabels[0]];
    } else if (seqIds.length >= 2) {
      [seqIds[0], seqIds[1]] = [seqIds[1], seqIds[0]];
      [seqLabels[0], seqLabels[1]] = [seqLabels[1], seqLabels[0]];
    }

    return {
      ...freshHeur,
      sequenceIds: seqIds,
      sequenceLabels: seqLabels
    };
  },

  /**
   * Evaluasi opsi pilihan ganda yang berbentuk baris program Python / Pandas DataFrame
   * (Contoh: `df.query('count == 16')`, `df.sort_values('players', ascending=False)`, `df.head(3)`, `.str.replace(...)`)
   * terhadap tabel `df:` dan `result df:` serta mendeteksi pertanyaan negasi (`does NOT return`, `bukan`, `kecuali`).
   */
  evaluatePandasCodeOptions(rawQText = '', options = [], tableData = null) {
    const bonusMap = new Map();
    if (!Array.isArray(options) || options.length === 0) return bonusMap;

    const promptOnly = rawQText.replace(/\[Table\s*\d+:[\s\S]*$/i, '').trim();
    const isNegated =
      /\b(not|does\s+not|doesn't|will\s+not|won't|is\s+not|isn't|cannot|can't|except|bukan|tidak|kecuali|wrong|incorrect)\b/i.test(
        promptOnly
      );

    const dfRows = Array.isArray(tableData?.dfRows) ? tableData.dfRows : [];
    const resultRows = Array.isArray(tableData?.resultRows) ? tableData.resultRows : [];
    const colNames = Array.isArray(tableData?.colNames) ? tableData.colNames : [];

    const simResults = [];

    for (const opt of options) {
      const code = (opt.text || '').trim();
      let bonus = 0;

      // 1. Jika ada data tabel `df:`, simulasikan eksekusi baris kode pada `dfRows`
      if (dfRows.length > 0) {
        const sim = this.simulatePandasExpressionOnRows(code, dfRows, colNames);
        simResults.push({ optId: opt.id, code, sim });

        if (resultRows.length > 0 && sim.evaluated) {
          const matchesResult = this.rowsMatchResultTable(sim.rows, resultRows);
          if (isNegated) {
            // Pertanyaan negasi ("Which query does NOT return the result as shown?"):
            // Pilih opsi yang hasilnya TIDAK sama dengan `result df:` atau sintaksnya tidak valid!
            if (!matchesResult || !sim.validSyntax) {
              bonus += 260;
            } else {
              bonus -= 140;
            }
          } else {
            // Pertanyaan positif ("Which query returns the result as shown?"):
            // Pilih opsi yang hasilnya SAMA PERSIS dengan `result df:` dan sintaksnya valid!
            if (matchesResult && sim.validSyntax) {
              bonus += 260;
            } else {
              bonus -= 120;
            }
          }
        } else if (!sim.validSyntax) {
          bonus += isNegated ? 140 : -120;
        }
      }

      // 2. Pencocokan frasa matematika/urutan di kalimat soal terhadap operator di dalam baris program
      const pLower = promptOnly.toLowerCase();
      if (/\b(more\s+than|greater\s+than|above|larger\s+than|over|lebih\s+dari)\b/i.test(pLower)) {
        if (/[^<>=]>\s*[^=]/.test(code)) bonus += isNegated ? -50 : 75;
      }
      if (/\b(at\s+least|greater\s+than\s+or\s+equal|or\s+more|minimal|paling\s+sedikit)\b/i.test(pLower)) {
        if (/>=/.test(code)) bonus += isNegated ? -50 : 75;
      }
      if (/\b(less\s+than|fewer\s+than|below|smaller\s+than|under|kurang\s+dari)\b/i.test(pLower)) {
        if (/[^<>=]<\s*[^=]/.test(code)) bonus += isNegated ? -50 : 75;
      }
      if (/\b(at\s+most|less\s+than\s+or\s+equal|or\s+less|maksimal|paling\s+banyak)\b/i.test(pLower)) {
        if (/<=/.test(code)) bonus += isNegated ? -50 : 75;
      }
      if (/\b(not\s+equal|other\s+than|excluding|tidak\s+sama\s+dengan)\b/i.test(pLower)) {
        if (/!=/.test(code)) bonus += isNegated ? -50 : 75;
      }
      if (/\b(descending|highest\s+to\s+lowest|largest\s+to\s+smallest|most\s+to\s+least|terbesar\s+ke\s+terkecil)\b/i.test(pLower)) {
        if (/ascending\s*=\s*False/i.test(code)) bonus += isNegated ? -50 : 85;
      }
      if (/\b(ascending|lowest\s+to\s+highest|smallest\s+to\s+largest|least\s+to\s+most|terkecil\s+ke\s+terbesar)\b/i.test(pLower)) {
        if (/sort_values/i.test(code) && !/ascending\s*=\s*False/i.test(code)) {
          bonus += isNegated ? -50 : 70;
        }
      }

      bonusMap.set(opt.id, bonus);
    }

    // 3. Analisis Odd-One-Out (Jika 3 dari 4 opsi menghasilkan baris DataFrame yang identik dan 1 opsi menghasilkan hasil berbeda)
    if (simResults.length >= 3 && simResults.every((r) => r.sim.evaluated)) {
      const sigCounts = new Map();
      for (const item of simResults) {
        const sig = item.sim.validSyntax ? JSON.stringify(item.sim.rows) : `__INVALID__:${item.code}`;
        item.sig = sig;
        sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
      }
      if (isNegated) {
        for (const item of simResults) {
          if (sigCounts.get(item.sig) === 1 && simResults.length >= 3) {
            bonusMap.set(item.optId, (bonusMap.get(item.optId) || 0) + 180);
          }
        }
      }
    }

    return bonusMap;
  },

  /**
   * Simulasikan ekspresi Pandas (`df.query(...)`, `df.sort_values(...)`, `df.head(...)`, `df.tail(...)`, `.str.replace(...)`)
   * terhadap array objek baris `dfRows`.
   */
  simulatePandasExpressionOnRows(expr = '', dfRows = [], colNames = []) {
    let rows = dfRows.map((r) => ({ ...r }));
    let evaluated = false;
    let validSyntax = true;

    const knownColsLower = new Map();
    for (const c of colNames) {
      knownColsLower.set(c.toLowerCase(), c);
    }
    if (rows[0]) {
      for (const k of Object.keys(rows[0])) {
        knownColsLower.set(k.toLowerCase(), k);
      }
    }

    // A. Evaluasi `.query(...)`
    const queryRegex = /\.query\(\s*(['"])([\s\S]*?)\1\s*\)/g;
    let qMatch;
    while ((qMatch = queryRegex.exec(expr)) !== null) {
      evaluated = true;
      const queryStr = qMatch[2].trim();
      if (!queryStr) {
        validSyntax = false;
        continue;
      }
      // Cek apakah ada operator assignment tunggal `=` yang tidak valid di dalam query
      const strippedStrings = queryStr.replace(/['"][^'"]*['"]/g, '""');
      if (/(?<![=!<>])=(?!=)/.test(strippedStrings)) {
        validSyntax = false;
      }

      rows = rows.filter((row) => this.evalPandasQueryCondition(queryStr, row, knownColsLower, (v) => {
        if (!v) validSyntax = false;
      }));
    }

    // B. Evaluasi `.sort_values(...)`
    const sortMatch = expr.match(/\.sort_values\(\s*(?:by\s*=\s*)?['"]([^'"]+)['"]([\s\S]*?)\)/i);
    if (sortMatch) {
      evaluated = true;
      const rawCol = sortMatch[1].trim();
      const restArgs = sortMatch[2] || '';
      const actualCol = knownColsLower.get(rawCol.toLowerCase());
      if (!actualCol) {
        validSyntax = false;
      } else {
        const isDesc = /ascending\s*=\s*False/i.test(restArgs);
        rows.sort((a, b) => {
          const vA = a[actualCol];
          const vB = b[actualCol];
          const nA = Number(vA);
          const nB = Number(vB);
          let cmp = 0;
          if (!Number.isNaN(nA) && !Number.isNaN(nB)) {
            cmp = nA - nB;
          } else {
            cmp = String(vA ?? '').localeCompare(String(vB ?? ''));
          }
          return isDesc ? -cmp : cmp;
        });
      }
    }

    // C. Evaluasi `.head(n)` & `.tail(n)`
    const headMatch = expr.match(/\.head\(\s*(\d+)?\s*\)/i);
    if (headMatch) {
      evaluated = true;
      const n = headMatch[1] !== undefined ? Number(headMatch[1]) : 5;
      rows = rows.slice(0, n);
    }
    const tailMatch = expr.match(/\.tail\(\s*(\d+)?\s*\)/i);
    if (tailMatch) {
      evaluated = true;
      const n = tailMatch[1] !== undefined ? Number(tailMatch[1]) : 5;
      rows = n > 0 ? rows.slice(-n) : [];
    }

    // D. Evaluasi `.str.replace('old', 'new')` pada kolom
    const replaceMatch = expr.match(
      /df\[['"]([^'"]+)['"]\]\s*=\s*df\[['"]([^'"]+)['"]\]\.str\.replace\(\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]/i
    );
    if (replaceMatch) {
      evaluated = true;
      const targetCol = knownColsLower.get(replaceMatch[1].toLowerCase()) || replaceMatch[1];
      const sourceCol = knownColsLower.get(replaceMatch[2].toLowerCase());
      const oldSub = replaceMatch[3];
      const newSub = replaceMatch[4];
      if (!sourceCol) {
        validSyntax = false;
      } else {
        rows = rows.map((r) => ({
          ...r,
          [targetCol]: String(r[sourceCol] ?? '').split(oldSub).join(newSub)
        }));
      }
    }

    return { evaluated, validSyntax, rows };
  },

  /**
   * Evaluasi kondisi boolean di dalam `df.query('...')` untuk satu baris DataFrame
   */
  evalPandasQueryCondition(queryStr, row, knownColsLower, onSyntaxCheck) {
    const orParts = queryStr.split(/\s+(?:or|\|)\s+/i);
    if (orParts.length > 1) {
      return orParts.some((part) => this.evalPandasQueryCondition(part, row, knownColsLower, onSyntaxCheck));
    }

    const andParts = queryStr.split(/\s+(?:and|&)\s+/i);
    if (andParts.length > 1) {
      return andParts.every((part) => this.evalPandasQueryCondition(part, row, knownColsLower, onSyntaxCheck));
    }

    let clause = queryStr.trim().replace(/^\(+|\)+$/g, '').trim();
    let negateClause = false;
    if (/^(?:not\s+|~)/i.test(clause)) {
      negateClause = true;
      clause = clause.replace(/^(?:not\s+|~)/i, '').trim();
    }

    const cmpMatch = clause.match(/^([a-zA-Z_][\w\s]*?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
    if (!cmpMatch) {
      if (onSyntaxCheck) onSyntaxCheck(false);
      return false;
    }

    const lhsRaw = cmpMatch[1].trim().replace(/^`|`$/g, '');
    const op = cmpMatch[2];
    const rhsRaw = cmpMatch[3].trim();

    const actualCol = knownColsLower.get(lhsRaw.toLowerCase());
    if (!actualCol) {
      if (onSyntaxCheck) onSyntaxCheck(false);
      return false;
    }

    const lhsVal = row[actualCol];
    let rhsVal = rhsRaw;
    const isQuoted = /^(['"])([\s\S]*)\1$/.test(rhsRaw);
    const isNum = !Number.isNaN(Number(rhsRaw)) && rhsRaw !== '';
    const rhsCol = !isQuoted && !isNum ? knownColsLower.get(rhsRaw.toLowerCase()) : null;

    if (isQuoted) {
      rhsVal = rhsRaw.slice(1, -1);
    } else if (isNum) {
      rhsVal = Number(rhsRaw);
    } else if (rhsCol) {
      rhsVal = row[rhsCol];
    } else if (/^(true|false)$/i.test(rhsRaw)) {
      rhsVal = /^true$/i.test(rhsRaw);
    } else {
      // String literal tanpa tanda kutip di dalam df.query (misal `species == koala`) -> NameError di Pandas!
      if (onSyntaxCheck) onSyntaxCheck(false);
      rhsVal = rhsRaw;
    }

    const lhsNum = Number(lhsVal);
    const rhsNum = Number(rhsVal);
    const bothNum = !isQuoted && !Number.isNaN(lhsNum) && !Number.isNaN(rhsNum);

    const a = bothNum ? lhsNum : String(lhsVal ?? '').trim();
    const b = bothNum ? rhsNum : String(rhsVal ?? '').trim();

    let res = false;
    switch (op) {
      case '==':
        res = a === b;
        break;
      case '!=':
        res = a !== b;
        break;
      case '<':
        res = a < b;
        break;
      case '>':
        res = a > b;
        break;
      case '<=':
        res = a <= b;
        break;
      case '>=':
        res = a >= b;
        break;
      default:
        res = false;
    }

    return negateClause ? !res : res;
  },

  /**
   * Bandingkan apakah baris hasil simulasi (`simRows`) sama dengan baris tabel `result df:` (`resultRows`)
   */
  rowsMatchResultTable(simRows = [], resultRows = []) {
    if (simRows.length !== resultRows.length) return false;
    for (let i = 0; i < resultRows.length; i++) {
      const rExp = resultRows[i];
      const rSim = simRows[i];
      if (!rSim) return false;
      for (const key of Object.keys(rExp)) {
        const vExp = String(rExp[key] ?? '').trim();
        const vSim = String(rSim[key] ?? '').trim();
        if (vExp !== vSim) {
          const nExp = Number(vExp);
          const nSim = Number(vSim);
          if (Number.isNaN(nExp) || Number.isNaN(nSim) || Math.abs(nExp - nSim) > 1e-6) {
            return false;
          }
        }
      }
    }
    return true;
  },

  /**
   * Basis Pengetahuan & Heuristik AWS Cloud Computing (untuk Knowledge Check di AWS Skill Builder / AWS Academy)
   * Membantu memilih opsi layanan/konsep AWS yang paling akurat bahkan tanpa koneksi API LLM eksternal!
   */
  evaluateAWSCloudKnowledgeOptions(rawQText = '', options = []) {
    const bonusMap = new Map();
    if (!Array.isArray(options) || options.length === 0) return bonusMap;

    const qLower = rawQText.toLowerCase();
    const isNegated = /\b(not|except|false|incorrect|bukan|kecuali)\b/i.test(qLower);

    const awsRules = [
      {
        q: /\b(object\s+storage|store\s+objects|unstructured\s+data|static\s+website\s+hosting|99\.999999999%|11\s+9s)\b/i,
        a: /\b(amazon\s+s3|simple\s+storage\s+service|s3)\b/i
      },
      {
        q: /\b(virtual\s+server|resizable\s+compute\s+capacity|virtual\s+machine|iaas\s+compute|ec2\s+instance)\b/i,
        a: /\b(amazon\s+ec2|elastic\s+compute\s+cloud|ec2)\b/i
      },
      {
        q: /\b(serverless\s+compute|run\s+code\s+without\s+provisioning|event-driven\s+code)\b/i,
        a: /\b(aws\s+lambda|lambda)\b/i
      },
      {
        q: /\b(isolated\s+virtual\s+network|virtual\s+network\s+dedicated|subnets|route\s+tables|internet\s+gateway)\b/i,
        a: /\b(amazon\s+vpc|virtual\s+private\s+cloud|vpc)\b/i
      },
      {
        q: /\b(users,\s*groups,\s*and\s*roles|permissions|access\s+to\s+aws\s+services\s+and\s+resources|least\s+privilege|authentication\s+and\s+authorization)\b/i,
        a: /\b(aws\s+iam|identity\s+and\s+access\s+management|iam)\b/i
      },
      {
        q: /\b(relational\s+database|sql\s+database|mysql|postgresql|oracle|aurora)\b/i,
        a: /\b(amazon\s+rds|relational\s+database\s+service|amazon\s+aurora|rds)\b/i
      },
      {
        q: /\b(nosql\s+database|key-value|millisecond\s+latency\s+at\s+any\s+scale)\b/i,
        a: /\b(amazon\s+dynamodb|dynamodb)\b/i
      },
      {
        q: /\b(content\s+delivery\s+network|cdn|edge\s+locations|low\s+latency\s+content)\b/i,
        a: /\b(amazon\s+cloudfront|cloudfront)\b/i
      },
      {
        q: /\b(domain\s+name\s+system|dns\s+web\s+service|route\s+end\s+users)\b/i,
        a: /\b(amazon\s+route\s*53|route\s*53)\b/i
      },
      {
        q: /\b(distribute\s+incoming\s+application\s+traffic|load\s+balancing|across\s+multiple\s+targets)\b/i,
        a: /\b(elastic\s+load\s+balancing|elb|application\s+load\s+balancer|alb)\b/i
      },
      {
        q: /\b(automatically\s+add\s+or\s+remove\s+ec2|scale\s+compute\s+capacity|match\s+demand)\b/i,
        a: /\b(auto\s+scaling|amazon\s+ec2\s+auto\s+scaling)\b/i
      },
      {
        q: /\b(monitor\s+aws\s+resources|metrics\s+and\s+logs|alarms|cloudwatch\s+alarm)\b/i,
        a: /\b(amazon\s+cloudwatch|cloudwatch)\b/i
      },
      {
        q: /\b(audit|api\s+calls|track\s+user\s+activity|governance\s+and\s+compliance\s+of\s+your\s+aws\s+account)\b/i,
        a: /\b(aws\s+cloudtrail|cloudtrail)\b/i
      },
      {
        q: /\b(infrastructure\s+as\s+code|provision\s+resources\s+using\s+templates|json\s+or\s+yaml\s+templates)\b/i,
        a: /\b(aws\s+cloudformation|cloudformation)\b/i
      },
      {
        q: /\b(shared\s+responsibility\s+model)\b[\s\S]*\b(customer\s+responsibility|responsible\s+for\s+security\s+in\s+the\s+cloud)\b/i,
        a: /\b(customer\s+data|iam|operating\s+system|network\s+and\s+firewall|security\s+group|encryption|patch\s+guest\s+os)\b/i
      },
      {
        q: /\b(shared\s+responsibility\s+model)\b[\s\S]*\b(aws\s+responsibility|security\s+of\s+the\s+cloud)\b/i,
        a: /\b(physical\s+security|data\s+center|hardware|hypervisor|global\s+infrastructure)\b/i
      },
      {
        q: /\b(estimate\s+the\s+cost|estimate\s+aws\s+costs|cost\s+of\s+architecture)\b/i,
        a: /\b(aws\s+pricing\s+calculator|pricing\s+calculator)\b/i
      },
      {
        q: /\b(long-term\s+archive|data\s+archiving|low-cost\s+archive)\b/i,
        a: /\b(glacier|s3\s+glacier)\b/i
      },
      {
        q: /\b(block\s+level\s+storage|block\s+storage\s+volumes\s+for\s+use\s+with\s+ec2)\b/i,
        a: /\b(amazon\s+ebs|elastic\s+block\s+store|ebs)\b/i
      }
    ];

    for (const opt of options) {
      const optTxt = (opt.text || '').trim();
      let bonus = 0;
      for (const rule of awsRules) {
        if (rule.q.test(qLower) && rule.a.test(optTxt)) {
          bonus += isNegated ? -85 : 95;
        }
      }
      if (bonus !== 0) {
        bonusMap.set(opt.id, bonus);
      }
    }

    return bonusMap;
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSAIClient = LMSAIClient;
}
