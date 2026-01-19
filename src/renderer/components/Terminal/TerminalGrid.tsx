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
  const focusedAgent = agents.find((a) => a.name === focusAgent);
  const sidebarAgents = agents.filter((a) => a.name !== focusAgent);

  if (layout === 'focus-left' || layout === 'focus-right') {
    return (
      <div className={`h-full flex gap-2 ${layout === 'focus-right' ? 'flex-row-reverse' : ''}`}>
        {/* Focus pane */}
        <div className="flex-1 min-w-0">
          {focusedAgent && (
            <TerminalPane
              agent={focusedAgent}
              isFocused={activeAgentId === focusedAgent.id}
              onFocus={() => setActiveAgent(focusedAgent.id)}
            />
          )}
        </div>

        {/* Sidebar panes */}
        <div className="w-80 flex flex-col gap-2">
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

  // Grid layout (default)
  return (
    <div className="h-full grid grid-cols-2 grid-rows-2 gap-2">
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
