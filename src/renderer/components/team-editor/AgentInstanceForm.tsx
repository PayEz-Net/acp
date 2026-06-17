/**
 * AgentInstanceForm.tsx
 * Reused create-custom-agent form, now supporting both CREATE and EDIT.
 * Pre-fills from archetype on create; locks archetype on edit.
 */

import React, { useState, useEffect } from 'react';
import type { AgentInstance, AgentArchetype, AgentInstanceFormData } from './types';
import { SkillChipRow } from '../Skills';
import './TeamEditor.css';

interface Props {
  teamId?: string;
  instance: AgentInstance | null; // null = create mode
  archetypes?: AgentArchetype[];
  onSave: (data: Omit<AgentInstanceFormData, 'expertiseTags'> & { expertiseTags: string | string[] }) => void;
  onCancel: () => void;
}

const KNOWN_ARCHETYPES: AgentArchetype[] = [
  { id: 'aurum', name: 'Aurum', displayName: 'Aurum', role: 'Product Seer', basePrompt: 'You are Aurum, a product architecture seer.', defaultPersonality: 'analytical' },
  { id: 'bapert', name: 'BAPert', displayName: 'BAPert', role: 'Business Analyst', basePrompt: 'You are BAPert, a business analyst.', defaultPersonality: 'structured' },
  { id: 'dotnetpert', name: 'DotNetPert', displayName: 'DotNetPert', role: '.NET Backend', basePrompt: 'You are DotNetPert, a .NET backend specialist.', defaultPersonality: 'precise' },
  { id: 'nextpert', name: 'NextPert', displayName: 'NextPert', role: 'Next.js Frontend', basePrompt: 'You are NextPert, a Next.js frontend specialist.', defaultPersonality: 'analytical' },
  { id: 'qapert', name: 'QAPert', displayName: 'QAPert', role: 'QA Analyst', basePrompt: 'You are QAPert, a quality analyst.', defaultPersonality: 'thorough' },
];

