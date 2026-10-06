export interface CommandRule {
  /** Bare executable name, resolved through the sanitized PATH. */
  readonly command: string;
  readonly description: string;
  /** Returns a rejection reason, or undefined when the arguments are acceptable. */
  checkArgs(args: readonly string[]): string | undefined;
}

export type CommandDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export const MAX_COMMAND_ARGS = 64;
export const MAX_COMMAND_ARG_LENGTH = 4096;

const BARE_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// npm appends script arguments to a command line that it runs through a shell,
// so only characters with no shell meaning may follow "--".
const NPM_SCRIPT_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const NPM_TEST_RULE: CommandRule = {
  command: 'npm',
  description: 'npm test, optionally followed by "--" and plain script arguments',
  checkArgs(args) {
    if (args[0] !== 'test') {
      return 'Only "npm test" is allowed for npm';
    }
    if (args.length === 1) {
      return undefined;
    }
    if (args[1] !== '--') {
      return 'npm options are not allowed; pass script arguments after "--"';
    }
    const unsafe = args.slice(2).find((arg) => !NPM_SCRIPT_ARGUMENT.test(arg));
    return unsafe === undefined
      ? undefined
      : `Script argument ${JSON.stringify(unsafe)} contains characters that npm would pass to a shell`;
  },
};

/** Explicit allowlist of executables and the argument shapes each may receive. */
export class CommandPolicy {
  readonly #rules: ReadonlyMap<string, CommandRule>;

  constructor(rules: readonly CommandRule[]) {
    const byCommand = new Map<string, CommandRule>();
    for (const rule of rules) {
      if (!BARE_COMMAND_NAME.test(rule.command)) {
        throw new Error(`Command rule "${rule.command}" must be a bare executable name`);
      }
      if (byCommand.has(rule.command)) {
        throw new Error(`Duplicate command rule for "${rule.command}"`);
      }
      byCommand.set(rule.command, rule);
    }
    this.#rules = byCommand;
  }

  get allowedCommands(): readonly string[] {
    return [...this.#rules.keys()];
  }

  check(command: string, args: readonly string[]): CommandDecision {
    const rule = this.#rules.get(command);
    if (!BARE_COMMAND_NAME.test(command) || rule === undefined) {
      const allowed = this.allowedCommands.join(', ') || 'none';
      return { allowed: false, reason: `Command ${JSON.stringify(command)} is not allowed (allowed: ${allowed})` };
    }
    if (args.length > MAX_COMMAND_ARGS) {
      return { allowed: false, reason: `At most ${MAX_COMMAND_ARGS} arguments are allowed` };
    }
    if (args.some((arg) => typeof arg !== 'string' || arg.includes('\0') || arg.length > MAX_COMMAND_ARG_LENGTH)) {
      return {
        allowed: false,
        reason: `Arguments must be strings of at most ${MAX_COMMAND_ARG_LENGTH} characters without NUL bytes`,
      };
    }
    const reason = rule.checkArgs(args);
    return reason === undefined ? { allowed: true } : { allowed: false, reason };
  }
}

export const DEFAULT_COMMAND_POLICY = new CommandPolicy([NPM_TEST_RULE]);
