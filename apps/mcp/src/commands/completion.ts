import { getCommandName } from "../lib/command-name.js";

function bashCompletion(name: string): string {
  return `# ${name} bash completion
_${name}_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="login logout whoami run workers workspaces workspace runs secrets connections contexts context mcp completion --help --version"
  local workers_sub="list show"
  local workspaces_sub="list create show switch use"
  local runs_sub="list show logs download approve reject cancel"
  local secrets_sub="list set delete"
  local connections_sub="list add import-mcp-config"
  local contexts_sub="list create read write upload delete delete-file versions rollback"
  local mcp_sub="list switch test add install uninstall"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  case "\${COMP_WORDS[1]}" in
    workers) COMPREPLY=( $(compgen -W "\${workers_sub}" -- "\${cur}") ) ;;
    workspaces|workspace) COMPREPLY=( $(compgen -W "\${workspaces_sub}" -- "\${cur}") ) ;;
    runs) COMPREPLY=( $(compgen -W "\${runs_sub}" -- "\${cur}") ) ;;
    secrets) COMPREPLY=( $(compgen -W "\${secrets_sub}" -- "\${cur}") ) ;;
    connections) COMPREPLY=( $(compgen -W "\${connections_sub}" -- "\${cur}") ) ;;
    contexts|context) COMPREPLY=( $(compgen -W "\${contexts_sub}" -- "\${cur}") ) ;;
    mcp) COMPREPLY=( $(compgen -W "\${mcp_sub}" -- "\${cur}") ) ;;
  esac
}
complete -F _${name}_completion ${name}
`;
}

function zshCompletion(name: string): string {
  return `#compdef ${name}
_${name}() {
  local -a commands
  commands=(
    'login:Login via device code'
    'logout:Clear local credentials'
    'whoami:Show current identity'
    'run:Run a worker'
    'workers:List or show workers'
    'workspaces:Manage workspaces'
    'runs:List or inspect runs'
    'secrets:Manage secrets'
    'connections:Manage app and MCP connections'
    'contexts:Manage brain pack context folders'
    'mcp:Manage MCP servers and client config'
    'completion:Print completion scripts'
  )
  _describe 'command' commands
}
compdef _${name} ${name}
`;
}

function fishCompletion(name: string): string {
  return `complete -c ${name} -f -a "login logout whoami run workers workspaces workspace runs secrets connections contexts context mcp completion"
complete -c ${name} -n "__fish_seen_subcommand_from workers" -a "list show"
complete -c ${name} -n "__fish_seen_subcommand_from workspaces workspace" -a "list create show switch use"
complete -c ${name} -n "__fish_seen_subcommand_from runs" -a "list show logs download approve reject cancel"
complete -c ${name} -n "__fish_seen_subcommand_from secrets" -a "list set delete"
complete -c ${name} -n "__fish_seen_subcommand_from connections" -a "list add import-mcp-config"
complete -c ${name} -n "__fish_seen_subcommand_from contexts context" -a "list create read write upload delete delete-file versions rollback"
complete -c ${name} -n "__fish_seen_subcommand_from mcp" -a "list switch test add install uninstall"
`;
}

export function completionScriptFor(
  shell: "bash" | "zsh" | "fish",
  name: string = getCommandName(),
): string {
  if (shell === "bash") return bashCompletion(name);
  if (shell === "zsh") return zshCompletion(name);
  return fishCompletion(name);
}

export async function completionCommand(shell: "bash" | "zsh" | "fish"): Promise<number> {
  process.stdout.write(completionScriptFor(shell));
  return 0;
}
