import type { SpeechConfig } from "./speech-settings";

const ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
const SAMPLE_RATE = 24000;

export interface SpeechFrame {
  code: number;
  message?: string;
  data?: string;
}

/** HTTP chunks can split JSON lines or UTF-8 characters at any byte. */
export async function* speechFrames(
  response: Response,
): AsyncGenerator<SpeechFrame> {
  if (!response.ok)
    throw new Error(
      `豆包朗读请求失败（HTTP ${response.status}），请检查服务和凭证。`,
    );
  if (!response.body) throw new Error("豆包未返回语音数据，请重试。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (done && pending.trim()) {
        lines.push(pending);
        pending = "";
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as SpeechFrame;
        if (frame.code !== 0 && frame.code !== 20000000) {
          throw new Error(
            `豆包语音合成失败（${frame.code}），请检查服务额度、凭证和音色。`,
          );
        }
        yield frame;
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Stream PCM into scheduled buffers; stop aborts both the request and playback. */
export function playDoubaoSpeech(
  text: string,
  rate: number,
  config: SpeechConfig,
) {
  const controller = new AbortController();
  const context = new AudioContext();
  const sources = new Set<AudioBufferSourceNode>();
  let cancelWait: (() => void) | undefined;
  let cancelled = false;
  const done = (async () => {
    try {
      await context.resume();
      const response = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": config.apiKey,
          "X-Api-Resource-Id": "seed-tts-2.0",
          "X-Api-Request-Id": crypto.randomUUID(),
        },
        body: JSON.stringify({
          req_params: {
            text,
            speaker: config.speaker,
            audio_params: {
              format: "pcm",
              sample_rate: SAMPLE_RATE,
              speech_rate: Math.round(
                (Math.min(2, Math.max(0.5, rate)) - 1) * 100,
              ),
            },
            additions: JSON.stringify({
              disable_markdown_filter: true,
              latex_parser: "v2",
            }),
          },
        }),
      });
      let cursor = context.currentTime;
      let tail: number | undefined;
      let samples = 0;
      for await (const frame of speechFrames(response)) {
        if (cancelled) break;
        if (!frame.data) continue;
        const raw = atob(frame.data);
        const bytes = new Uint8Array(raw.length + (tail === undefined ? 0 : 1));
        let offset = 0;
        if (tail !== undefined) bytes[offset++] = tail;
        for (let i = 0; i < raw.length; i++)
          bytes[offset + i] = raw.charCodeAt(i);
        const count = Math.floor(bytes.length / 2);
        tail = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
        if (!count) continue;
        const buffer = context.createBuffer(1, count, SAMPLE_RATE);
        const floats = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < count; i++)
          floats[i] = view.getInt16(i * 2, true) / 32768;
        const source = context.createBufferSource();
        source.buffer = buffer;
        source.connect(context.destination);
        sources.add(source);
        source.onended = () => {
          sources.delete(source);
          if (!sources.size) cancelWait?.();
        };
        cursor = Math.max(cursor, context.currentTime + 0.025);
        source.start(cursor);
        cursor += buffer.duration;
        samples += count;
      }
      if (cancelled) return;
      if (!samples) throw new Error("豆包未返回可播放的语音，请检查音色设置。");
      if (tail !== undefined)
        throw new Error("豆包返回的语音数据不完整，请重试。");
      if (sources.size)
        await new Promise<void>((resolve) => {
          cancelWait = resolve;
        });
    } finally {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* Already ended. */
        }
      }
      sources.clear();
      await context.close().catch(() => undefined);
    }
  })();
  return {
    done,
    cancel: () => {
      cancelled = true;
      controller.abort();
      for (const source of sources) {
        try {
          source.stop();
        } catch {
          /* Already ended. */
        }
      }
      sources.clear();
      cancelWait?.();
    },
  };
}
