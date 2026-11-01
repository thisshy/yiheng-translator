import { describe, expect, it, vi } from "vitest";
import {
  speechFrames,
  playDoubaoSpeech,
} from "../../src/ui/sidepanel/doubao-speech";

function responseFor(parts: string[], status = 200) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const part of parts) c.enqueue(encoder.encode(part));
        c.close();
      },
    }),
    { status },
  );
}

describe("Doubao streaming speech", () => {
  it("reassembles split NDJSON frames including the final unterminated line", async () => {
    const frames = [];
    for await (const frame of speechFrames(
      responseFor([
        '{"code":0,"da',
        'ta":"AQI="}\n\n{"code":0,',
        '"data":"AwQ="}',
      ]),
    ))
      frames.push(frame);
    expect(frames).toEqual([
      { code: 0, data: "AQI=" },
      { code: 0, data: "AwQ=" },
    ]);
  });

  it("rejects provider errors without echoing secret-bearing response messages", async () => {
    const run = async () => {
      for await (const frame of speechFrames(
        responseFor([
          '{"code":45000000,"message":"secret-key-should-not-leak"}\n',
        ]),
      ))
        void frame;
    };
    await expect(run()).rejects.toThrow("45000000");
    await expect(run()).rejects.not.toThrow("secret-key-should-not-leak");
  });

  it("stops scheduled audio and aborts a pending network request", async () => {
    let signal: AbortSignal | undefined;
    const stop = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const source = {
      connect: vi.fn(),
      start: vi.fn(),
      stop,
      onended: null,
      buffer: null,
    };
    class Context {
      currentTime = 0;
      destination = {};
      resume = vi.fn().mockResolvedValue(undefined);
      close = close;
      createBuffer() {
        return {
          getChannelData: () => new Float32Array(2),
          duration: 2 / 24000,
        };
      }
      createBufferSource() {
        return source;
      }
    }
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, options) => {
        signal = options.signal;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode('{"code":0,"data":"AQACAA=="}\n'),
              );
              signal?.addEventListener("abort", () =>
                c.error(new DOMException("Aborted", "AbortError")),
              );
            },
          }),
        );
      }),
    );
    try {
      const playback = playDoubaoSpeech("测试", 0.5, {
        provider: "doubao",
        apiKey: "test-key",
        speaker: "voice",
      });
      const rejected = playback.done.catch(() => undefined);
      await vi.waitFor(() => expect(source.start).toHaveBeenCalled());
      playback.cancel();
      await rejected;
      expect(signal?.aborted).toBe(true);
      expect(stop).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
      const request = JSON.parse(
        vi.mocked(fetch).mock.calls[0][1]!.body as string,
      );
      expect(request.req_params.audio_params.speech_rate).toBe(-50);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
