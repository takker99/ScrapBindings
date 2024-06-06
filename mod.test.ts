/// <reference lib="deno.ns" />

import { assertEquals } from "./deps/assert.ts";
import { delay } from "./deps/async.ts";
import { parse } from "./deps/vim-like-key-notation.ts";
import { Command, Mousetrap } from "./mod.ts";

const mockTarget = {
  listeners: new Set<EventListener>(),
  dispatchEvent(vimKey: string) {
    const res = parse(vimKey);
    if (!res.ok) {
      const e = new Error();
      e.name = res.value.name;
      e.message = res.value.message;
      throw e;
    }
    for (const listener of this.listeners) {
      listener(
        {
          ...res.value,
          isTrusted: true,
          preventDefault: () => {},
          stopPropagation: () => {},
        } as KeyboardEvent,
      );
    }
  },
  addEventListener(_: string, listener: EventListener) {
    this.listeners.add(listener);
  },
  removeEventListener(_: string, listener: EventListener) {
    this.listeners.delete(listener);
  },
};

Deno.test("ScrapBindings", async (t) => {
  await t.step("initial state", () => {
    const bindings = new Mousetrap(mockTarget);

    assertEquals(bindings["bindings"], new Map<string, Command>());
    assertEquals(bindings.currentSequence, "");
  });

  await t.step("registration", async (t) => {
    const mockCommand: Command = (_) => {};
    await t.step("bind single key sequence", () => {
      const bindings = new Mousetrap(mockTarget);

      bindings.bind("gg", mockCommand);

      const expectedBindings = new Map<string, Command>([["gg", mockCommand]]);
      assertEquals(bindings["bindings"], expectedBindings);
    });
    await t.step("bind multiple key sequences", async (t) => {
      await t.step("by map", () => {
        const bindings = new Mousetrap(mockTarget);

        const keyBindings = new Map<string, Command>([
          ["gg", mockCommand],
          ["G", mockCommand],
          ["d", mockCommand],
        ]);

        bindings.bind(keyBindings);

        const expectedBindings = new Map<string, Command>([
          ["gg", mockCommand],
          ["G", mockCommand],
          ["d", mockCommand],
        ]);
        assertEquals(bindings["bindings"], expectedBindings);
      });
      await t.step("by object", () => {
        const bindings = new Mousetrap(mockTarget);

        bindings.bind({ gg: mockCommand, G: mockCommand, d: mockCommand });

        const expectedBindings = new Map<string, Command>([
          ["gg", mockCommand],
          ["G", mockCommand],
          ["d", mockCommand],
        ]);
        assertEquals(bindings["bindings"], expectedBindings);
      });
    });
    await t.step("unbind key sequences", () => {
      const bindings = new Mousetrap(mockTarget);

      bindings.bind({ gg: mockCommand, G: mockCommand, d: mockCommand });

      bindings.unbind("gg", "G");

      const expectedBindings = new Map<string, Command>([["d", mockCommand]]);
      assertEquals(bindings["bindings"], expectedBindings);
    });
    await t.step("unbind key sequences", () => {
      const bindings = new Mousetrap(mockTarget);

      bindings.bind({ gg: mockCommand, G: mockCommand, d: mockCommand });

      bindings.reset();

      const expectedBindings = new Map<string, Command>();
      assertEquals(bindings["bindings"], expectedBindings);
    });
  });

  await t.step("key event", async (t) => {
    let last: KeyboardEvent | undefined;
    const mockCommand: Command = (e) => last = e;
    const bindings = new Mousetrap(mockTarget, { flushInterval: 50 });
    bindings.bind({
      gg: mockCommand,
      G: mockCommand,
      d: mockCommand,
      g: mockCommand,
      rr: mockCommand,
    });

    await t.step("single key sequence", () => {
      assertEquals(last, undefined);
      mockTarget.dispatchEvent("k");
      assertEquals(last, undefined);
      mockTarget.dispatchEvent("G");
      assertEquals(last?.key, "G");
      mockTarget.dispatchEvent("d");
      assertEquals(last?.key, "d");
    });
    last = undefined;
    await t.step("multiple key sequences", () => {
      mockTarget.dispatchEvent("r");
      mockTarget.dispatchEvent("r");
      assertEquals(last?.key, "r");
      last = undefined;
      mockTarget.dispatchEvent("r");
      mockTarget.dispatchEvent("k");
      assertEquals(last, undefined);
    });
    last = undefined;
    await t.step("pause", async () => {
      mockTarget.dispatchEvent("r");
      assertEquals(last, undefined);
      assertEquals(bindings["_sequence"], "r");
      await delay(100);
      assertEquals(bindings["_sequence"], "");
      mockTarget.dispatchEvent("g");
      assertEquals(last, undefined);
      await delay(100);
      assertEquals(last?.key, "g");
    });
    last = undefined;
    await t.step("cancel by another key", () => {
      let text = "";
      bindings.bind({
        g: () => text += "g",
        a: () => text += "a",
      });
      mockTarget.dispatchEvent("g");
      assertEquals(text, "");
      mockTarget.dispatchEvent("a");
      assertEquals(text, "ga");
    });
    last = undefined;
  });
});
