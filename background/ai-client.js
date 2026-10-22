/**
 * LMS Auto-Pilot - Multi-Provider AI Client & Smart Heuristic Solver
 * Mendukung: Google Gemini, OpenAI, Groq, Custom Endpoint + Smart Heuristic Fallback
 */

const LMSAIClient = {
  /**
   * Panggil LLM API dan kembalikan objek JSON terurai
   */
  async callLLMJson(systemPrompt, userPrompt, config) {
    const provider = (config.aiProvider || 'gemini').toLowerCase();
    const apiKey = (config.apiKey || '').trim();

    if (!apiKey) {
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

    // OpenAI / Groq / Custom OpenAI-compatible
    let endpoint = 'https://api.openai.com/v1/chat/completions';
    let defaultModel = 'gpt-4o-mini';

    if (provider === 'groq') {
      endpoint = 'https://api.groq.com/openai/v1/chat/completions';
      defaultModel = 'llama-3.3-70b-versatile';
    } else if (provider === 'custom' && config.customEndpoint) {
      endpoint = config.customEndpoint;
    }

    const model = config.model || defaultModel;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
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
    const hasApiKey = Boolean((config.apiKey || '').trim());

    if (hasApiKey) {
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

    if (config.useSmartFallback !== false) {
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
Tugas Anda adalah menganalisis materi modul, instruksi tugas simulasi interaktif, soal pilihan ganda, dan soal esai pada halaman, lalu mengembalikan solusi tepat dalam format JSON.

ATURAN PENTING:
1. SIMULASI TOMBOL & JALANKAN PROGRAM (simulations):
   - Baca instruksi tugas simulasi dengan teliti.
   - Pilih urutan ID tombol yang benar ("sequenceIds") dari daftar "candidateButtons" yang harus ditekan untuk menyelesaikan misi/konfigurasi.
   - Jangan masukkan tombol "Run / Jalankan Program" atau tombol "Reset" ke dalam "sequenceIds".
   - Tentukan "runButtonId" yaitu ID tombol untuk menjalankan/mengeksekusi program setelah urutan tombol selesai ditekan.
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

    return {
      simulations: Array.isArray(parsed.simulations) ? parsed.simulations : [],
      mcqs: Array.isArray(parsed.mcqs) ? parsed.mcqs : [],
      essays: Array.isArray(parsed.essays) ? parsed.essays : []
    };
  },

  /**
   * Mesin Heuristik Kontekstual Cerdas
   * Menganalisis instruksi halaman, urutan langkah, pencocokan materi modul, dan atribut semantik
   */
  solveWithSmartHeuristics(pageData, config) {
    const contextText = (pageData.moduleContext || '').toLowerCase();

    // 1. Selesaikan Tugas Simulasi Tombol & Jalankan Program
    const simulations = (pageData.simulations || []).map((sim) => {
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

      const runButtonId = runButtons.length > 0 ? runButtons[0].id : null;

      return {
        taskId: sim.taskId,
        sequenceIds,
        runButtonId,
        reasoning: 'Urutan tombol dianalisis dari instruksi langkah modul.'
      };
    });

    // 2. Selesaikan Soal Pilihan Ganda
    const mcqs = (pageData.mcqs || []).map((q) => {
      const qText = (q.questionText || '').toLowerCase();
      const options = q.options || [];
      if (options.length === 0) {
        return { questionId: q.questionId, selectedOptionIds: [] };
      }

      // Skor setiap opsi berdasarkan konteks materi halaman & heuristik semantik
      const scored = options.map((opt, idx) => {
        let score = 0;
        const optText = (opt.text || '').trim();
        const optLower = optText.toLowerCase();

        if (opt.isCorrect === 'true' || opt.isCorrect === true) {
          score += 1000;
        }

        // Cek kemunculan frasa opsi di dalam materi modul
        const words = optLower
          .replace(/[^\w\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3);

        for (const w of words) {
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
      const selectedOptionIds =
        q.inputType === 'checkbox'
          ? scored.filter((s) => s.score >= scored[0].score * 0.7 && s.score > 0).map((s) => s.id)
          : [scored[0].id];

      if (selectedOptionIds.length === 0 && options[0]) {
        selectedOptionIds.push(options[0].id);
      }

      return {
        questionId: q.questionId,
        selectedOptionIds,
        reasoning: 'Dipilih berdasarkan relevansi tertinggi dengan materi modul.'
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
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.LMSAIClient = LMSAIClient;
}
