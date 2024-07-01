/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="dom" />

import {
  DisallowedModifierError,
  DuplicateModifierError,
  InvalidKeyError,
  normalize,
  parseSequence,
  Result,
  stringify,
  UnknownModifierError,
} from "./deps/vim-like-key-notation.ts";
import { createDebug } from "./deps/debug-js.ts";
export { setDebugMode } from "./deps/debug-js.ts";
export type { Result };
export type {
  DisallowedModifierError,
  DuplicateModifierError,
  InvalidKeyError,
  UnknownModifierError,
};

const logger = createDebug("ScrapBindings:mod.ts");

export type Command = (e: KeyboardEvent) => void;
export type KeyBindings = Record<string, Command> | Map<string, Command>;
export interface InvalidSequenceError {
  name: "InvalidSequenceError";
  message: "cannot parse the sequence";
}
export type BindingError =
  | InvalidSequenceError
  | InvalidKeyError
  | DisallowedModifierError
  | DuplicateModifierError
  | UnknownModifierError;

/**
 * Represents the configuration options for {@link Mousetrap}.
 */
export interface MousetrapOptions {
  /** A callback called whenever the sequence is updated. */
  onSequenceUpdate?: (sequence: string) => void;
  /** The interval in milliseconds to flush the sequence. */
  flushInterval?: number;
}

/** A key binding manager that binds key sequences to commands.
 *
 * The key sequences are in the Vim-like key notation format.
 *
 * @example
 * ```ts
 * const bindings = new Mousetrap(window, {
 *  onSequenceUpdate: (sequence) => console.log(sequence),
 * flushInterval: 1000,
 * });
 * bindings.bind("gg", () => console.log("go to the top"));
 * bindings.bind("G", () => console.log("go to the bottom"));
 * bindings.bind("d", (e) => {
 *  e.preventDefault();
 * console.log("delete");
 * });
 * bindings.bind("dd", () => console.log("delete the line"));
 * bindings.bind("yy", () => console.log("copy the line"));
 * bindings.bind("p", () => console.log("paste"));
 * bindings.bind("u", () => console.log("undo"));
 * bindings.bind("<C-r>", () => console.log("redo"));
 *  ```
 */
/**
 * Represents a Mousetrap object that binds key sequences to commands.
 */
export class Mousetrap {
  /**
   * Creates a new Mousetrap instance.
   * @param target The target element to bind the key sequences to.
   * @param options The options for the Mousetrap instance.
   */
  constructor(
    private target: Omit<EventTarget, "dispatchEvent">,
    options?: MousetrapOptions,
  ) {
    this.onSequenceUpdate = options?.onSequenceUpdate;
    this.flushInterval = options?.flushInterval ?? 1000;
  }

  /** Binds a set of key bindings to commands.
   *
   * The key sequences are in the Vim-like key notation format.
   *
   * @param keyBindings A map of key bindings to commands.
   * @returns A map of error messages for each key binding.
   */
  bind(keyBindings: KeyBindings): Map<string, BindingError[]>;

  /** Binds a key sequence to a command.
   *
   * @param sequence A key sequence.
   * @param command A command to bind.
   * @returns A map of error messages for the key binding.
   */
  bind(sequence: string, command: Command): Map<string, BindingError[]>;

  bind(
    sequence: string | KeyBindings,
    command?: Command,
  ): Map<string, BindingError[]> {
    const errorMap = new Map<string, BindingError[]>();
    const sequences: string[] = [];

    for (
      const [seq, cmd] of sequence instanceof Map
        ? sequence.entries()
        : typeof sequence === "string"
        ? [[sequence, command!] as const]
        : Object.entries(sequence)
    ) {
      const result = normalizeSequence(seq);
      if (!result.ok) {
        for (const error of result.value) {
          logger.error(`${seq}: ${error.message}`);
        }
        errorMap.set(seq, result.value);
        continue;
      }

      const normalized = result.value;
      this.bindings.set(normalized, cmd);
      if (normalized.startsWith(this.currentSequence)) {
        this.filtered.add(normalized);
      }
      sequences.push(normalized);
    }

    logger.debug("Binded the following commands:", sequences);
    this.emitChange();
    return errorMap;
  }

  /**
   * Unbinds the specified key sequences.
   * @param sequences The key sequences to unbind.
   */
  unbind(...sequences: string[]): void {
    for (const sequence of sequences) {
      const result = normalizeSequence(sequence);
      if (!result.ok) continue;
      const normalized = result.value;
      this.bindings.delete(normalized);
      this.filtered.delete(normalized);
    }
    this.emitChange();
  }

