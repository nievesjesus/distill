export type AsrModelName = 'parakeet' | 'whisper-turbo' | 'whisper-small';
export type AsrModelKind = 'transducer' | 'whisper';

export interface AsrModelFile {
  name: string;
  url: string;
  size: number;
  sha256: string;
}

export interface AsrModelSpec {
  name: AsrModelName;
  id: string;
  kind: AsrModelKind;
  engine: string;
  languages: string;
  files: readonly AsrModelFile[];
  autoSeconds: number;
  timeoutFactor: number;
}

const hf = (repo: string, commit: string) => (name: string) => `https://huggingface.co/${repo}/resolve/${commit}/${name}`;

const parakeetUrl = hf('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'ed5d745623472f97cfc2e6c2916ee248798fc5a8');
const turboUrl = hf('csukuangfj/sherpa-onnx-whisper-turbo', '2ca6ff69fc878651b770880507669577ac41c2ff');
const smallUrl = hf('csukuangfj/sherpa-onnx-whisper-small', '8f3c18b358db4d1f2fc1eae49d75cd20989e4309');

const file = (url: (name: string) => string, name: string, size: number, sha256: string): AsrModelFile => ({ name, url: url(name), size, sha256 });

export const ASR_MODELS: Readonly<Record<AsrModelName, AsrModelSpec>> = {
  parakeet: {
    name: 'parakeet',
    id: 'parakeet-tdt-0.6b-v3-int8',
    kind: 'transducer',
    engine: 'local ASR (Parakeet TDT 0.6B v3)',
    languages: '25 European languages',
    autoSeconds: 600,
    timeoutFactor: 2,
    files: [
      file(parakeetUrl, 'encoder.int8.onnx', 652282294, '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479'),
      file(parakeetUrl, 'decoder.int8.onnx', 11845274, '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5'),
      file(parakeetUrl, 'joiner.int8.onnx', 6355277, 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98'),
      file(parakeetUrl, 'tokens.txt', 93939, 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'),
    ],
  },
  'whisper-turbo': {
    name: 'whisper-turbo',
    id: 'whisper-turbo-int8',
    kind: 'whisper',
    engine: 'local ASR (Whisper large-v3-turbo)',
    languages: 'about 99 languages',
    autoSeconds: 90,
    timeoutFactor: 4,
    files: [
      file(turboUrl, 'turbo-encoder.int8.onnx', 674716297, 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b'),
      file(turboUrl, 'turbo-decoder.int8.onnx', 361080764, '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547'),
      file(turboUrl, 'turbo-tokens.txt', 816730, 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'),
    ],
  },
  'whisper-small': {
    name: 'whisper-small',
    id: 'whisper-small-int8',
    kind: 'whisper',
    engine: 'local ASR (Whisper small)',
    languages: 'about 99 languages',
    autoSeconds: 120,
    timeoutFactor: 4,
    files: [
      file(smallUrl, 'small-encoder.int8.onnx', 112442483, '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9'),
      file(smallUrl, 'small-decoder.int8.onnx', 262226114, 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee'),
      file(smallUrl, 'small-tokens.txt', 816730, 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126'),
    ],
  },
};

export const ASR_MODEL_NAMES: readonly AsrModelName[] = ['parakeet', 'whisper-turbo', 'whisper-small'];
export const DEFAULT_ASR_MODEL: AsrModelName = 'parakeet';

export function isAsrModelName(value: unknown): value is AsrModelName {
  return typeof value === 'string' && (ASR_MODEL_NAMES as readonly string[]).includes(value);
}

export function isAsrLanguage(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,3}$/.test(value);
}

export function modelBytes(spec: AsrModelSpec): number {
  return spec.files.reduce((sum, f) => sum + f.size, 0);
}

export function modelFileOf(spec: AsrModelSpec, role: 'encoder' | 'decoder' | 'joiner' | 'tokens'): AsrModelFile | undefined {
  if (role === 'tokens') return spec.files.find((f) => f.name.endsWith('tokens.txt'));
  return spec.files.find((f) => f.name.includes(role));
}
