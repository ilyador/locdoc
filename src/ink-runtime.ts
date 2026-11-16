import { Compiler, CompilerOptions, type Story } from "inkjs/full";

export type InkMessage = {
  text: string;
  severity: "error" | "warning" | "note";
};
export type InkTurn = { text: string; choice?: boolean; tags?: string[] };
export type InkResult = {
  turns: InkTurn[];
  choices: string[];
  messages: InkMessage[];
  history: string[];
};
export type InkRequest =
  | {
      type: "compile";
      path: string;
      files: Record<string, string>;
      history: string[];
    }
  | { type: "choose"; index: number };

// This module runs only in the worker in the app. No external functions are
// bound and story text is returned as strings, never HTML or JavaScript.
export class InkRuntime {
  private story: Story | null = null;
  private result: InkResult = {
    turns: [],
    choices: [],
    messages: [],
    history: [],
  };
  private size = 0;
  run(request: InkRequest): InkResult {
    try {
      if (request.type === "compile") {
        this.story = null;
        this.size = 0;
        this.result = { turns: [], choices: [], messages: [], history: [] };
        const compiler = new Compiler(
          request.files[request.path],
          new CompilerOptions(
            request.path,
            [],
            false,
            (text, severity) =>
              this.result.messages.push({
                text,
                severity:
                  severity === 2
                    ? "error"
                    : severity === 1
                      ? "warning"
                      : "note",
              }),
            {
              ResolveInkFilename: (name) => name,
              LoadInkFileContents: (name) => {
                if (!Object.hasOwn(request.files, name))
                  throw new Error("Include is unavailable.");
                return request.files[name];
              },
            },
          ),
        );
        this.story = compiler.Compile();
        this.story.onError = (text, severity) => {
          this.result.messages.push({
            text,
            severity: severity === 2 ? "error" : "warning",
          });
        };
        this.advance();
        // Replay only an unambiguous matching choice. If edits changed a
        // branch, stop there and let the reader choose its new direction.
        for (const chosen of request.history) {
          const choices = this.result.choices;
          const index = choices.indexOf(chosen);
          if (index < 0 || choices.lastIndexOf(chosen) !== index) break;
          this.choose(index);
        }
      } else this.choose(request.index);
    } catch (error) {
      this.result.choices = [];
      if (!this.result.messages.some((message) => message.severity === "error"))
        this.result.messages.push({
          text:
            error instanceof Error
              ? error.message
              : "This story could not run.",
          severity: "error",
        });
    }
    return this.result;
  }
  private choose(index: number) {
    if (
      !this.story ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.result.choices.length
    )
      throw new Error("That choice is no longer available. Restart the story.");
    const text = this.result.choices[index];
    this.result.turns.push({ text, choice: true });
    this.result.history.push(text);
    this.story.ChooseChoiceIndex(index);
    this.advance();
  }
  private advance() {
    if (!this.story) return;
    const deadline = performance.now() + 800;
    while (this.story.canContinue) {
      if (
        performance.now() > deadline ||
        this.result.turns.length >= 1000 ||
        this.size > 100_000
      )
        throw new Error(
          "Preview paused at its limit. Check for a loop, then restart.",
        );
      // ContinueAsync also bounds a divert-only loop with no output.
      this.story.ContinueAsync(20);
      if (!this.story.asyncContinueComplete) continue;
      const text = this.story.currentText?.trim() || "";
      this.size += text.length;
      if (text)
        this.result.turns.push({ text, tags: this.story.currentTags || [] });
    }
    this.result.choices = this.result.messages.some(
      (message) => message.severity === "error",
    )
      ? []
      : this.story.currentChoices.map((choice) => choice.text);
    if (this.result.choices.length > 200)
      throw new Error("Preview supports up to 200 choices at a time.");
  }
}
