/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="dom" />

import {
  normalize,
  parseSequence,
  Result,
  stringify,
} from "./deps/vim-like-key-notation.ts";
import { createDebug } from "./deps/debug-js.ts";
export { setDebugMode } from "./deps/debug-js.ts";
export type { Result };

const logger = createDebug("ScrapBindings:mod.ts");

export type Command = (e: KeyboardEvent) => void;

/**
 * Represents the configuration options for initializing a binding.
 */
export interface BindInit {
  /** The target element to bind the key sequences to. */
  target: Omit<EventTarget, "dispatchEvent">;
  /** A callback called whenever the sequence is updated. */
  onSequenceUpdate?: (sequence: string) => void;
  /** The interval in milliseconds to flush the sequence. */
  flushInterval?: number;
}

/** binds a set of key bindings to a target element.
 *
 * The key bindings are a map of key sequences to commands.
 * The key sequences are in the Vim-like key notation format.
 *
 * @param keyBindings A map of key bindings to commands.
 * @param init The configuration options for initializing a binding.
 * @returns If the key bindings are valid, a function that removes the binding is returned. Otherwise, an array of error messages is returned.
 */
export const bind = (
  keyBindings: Record<string, Command> | Map<string, Command>,
  init: BindInit,
): Result<() => void, [string, string][]> => {
  const commands = checkKeyBindings(keyBindings);
  if (Array.isArray(commands)) {
    logger.error("Invalid key bindings", commands);
    return { ok: false, value: commands };
  }
  logger.debug("Binded the following commands:", commands);

  let sequence = "";
  const setSequence = (s: string) => {
    sequence = s;
    init.onSequenceUpdate?.(s);
  };
  let bestMatchCommand: (() => void) | undefined;
  let filtered = new Map(commands);
  let timer: number | undefined;

  const reset = () => {
    clearTimeout(timer);
    setSequence("");
    bestMatchCommand = undefined;
    filtered = new Map(commands);
    logger.debug("reset the sequence");
  };
  const run = (key: string, command: Command, e: KeyboardEvent) => {
    logger.debug(`run ${key}`);
    try {
      command(e);
    } catch (error: unknown) {
      logger.error(error);
    } finally {
      reset();
    }
  };

  const interval = init.flushInterval ?? 1000;

  const handleKeydown = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    const vimKey = stringify(e);
    if (!vimKey) return;
    clearTimeout(timer);
    if (e.isComposing || e.key === "Process") {
      reset();
      return;
    }
    setSequence(sequence + vimKey);
    logger.debug("sequence", sequence);
    let bestMatchCommand_: (() => void) | undefined;
    for (const [key, command] of filtered) {
      if (!key.startsWith(sequence)) filtered.delete(key);
      if (sequence === key) bestMatchCommand_ = () => run(key, command, e);
    }
    logger.debug(
      `${filtered.size} candidates: ${[...filtered.keys()].join(", ")}`,
    );
    if (filtered.size > 0) bestMatchCommand = bestMatchCommand_;
    if ((bestMatchCommand && filtered.size < 2)) {
      const size = filtered.size;
      bestMatchCommand();
      // このターンの`KeyboardEvent`をまだ消費していないときは、もう一度`handleKeydown`を呼び出す
      if (size === 0) {
        handleKeydown(e);
        return;
      }
      return;
    }
    if (filtered.size === 0) {
      reset();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (bestMatchCommand) {
      const command = bestMatchCommand;
      timer = setTimeout(command, interval);
      return;
    }
    timer = setTimeout(reset, interval);
  };

  init.target.addEventListener("keydown", handleKeydown as EventListener);
  return {
    ok: true,
    value: () => {
      init.target.removeEventListener(
        "keydown",
        handleKeydown as EventListener,
      );
    },
  };
};

const checkKeyBindings = (
  keyBindings: Record<string, Command> | Map<string, Command>,
):
  | Map<string, Command>
  | [string, string][] => {
  const errors: [string, string][] = [];
  const normalizedCommands = new Map<string, Command>();

  for (
    const [sequence, command] of keyBindings instanceof Map
      ? keyBindings.entries()
      : Object.entries(keyBindings)
  ) {
    const keys = parseSequence(sequence);
    if (!keys) {
      errors.push([sequence, "cannot parse the sequence"]);
      continue;
    }
    let normalizedSequence = "";
    for (const key of keys) {
      const result = normalize(key);
      if (!result.ok) {
        errors.push([sequence, result.value.message]);
        continue;
      }
      normalizedSequence += result.value;
    }
    normalizedCommands.set(normalizedSequence, command);
  }

  return errors.length > 0 ? errors : normalizedCommands;
};
