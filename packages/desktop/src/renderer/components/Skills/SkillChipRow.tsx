import { useState, useRef, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { SkillChip } from './SkillChip';
import { getSkillCatalog, getSkillDisplayName } from '../../lib/skillRegistry';

interface SkillChipRowProps {
  skills: string[];
  onChange: (skills: string[]) => void;
  editable?: boolean;
}

export function SkillChipRow({ skills = [], onChange, editable = false }: SkillChipRowProps) {
  const [showAdd, setShowAdd] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowAdd(false);
      }
    }
    if (showAdd) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showAdd]);

  if (!skills.length && !editable) return null;

  const catalog = getSkillCatalog();
  const assigned = new Set(skills);
  const available = catalog.filter((s) => !assigned.has(s.name));

  const handleAdd = (name: string) => {
    onChange([...skills, name]);
    setShowAdd(false);
  };

  const handleRemove = (name: string) => {
    onChange(skills.filter((s) => s !== name));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {skills.map((name) => (
        <SkillChip key={name} name={name} onRemove={editable ? () => handleRemove(name) : undefined} />
      ))}

      {editable && available.length > 0 && (
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setShowAdd((v) => !v)}
            className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded border border-dashed border-slate-600 text-slate-500 hover:text-slate-300 hover:border-slate-500 transition-colors"
            title="Add skill"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>

          {showAdd && (
            <div className="absolute left-0 top-full mt-1 z-50 w-48 bg-slate-900 border border-slate-700 rounded shadow-xl max-h-48 overflow-y-auto">
              {available.map((skill) => (
                <button
                  key={skill.name}
                  type="button"
                  onClick={() => handleAdd(skill.name)}
                  className="w-full text-left px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 transition-colors"
                  title={skill.description}
                >
                  {getSkillDisplayName(skill.name)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