  /**
   * Resets the Mousetrap instance by clearing all key bindings.
   */
  reset(): void {
    this.bindings.clear();
    this.emitChange();
  }

  private bindings = new Map<string, Command>();

  /** A callback called whenever the sequence is updated. */
  private onSequenceUpdate?: (sequence: string) => void;

  /** The interval in milliseconds to flush the sequence. */
  private flushInterval: number;

  private _sequence = "";
  private set currentSequence(sequence: string) {
    const changed = this._sequence !== sequence;
    this._sequence = sequence;
    if (changed) this.onSequenceUpdate?.(sequence);
  }
  get currentSequence(): string {
    return this._sequence;
  }

  private prevBestMatchCommand: (() => void) | undefined;
  private filtered = new Set<string>();
  private timer: number | undefined;

  private backToInitial = () => {
    clearTimeout(this.timer);
    this.currentSequence = "";
    this.prevBestMatchCommand = undefined;
    this.filtered = new Set(this.bindings.keys());
    logger.debug("reset the sequence");
  };

  private handleKeydown = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    const vimKey = stringify(e);
    if (!vimKey) return;
    clearTimeout(this.timer);
    if (e.isComposing) {
      this.backToInitial();
      return;
    }
    this.currentSequence += vimKey;
    logger.debug("sequence", this.currentSequence);
    let bestMatchCommand: (() => void) | undefined;
    for (const key of this.filtered) {
      if (!key.startsWith(this.currentSequence)) this.filtered.delete(key);
      if (this.currentSequence !== key) continue;
      const command = this.bindings.get(key);
      if (!command) {
        this.filtered.delete(key);
        continue;
      }
      bestMatchCommand = () => {
        logger.debug(`run ${key}`);
        try {
          command(e);
        } catch (error: unknown) {
          logger.error(error);
        } finally {
          this.backToInitial();
        }
      };
    }
    const size = this.filtered.size;
    logger.debug(`${size} candidates: ${[...this.filtered.keys()].join(", ")}`);
    if (size > 0) this.prevBestMatchCommand = bestMatchCommand;
    if (this.prevBestMatchCommand && size < 2) {
      // Execute the best match command if there is only one command that matches completely.
      // If there was a command that matched completely in the previous turn and a command that matched partially in the previous turn, and in this turn all the commands that matched partially in the previous turn are no longer matched, execute the command that matched completely in the previous turn (`this.prevBestMatchCommand`).
      // In this case, the `KeyboardEvent` of this turn will be reused in the next turn.
      // Example:
      // 1. Previous turn:
      //   - sequence: "d"
      //   - filtered: ["d","dd"]
      // 2. Current turn:
      //   - sequence: "da"
      //   - filtered: []
      // In this case, execute "d", reset the state, and pretend that "a" was entered in the next turn.
      this.prevBestMatchCommand();
      if (size === 0) {
        this.handleKeydown(e);
        return;
      }
      return;
    }
    if (size === 0) {
      // If there are no candidates, go back to the initial state.
      this.backToInitial();
      return;
    }
    // Always prevent the default behavior if the command cannot be narrowed down, and stop the event propagation.
    e.preventDefault();
    e.stopPropagation();
    this.timer = setTimeout(
      // If there is no input for a certain period of time, go back to the initial state.
      // If there is a command that matches completely, execute that command.
      this.prevBestMatchCommand ?? this.backToInitial,
      this.flushInterval,
    );
  };

  private emitChange = () => {
    if (this.bindings.size === 0) {
      this.backToInitial();
      this.target.removeEventListener(
        "keydown",
        this.handleKeydown as EventListener,
      );
      return;
    }

    this.target.addEventListener(
      "keydown",
      this.handleKeydown as EventListener,
    );
  };
}

const invalidSequenceError: InvalidSequenceError = {
  name: "InvalidSequenceError",
  message: "cannot parse the sequence",
};

const normalizeSequence = (
  sequence: string,
): Result<string, BindingError[]> => {
  const keys = parseSequence(sequence);
  if (!keys) return { ok: false, value: [invalidSequenceError] };
  let normalizedSequence = "";
  const errors: BindingError[] = [];
  for (const key of keys) {
    const result = normalize(key);
    if (!result.ok) {
      errors.push(result.value);
      continue;
    }
    normalizedSequence += result.value;
  }

  return errors.length > 0
    ? { ok: false, value: errors }
    : { ok: true, value: normalizedSequence };
};
