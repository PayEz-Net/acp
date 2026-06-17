import { X } from 'lucide-react';
import { getSkillDisplayName, getSkillColor } from '../../lib/skillRegistry';

interface SkillChipProps {
  name: string;
  onRemove?: () => void;
}

export function SkillChip({ name, onRemove }: SkillChipProps) {
  const colorClass = getSkillColor(name);
  const display = getSkillDisplayName(name);

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${colorClass}`}
      title={display}
    >
      {display}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="hover:opacity-80 focus:outline-none"
          title="Remove skill"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}
