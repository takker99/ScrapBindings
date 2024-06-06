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
export type KeyBindings = Record<string, Command> | Map<string, Command>;

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
 * const bindings = new ScrapBindings(window, {
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
export class Mousetrap {
  constructor(
    /** The target element to bind the key sequences to. */
    private target: Omit<EventTarget, "dispatchEvent">,
    options?: MousetrapOptions,
  ) {
    this.onSequenceUpdate = options?.onSequenceUpdate;
    this.flushInterval = options?.flushInterval ?? 1000;
  }

  /** bind a set of key bindings
   *
   * The key bindings are a map of key sequences to commands.
   *
   * The key sequences are in the Vim-like key notation format.
   *
   * @param keyBindings A map of key bindings to commands.
   * @returns an array of error messages
   */
  bind(keyBindings: KeyBindings): [string, string][];
  /** bind a key bindings
   *
   * The key sequence is in the Vim-like key notation format.
   *
   * @param sequence a key sequence
   * @param command a command to bind
   * @returns an array of error messages
   */
  bind(sequence: string, command: Command): [string, string][];
  bind(sequence: string | KeyBindings, command?: Command): [string, string][] {
    const commands = checkKeyBindings(
      typeof sequence === "string"
        ? Object.fromEntries([[sequence, command!]])
        : sequence,
    );
    if (Array.isArray(commands)) {
      logger.error("Invalid key bindings", commands);
      return commands;
    }
    for (const [sequence, command] of commands) {
      this.bindings.set(sequence, command);
      if (sequence.startsWith(this.currentSequence)) {
        this.filtered.add(sequence);
      }
    }
    logger.debug("Binded the following commands:", commands);
    this.emitChange();
    return [];
  }

  unbind(...keys: string[]): void {
    for (const key of keys) {
      this.bindings.delete(key);
      this.filtered.delete(key);
    }
    this.emitChange();
  }

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
    if (e.isComposing || e.key === "Process") {
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
      // 完全一致するコマンド`bestMatchCommand`だけ残ったら、それを実行する
      // 前回のターンで完全一致したコマンドと部分一致したコマンドがあり、今回のターンで前回部分一致したコマンドが全て外れたときは、前回完全一致したコマンド`this.prevBestMatchCommand`を実行する
      // その際、今回のターンの`KeyboardEvent`は次回のターンで再利用する
      // 例
      // 1. 前回のターン
      //   - sequence: "d"
      //   - filtered: ["d","dd"]
      // 2. 今回のターン
      //   - sequence: "da"
      //   - filtered: []
      // このときは"d"を実行し、状態をリセットしたあと、次回のターンで"a"が入力されたことにする
      this.prevBestMatchCommand();
      if (size === 0) {
        this.handleKeydown(e);
        return;
      }
      return;
    }
    if (size === 0) {
      // 候補がなければ初期状態に戻す
      this.backToInitial();
      return;
    }
    // コマンドを絞り込めきれない場合は、常にdefaultの挙動を打ち消しておく
    e.preventDefault();
    e.stopPropagation();
    this.timer = setTimeout(
      // 一定時間経っても入力がないときは、初期状態に戻す
      // もし完全一致するコマンドがあれば、そのコマンドを実行する
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

const checkKeyBindings = (
  keyBindings: KeyBindings,
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
