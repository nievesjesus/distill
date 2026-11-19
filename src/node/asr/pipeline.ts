import { SAMPLE_RATE, VAD_WINDOW, WindowFeeder } from './decode';

export interface VadLike {
  acceptWaveform(samples: Float32Array): void;
  isEmpty(): boolean;
  front(): { start: number; samples: Float32Array };
  pop(): void;
  flush(): void;
}

export type PipelineEvent =
  | { type: 'segment'; start: number; end: number; text: string; lang?: string }
  | { type: 'progress'; seconds: number }
  | { type: 'done'; duration: number };

export interface PipelineOptions {
  pcm: AsyncIterable<Float32Array>;
  vad: VadLike;
  recognize: (samples: Float32Array) => { text: string; lang?: string };
  emit: (event: PipelineEvent) => void;
  progressEverySeconds?: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export async function runPipeline(options: PipelineOptions): Promise<{ duration: number }> {
  const { vad, recognize, emit } = options;
  const feeder = new WindowFeeder(VAD_WINDOW);
  const every = options.progressEverySeconds ?? 5;
  let lastProgress = 0;

  const drain = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front();
      vad.pop();
      const result = recognize(segment.samples);
      const text = result.text.trim();
      if (text === '') continue;
      emit({
        type: 'segment',
        start: round3(segment.start / SAMPLE_RATE),
        end: round3(Math.min(segment.start + segment.samples.length, feeder.fed) / SAMPLE_RATE),
        text,
        ...(result.lang ? { lang: result.lang } : {}),
      });
    }
  };

  for await (const chunk of options.pcm) {
    for (const window of feeder.push(chunk)) vad.acceptWaveform(window);
    drain();
    const seconds = feeder.fed / SAMPLE_RATE;
    if (seconds - lastProgress >= every) {
      lastProgress = seconds;
      emit({ type: 'progress', seconds: round3(seconds) });
    }
  }
  const tail = feeder.flush();
  if (tail) vad.acceptWaveform(tail);
  vad.flush();
  drain();
  const duration = round3(feeder.fed / SAMPLE_RATE);
  emit({ type: 'done', duration });
  return { duration };
}
