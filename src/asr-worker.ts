import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pcmStream } from './node/asr/decode';
import { AsrError } from './node/asr/errors';
import { bindToParent, readRequest } from './node/asr/lifecycle';
import { runPipeline } from './node/asr/pipeline';
import type { PipelineEvent } from './node/asr/pipeline';

interface WorkerRequest {
  runtimeRoot: string;
  modelDir: string;
  vadPath: string;
  input: string;
  threads: number;
  ffmpeg: string | null;
}

function write(event: unknown): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, () => resolve());
  });
}

function loadSherpa(runtimeRoot: string): any {
  try {
    return createRequire(join(runtimeRoot, 'package.json'))('sherpa-onnx-node');
  } catch (error) {
    throw new AsrError('asr_unavailable', `Speech recognition runtime could not be loaded: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  const controller = new AbortController();
  process.on('SIGTERM', () => {
    controller.abort();
    process.exit(143);
  });
  const { request: req, closed } = await readRequest<WorkerRequest>(process.stdin);
  bindToParent(closed, controller);
  const sherpa = loadSherpa(req.runtimeRoot);
  const recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(req.modelDir, 'encoder.int8.onnx'),
        decoder: join(req.modelDir, 'decoder.int8.onnx'),
        joiner: join(req.modelDir, 'joiner.int8.onnx'),
      },
      tokens: join(req.modelDir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads: req.threads,
      provider: 'cpu',
      debug: 0,
    },
  });
  const vad = new sherpa.Vad(
    {
      sileroVad: { model: req.vadPath, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.5, maxSpeechDuration: 20, windowSize: 512 },
      sampleRate: 16000,
      numThreads: 1,
      debug: 0,
    },
    60,
  );
  const pending: Promise<void>[] = [];
  await runPipeline({
    pcm: pcmStream(req.input, { ffmpeg: req.ffmpeg, signal: controller.signal }),
    vad: {
      acceptWaveform: (samples) => vad.acceptWaveform(samples),
      isEmpty: () => vad.isEmpty(),
      front: () => vad.front(false),
      pop: () => vad.pop(),
      flush: () => vad.flush(),
    },
    recognize: (samples) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);
      return { text: String(result.text ?? ''), lang: result.lang ? String(result.lang) : undefined };
    },
    emit: (event: PipelineEvent) => {
      pending.push(write(event));
    },
  });
  await Promise.all(pending);
}

main().then(
  () => process.exit(0),
  async (error: unknown) => {
    const code = error instanceof AsrError ? error.code : 'asr_failed';
    const message = error instanceof Error ? error.message : String(error);
    await write({ type: 'error', code, message });
    process.exit(1);
  },
);