export const AgentInstanceForm: React.FC<Props> = ({
  instance,
  archetypes: providedArchetypes,
  onSave,
  onCancel,
}) => {
  const archetypes = providedArchetypes && providedArchetypes.length > 0 ? providedArchetypes : KNOWN_ARCHETYPES;
  const isEdit = !!instance;

  const [form, setForm] = useState<AgentInstanceFormData>({
    archetypeId: '',
    teamUniqueName: '',
    displayName: '',
    role: '',
    identityPrompt: '',
    expertiseTags: '',
    personalityPreset: '',
    rolePreset: '',
    sortOrder: 1,
    skills: [],
  });

  const [errors, setErrors] = useState<Partial<Record<keyof AgentInstanceFormData, string>>>({});

  // Pre-fill on mount / archetype change
  useEffect(() => {
    if (instance) {
      setForm({
        archetypeId: instance.archetypeId,
        teamUniqueName: instance.teamUniqueName,
        displayName: instance.displayName,
        role: instance.role,
        identityPrompt: instance.identityPrompt,
        expertiseTags: instance.expertiseTags.join(', '),
        personalityPreset: instance.personalityPreset,
        rolePreset: instance.rolePreset,
        sortOrder: instance.sortOrder,
        skills: instance.skills ?? [],
      });
    } else {
      // Reset for create
      setForm({
        archetypeId: archetypes[0]?.id ?? '',
        teamUniqueName: '',
        displayName: '',
        role: '',
        identityPrompt: '',
        expertiseTags: '',
        personalityPreset: '',
        rolePreset: '',
        sortOrder: 1,
        skills: [],
      });
    }
  }, [instance]);

  // Auto-fill from archetype when archetype changes in CREATE mode
  useEffect(() => {
    if (isEdit) return;
    const archetype = archetypes.find(a => a.id === form.archetypeId);
    if (!archetype) return;
    setForm(prev => ({
      ...prev,
      displayName: archetype.displayName,
      role: archetype.role,
      identityPrompt: archetype.basePrompt,
      personalityPreset: archetype.defaultPersonality,
      rolePreset: archetype.role.toLowerCase().replace(/\s+/g, '_'),
      teamUniqueName: `${archetype.name}-2`,
    }));
  }, [form.archetypeId, isEdit, archetypes]);

  const validate = (): boolean => {
    const nextErrors: Partial<Record<keyof AgentInstanceFormData, string>> = {};
    if (!form.teamUniqueName.trim()) {
      nextErrors.teamUniqueName = 'Team-unique name is required';
    }
    if (!form.archetypeId && !isEdit) {
      nextErrors.archetypeId = 'Archetype is required';
    }
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    onSave({
      ...form,
      expertiseTags: form.expertiseTags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean),
    });
  };

  const updateSkills = (skills: string[]) => {
    setForm(prev => ({ ...prev, skills }));
  };

  const update = (field: keyof AgentInstanceFormData, value: string | number) => {
    setForm(prev => ({ ...prev, [field]: value }));
    setErrors(prev => ({ ...prev, [field]: undefined }));
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <header className="modal-header">
          <h3>{isEdit ? 'Edit Agent' : 'Add Agent to Team'}</h3>
          <button className="btn-close" onClick={onCancel}>×</button>
        </header>

        <form onSubmit={handleSubmit} className="agent-form">
          {/* Archetype — locked in edit mode */}
          <div className="form-group">
            <label>Archetype</label>
            {isEdit ? (
              <input
                type="text"
                value={archetypes.find(a => a.id === form.archetypeId)?.displayName ?? form.archetypeId}
                disabled
                className="input-disabled"
              />
            ) : (
              <select
                value={form.archetypeId}
                onChange={e => update('archetypeId', e.target.value)}
                className={errors.archetypeId ? 'input-error' : ''}
              >
                {archetypes.map(a => (
                  <option key={a.id} value={a.id}>{a.displayName} — {a.role}</option>
                ))}
              </select>
            )}
            {errors.archetypeId && <span className="field-error">{errors.archetypeId}</span>}
          </div>

          {/* Team-Unique Name */}
          <div className="form-group">
            <label>Team-Unique Name *</label>
            <input
              type="text"
              value={form.teamUniqueName}
              onChange={e => update('teamUniqueName', e.target.value)}
              placeholder="e.g. NextPert-2"
              className={errors.teamUniqueName ? 'input-error' : ''}
            />
            <span className="field-hint">Mail-addressable within this team</span>
            {errors.teamUniqueName && <span className="field-error">{errors.teamUniqueName}</span>}
          </div>

          {/* Display Name */}
          <div className="form-group">
            <label>Display Name</label>
            <input
              type="text"
              value={form.displayName}
              onChange={e => update('displayName', e.target.value)}
              placeholder="e.g. Next.js Frontend Lead"
            />
          </div>

          {/* Role */}
          <div className="form-group">
            <label>Role</label>
            <input
              type="text"
              value={form.role}
              onChange={e => update('role', e.target.value)}
              placeholder="e.g. frontend_lead"
            />
          </div>

          {/* Identity Prompt */}
          <div className="form-group">
            <label>Identity Prompt</label>
            <textarea
              value={form.identityPrompt}
              onChange={e => update('identityPrompt', e.target.value)}
              rows={4}
              placeholder="You are a Next.js specialist..."
            />
          </div>

          {/* Expertise Tags */}
          <div className="form-group">
            <label>Expertise Tags</label>
            <input
              type="text"
              value={form.expertiseTags}
              onChange={e => update('expertiseTags', e.target.value)}
              placeholder="react, electron, typescript"
            />
            <span className="field-hint">Comma-separated</span>
          </div>

          {/* Skills (v0.3) */}
          <div className="form-group">
            <label>Skills</label>
            <SkillChipRow skills={form.skills} onChange={updateSkills} editable />
          </div>

          {/* Personality Preset */}
          <div className="form-group">
            <label>Personality Preset</label>
            <select
              value={form.personalityPreset}
              onChange={e => update('personalityPreset', e.target.value)}
            >
              <option value="">— Select —</option>
              <option value="analytical">analytical</option>
              <option value="creative">creative</option>
              <option value="structured">structured</option>
              <option value="precise">precise</option>
              <option value="thorough">thorough</option>
            </select>
          </div>

          {/* Role Preset */}
          <div className="form-group">
            <label>Role Preset</label>
            <input
              type="text"
              value={form.rolePreset}
              onChange={e => update('rolePreset', e.target.value)}
              placeholder="e.g. frontend_lead"
            />
          </div>

          {/* Sort Order */}
          <div className="form-group">
            <label>Sort Order</label>
            <input
              type="number"
              min={0}
              value={form.sortOrder}
              onChange={e => update('sortOrder', parseInt(e.target.value, 10))}
            />
          </div>

          <footer className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {isEdit ? 'Save Changes' : 'Save to Team'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};
