import { parseCommandArgs, verbOf } from "../args.ts";
import { CLI_INVOCATION } from "../invocation.ts";
import { COMMAND_TREE, firstWords } from "./tree.ts";

const SHELLS = ["bash", "zsh", "fish"] as const;

const HELP = `pgfsmctl completion — shell completion script (local)

USAGE
  ${CLI_INVOCATION} completion <bash|zsh|fish>

  bash:  source <(pgfsmctl completion bash)       (e.g. in ~/.bashrc)
  zsh:   source <(pgfsmctl completion zsh)        (e.g. in ~/.zshrc)
  fish:  pgfsmctl completion fish > ~/.config/fish/completions/pgfsmctl.fish

  Completes nouns, verbs (\`db cron <verb>\`) and each noun's flags.
`;

export function completionCommand(argv: string[]): Promise<void> {
  const args = parseCommandArgs(argv, {}, HELP);
  if (args.help) console.log(HELP);
  else {
    const shell = verbOf("completion", args.positionals, SHELLS, HELP);
    console.log(SCRIPTS[shell]());
  }
  return Promise.resolve();
}

const nouns = () => Object.keys(COMMAND_TREE).join(" ");

/** `case` arms: words to offer after `<noun>` (and after `db cron`). */
function shellCases(indent: string, v: string): string {
  const lines: string[] = [];
  for (const [noun, spec] of Object.entries(COMMAND_TREE)) {
    lines.push(
      `${indent}${noun}) ${v}="${
        [...firstWords(noun), ...spec.flags].join(" ")
      }" ;;`,
    );
  }
  return lines.join("\n");
}

function subCases(indent: string, v: string): string {
  const lines: string[] = [];
  for (const [noun, spec] of Object.entries(COMMAND_TREE)) {
    if (Array.isArray(spec.verbs)) continue;
    for (const [sub, verbs] of Object.entries(spec.verbs)) {
      lines.push(
        `${indent}"${noun} ${sub}") ${v}="${
          [...verbs, ...spec.flags].join(" ")
        }" ;;`,
      );
    }
  }
  return lines.join("\n");
}

const SCRIPTS: Record<typeof SHELLS[number], () => string> = {
  bash: () =>
    `# pgfsmctl bash completion
_pgfsmctl() {
  local cur words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    words="${nouns()} --help --version"
  else
    case "\${COMP_WORDS[1]} \${COMP_WORDS[2]}" in
${subCases("      ", "words")}
      *)
        case "\${COMP_WORDS[1]}" in
${shellCases("          ", "words")}
          *) words="" ;;
        esac ;;
    esac
  fi
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _pgfsmctl pgfsmctl`,

  zsh: () =>
    `#compdef pgfsmctl
# pgfsmctl zsh completion
_pgfsmctl() {
  local words_
  if (( CURRENT == 2 )); then
    words_="${nouns()} --help --version"
  else
    case "\${words[2]} \${words[3]}" in
${subCases("      ", "words_")}
      *)
        case "\${words[2]}" in
${shellCases("          ", "words_")}
          *) words_="" ;;
        esac ;;
    esac
  fi
  compadd -- \${=words_}
}
compdef _pgfsmctl pgfsmctl`,

  fish: () => {
    const lines = [
      "# pgfsmctl fish completion",
      "complete -c pgfsmctl -f",
      `complete -c pgfsmctl -n __fish_use_subcommand -a "${nouns()}"`,
    ];
    for (const [noun, spec] of Object.entries(COMMAND_TREE)) {
      lines.push(
        `complete -c pgfsmctl -n "__fish_seen_subcommand_from ${noun}" -a "${
          firstWords(noun).join(" ")
        }"`,
      );
      for (const flag of spec.flags) {
        lines.push(
          `complete -c pgfsmctl -n "__fish_seen_subcommand_from ${noun}" -l ${
            flag.replace(/^--/, "")
          }`,
        );
      }
      if (!Array.isArray(spec.verbs)) {
        for (const [sub, verbs] of Object.entries(spec.verbs)) {
          lines.push(
            `complete -c pgfsmctl -n "__fish_seen_subcommand_from ${sub}" -a "${
              verbs.join(" ")
            }"`,
          );
        }
      }
    }
    return lines.join("\n");
  },
};
