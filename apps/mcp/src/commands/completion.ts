function bashCompletion(): string {
  return `# floom bash completion
_floom_completion() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  local commands="login logout whoami run workers workspaces workspace runs secrets connections mcp completion --help --version"
  local workers_sub="list show"
  local workspaces_sub="list create show switch use"
  local runs_sub="list show logs download approve reject cancel"
  local secrets_sub="list set delete"
  local connections_sub="list add import-mcp-config"
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
    mcp) COMPREPLY=( $(compgen -W "\${mcp_sub}" -- "\${cur}") ) ;;
  esac
}
complete -F _floom_completion floom
`;
}

function zshCompletion(): string {
  return `#compdef floom
_floom() {
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
    'mcp:Manage MCP servers and client config'
    'completion:Print completion scripts'
  )
  _describe 'command' commands
}
compdef _floom floom
`;
}

function fishCompletion(): string {
  return `complete -c floom -f -a "login logout whoami run workers workspaces workspace runs secrets connections mcp completion"
complete -c floom -n "__fish_seen_subcommand_from workers" -a "list show"
complete -c floom -n "__fish_seen_subcommand_from workspaces workspace" -a "list create show switch use"
complete -c floom -n "__fish_seen_subcommand_from runs" -a "list show logs download approve reject cancel"
complete -c floom -n "__fish_seen_subcommand_from secrets" -a "list set delete"
complete -c floom -n "__fish_seen_subcommand_from connections" -a "list add import-mcp-config"
complete -c floom -n "__fish_seen_subcommand_from mcp" -a "list switch test add install uninstall"
`;
}

export function completionScriptFor(shell: "bash" | "zsh" | "fish"): string {
  if (shell === "bash") return bashCompletion();
  if (shell === "zsh") return zshCompletion();
  return fishCompletion();
}

export async function completionCommand(shell: "bash" | "zsh" | "fish"): Promise<number> {
  process.stdout.write(completionScriptFor(shell));
  return 0;
}
