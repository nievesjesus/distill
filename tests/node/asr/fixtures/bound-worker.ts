import { pcmStream } from '../../../../src/node/asr/decode';
import { bindToParent, readRequest } from '../../../../src/node/asr/lifecycle';

const { request, closed } = await readRequest<{ input: string; ffmpeg: string }>(process.stdin);
const controller = new AbortController();
bindToParent(closed, controller);
for await (const _chunk of pcmStream(request.input, { ffmpeg: request.ffmpeg, signal: controller.signal })) {
}
