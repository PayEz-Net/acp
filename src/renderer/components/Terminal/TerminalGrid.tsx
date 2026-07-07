import { AgentState } from '@shared/types';
import { TerminalPane } from './TerminalPane';
import { useAppStore } from '../../stores/appStore';

interface TerminalGridProps {
  agents: AgentState[];
}

export function TerminalGrid({ agents }: TerminalGridProps) {
  const { layout, focusAgent, activeAgentId, setActiveAgent } = useAppStore();

  // Sort agents by position for grid layout
  const sortedAgents = [...agents].sort((a, b) => {
    const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    return positions.indexOf(a.position) - positions.indexOf(b.position);
  });

  // Focus mode: split agents into focus and sidebar
  // Use the currently focused agent (activeAgentId) if available; fall back to stored focusAgent
  const focusedAgent = agents.find((a) => a.id === activeAgentId) || agents.find((a) => a.name === focusAgent);
  const sidebarAgents = agents.filter((a) => a.id !== focusedAgent?.id);

  if (layout === 'focus-left' || layout === 'focus-right') {
    return (
      <div className={`h-full flex gap-2 ${layout === 'focus-right' ? 'flex-row-reverse' : ''}`}>
        {/* Focus pane G�� h-full ensures terminal-pane's h-full resolves correctly */}
        <div className="flex-1 min-w-0 h-full max-w-full overflow-hidden min-h-0">
          {focusedAgent && (
            <TerminalPane
              agent={focusedAgent}
              isFocused={activeAgentId === focusedAgent.id}
              onFocus={() => setActiveAgent(focusedAgent.id)}
            />
          )}
        </div>

        {/* Sidebar panes */}
        <div className="w-80 flex flex-col gap-2 shrink-0 min-h-0">
          {sidebarAgents.map((agent) => (
            <div key={agent.id} className="flex-1 min-h-0">
              <TerminalPane
                agent={agent}
                isFocused={activeAgentId === agent.id}
                onFocus={() => setActiveAgent(agent.id)}
                compact
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Deck layout — responsive reflow based on active agent count.
  // 2 agents → 2 columns (~50% each).
  // 3–4 agents → 2 columns, 2 rows, vertical scroll if needed.
  // 5–6 agents → 3 columns, 2 rows, min pane width 480px.
  // >6 agents → 3 columns with overflow / compact strip.
  let deckClass = '';
  if (agents.length <= 2) {
    deckClass = 'grid-cols-2 grid-rows-1';
  } else if (agents.length <= 4) {
    deckClass = 'grid-cols-2 grid-rows-2';
  } else if (agents.length <= 6) {
    deckClass = 'grid-cols-3 grid-rows-2';
  } else {
    deckClass = 'grid-cols-3 auto-rows-fr overflow-y-auto';
  }

  return (
    <div className={`h-full grid gap-2 ${deckClass}`} data-testid="terminal-deck">
      {sortedAgents.map((agent) => (
        <TerminalPane
          key={agent.id}
          agent={agent}
          isFocused={activeAgentId === agent.id}
          onFocus={() => setActiveAgent(agent.id)}
        />
      ))}
    </div>
  );
}
