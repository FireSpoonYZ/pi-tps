import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createTestFixture, activateExtension, tick } from './helpers';

describe('pi-tps extension — precision timing (performance.now())', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Drive a full turn with mocked performance.now() timestamps.
   * This avoids real-timer flakiness and tests sub-millisecond precision
   * that Date.now() (1ms floor) would lose.
   *
   * `streamUpdates` provides timestamps for non-TTFT message_update events.
   * The request duration comes from the final assistant message.
   */
  function driveTurn(clocks: {
    turnStart: number;
    messageStart: number;
    firstUpdate: number;
    streamUpdates: number[];
    messageEnd: number;
    requestMs?: number;
    turnEnd?: number;
  }) {
    const { handlers, notifySpy, appendEntrySpy } = fixture;

    // Explicit sequence of performance.now() return values in call order:
    // turnStartMs, lastUpdateMs (both at turn start), message_start,
    // first message_update (TTFT), each streaming message_update,
    // message_end, turnEndMs
    const timestamps = [
      clocks.turnStart, // turnStartMs
      clocks.turnStart, // lastUpdateMs (same moment as turn start)
      clocks.messageStart, // message_start: currentMessageStartMs + lastUpdateMs reset
      clocks.firstUpdate, // message_update (TTFT): firstTokenMs
      ...clocks.streamUpdates, // streaming message_update events
      clocks.messageEnd, // message_end: generation time end
      clocks.turnEnd ?? clocks.messageEnd, // turnEndMs
    ];

    let callIdx = 0;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => {
      return timestamps[Math.min(callIdx++, timestamps.length - 1)];
    });

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Short reply' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: {
        input: 50,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 70,
        cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    // TTFT update
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 't' },
    });
    // Streaming updates (each is a non-TTFT message_update)
    for (const _ts of clocks.streamUpdates) {
      handlers['message_update']?.({
        type: 'message_update',
        message: assistantMessage,
        assistantMessageEvent: { type: 'text_delta', delta: 't' },
      });
    }
    handlers['message_end']?.({
      type: 'message_end',
      message: Object.assign(assistantMessage, { durationMs: clocks.requestMs }),
    });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    spy.mockRestore();
    return { notifySpy, appendEntrySpy };
  }

  it('should use native request duration for TPS', () => {
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 200,
      firstUpdate: 200.123,
      streamUpdates: [400, 500, 600, 700, 800],
      messageEnd: 900,
      requestMs: 1000,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS 20.0 tok/s');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.requestMs).toBe(1000);
    expect(data.timing.generationMs).toBeGreaterThanOrEqual(690);
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(190);
    expect(data.timing.streamMs).toBe(400); // 800 - 400
  });

  it('should capture sub-millisecond TTFT precision', () => {
    const { appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 23.456,
      firstUpdate: 23.579,
      streamUpdates: [100, 200, 300, 400, 523],
      messageEnd: 523.456,
    });

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.ttftMs).toBeGreaterThanOrEqual(23);
    expect(data.timing.ttftMs).toBeLessThanOrEqual(24);
  });

  it('should leave TPS blank when Pi supplies no request duration', () => {
    // Simulate a legacy provider that sends updates without a native duration.
    const { notifySpy, appendEntrySpy } = driveTurn({
      turnStart: 0,
      messageStart: 100,
      firstUpdate: 100.05,
      streamUpdates: [100.05], // 1 post-TTFT update
      messageEnd: 100.5,
    });

    expect(notifySpy).toHaveBeenCalledOnce();
    const notification = notifySpy.mock.calls[0][0] as string;
    expect(notification).toContain('TPS —');

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThan(0);
    expect(data.timing.streamMs).toBe(0);
    expect(data.tps).toBeNull();
  });

  it('should use performance.now() consistently across all timing events', () => {
    const { handlers, appendEntrySpy } = fixture;
    const spy = vi.spyOn(performance, 'now');
    // turn_start(2), message_start(1), message_update-TTFT(1),
    // 5 streaming updates(5), message_end(1), turn_end(1) = 11 calls
    // indices: 0-1=turn_start, 2=message_start, 3=TTFT,
    // 4-8=streaming, 9=message_end, 10=turn_end
    const timestamps = [0, 0, 100, 100.001, 100.5, 101, 101.2, 101.4, 101.8, 102, 102];
    let callIdx = 0;
    spy.mockImplementation(() => timestamps[Math.min(callIdx++, timestamps.length - 1)]);

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi world test example' }],
      api: 'openai-completions',
      provider: 'openai',
      model: 'gpt-4',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    handlers['turn_start']?.({ type: 'turn_start', turnIndex: 0, timestamp: Date.now() });
    handlers['message_start']?.({ type: 'message_start', message: assistantMessage });
    // TTFT update
    handlers['message_update']?.({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'H' },
    });
    // Streaming updates after the first
    for (let i = 0; i < 5; i++) {
      handlers['message_update']?.({
        type: 'message_update',
        message: assistantMessage,
        assistantMessageEvent: { type: 'text_delta', delta: 'i' },
      });
    }
    handlers['message_end']?.({ type: 'message_end', message: assistantMessage });
    handlers['turn_end']?.(
      { type: 'turn_end', turnIndex: 0, message: assistantMessage, toolResults: [] },
      fixture.mockCtx
    );

    const callCount = spy.mock.calls.length;
    spy.mockRestore();

    expect(callCount).toBeGreaterThanOrEqual(4);

    const [, data] = appendEntrySpy.mock.calls[0];
    expect(data.timing.generationMs).toBeGreaterThan(1);
    // Inter-update span: 101.8 - 100.5 = 1.3ms
    expect(data.timing.streamMs).toBeCloseTo(1.3, 1); // last stream(101.8) - first stream(100.5)
  });
});
