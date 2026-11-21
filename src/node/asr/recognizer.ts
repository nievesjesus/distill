export interface WorkerModel {
  kind: 'transducer' | 'whisper';
  files: { encoder: string; decoder: string; joiner?: string; tokens: string };
}

const LANGUAGE_SAMPLE = 5;

export function majorityLanguage(langs: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const lang of langs) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

export interface LanguageLock {
  observe(lang: string | undefined): string | undefined;
  current(): string | undefined;
  final(): string | undefined;
}

export function createLanguageLock(options: { forced?: string; after?: number }): LanguageLock {
  const after = options.after ?? LANGUAGE_SAMPLE;
  const seen: string[] = [];
  let fixed = options.forced;
  return {
    observe(lang) {
      if (fixed !== undefined) return undefined;
      if (!lang) return undefined;
      seen.push(lang);
      if (seen.length < after) return undefined;
      fixed = majorityLanguage(seen);
      return fixed;
    },
    current: () => fixed,
    final: () => fixed ?? majorityLanguage(seen),
  };
}

export function buildRecognizerConfig(model: WorkerModel, threads: number, language?: string): any {
  const common = { tokens: model.files.tokens, numThreads: threads, provider: 'cpu', debug: 0 };
  if (model.kind === 'whisper') {
    return {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: model.files.encoder, decoder: model.files.decoder, language: language ?? '', task: 'transcribe', tailPaddings: -1 },
        ...common,
      },
    };
  }
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: model.files.encoder, decoder: model.files.decoder, joiner: model.files.joiner },
      tokens: model.files.tokens,
      modelType: 'nemo_transducer',
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  };
}

export interface RecognitionOptions {
  sherpa: any;
  model: WorkerModel;
  threads: number;
  language?: string;
  onLanguage?: (lang: string) => void;
}

export interface Recognition {
  recognize(samples: Float32Array): { text: string; lang?: string };
  language(): string | undefined;
}

export function createRecognition(options: RecognitionOptions): Recognition {
  const { model, threads } = options;
  const whisper = model.kind === 'whisper';
  const forced = whisper ? options.language : undefined;
  const recognizer = new options.sherpa.OfflineRecognizer(buildRecognizerConfig(model, threads, forced));
  const lock = createLanguageLock({ forced });
  if (forced) options.onLanguage?.(forced);
  return {
    recognize(samples) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      const text = String(result.text ?? '');
      const lang = result.lang ? String(result.lang) : undefined;
      if (whisper && text.trim() !== '') {
        const fixed = lock.observe(lang);
        if (fixed) {
          recognizer.setConfig(buildRecognizerConfig(model, threads, fixed));
          options.onLanguage?.(fixed);
        }
      }
      return { text, lang };
    },
    language: () => (whisper ? lock.final() : undefined),
  };
}
