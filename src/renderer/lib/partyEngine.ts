/**
 * Cocktail Party Algorithm Engine
 *
 * Implements the pattern matching / selective attention algorithm
 * for emergent agent coordination.
 *
 * Based on signal processing research - agents "tune in" to each other
 * based on relevance (needs/offers matching, keyword overlap).
 */

import {
  AgentSignal,
  RelevanceScore,
  MingleSession,
  ACPZone,
  ACPAgent,
  ACPPosition,
  PARTY_THRESHOLDS,
} from '@shared/types';

// ============================================
// Relevance Scoring
// ============================================

/**
 * Compute relevance between two agents based on their signals.
 * Higher score = more reason to coordinate.
 */
export function computeRelevance(signalA: AgentSignal, signalB: AgentSignal): RelevanceScore {
  let needsOffersMatch = 0;
  let offersNeedsMatch = 0;
  let keywordOverlap = 0;

  // A needs what B offers?
  for (const need of signalA.needs) {
    const needLower = need.toLowerCase();
    for (const offer of signalB.offers) {
      if (offer.toLowerCase().includes(needLower) || needLower.includes(offer.toLowerCase())) {
        needsOffersMatch += PARTY_THRESHOLDS.NEEDS_OFFERS;
        break; // Only count once per need
      }
    }
  }

  // B needs what A offers?
  for (const offer of signalA.offers) {
    const offerLower = offer.toLowerCase();
    for (const need of signalB.needs) {
      if (need.toLowerCase().includes(offerLower) || offerLower.includes(need.toLowerCase())) {
        offersNeedsMatch += PARTY_THRESHOLDS.OFFERS_NEEDS;
        break; // Only count once per offer
      }
    }
  }

  // Keyword overlap
  const keywordsA = new Set(signalA.keywords.map(k => k.toLowerCase()));
  const keywordsB = new Set(signalB.keywords.map(k => k.toLowerCase()));
  for (const keyword of keywordsA) {
    if (keywordsB.has(keyword)) {
      keywordOverlap += PARTY_THRESHOLDS.KEYWORD_MATCH;
    }
  }

  const score = needsOffersMatch + offersNeedsMatch + keywordOverlap;

  return {
    agentA: signalA.agentId,
    agentB: signalB.agentId,
    score,
    breakdown: {
      needsOffersMatch,
      offersNeedsMatch,
      keywordOverlap,
    },
  };
}

/**
 * Compute all pairwise relevance scores for a set of signals.
 */
export function computeRelevanceMatrix(signals: AgentSignal[]): Map<string, RelevanceScore> {
  const matrix = new Map<string, RelevanceScore>();

  for (let i = 0; i < signals.length; i++) {
    for (let j = i + 1; j < signals.length; j++) {
      const score = computeRelevance(signals[i], signals[j]);
      // Store with sorted key so we can look up either direction
      const key = [signals[i].agentId, signals[j].agentId].sort().join(':');
      matrix.set(key, score);
    }
  }

  return matrix;
}

/**
 * Get relevance score between two agents from the matrix.
 */
export function getRelevance(
  matrix: Map<string, RelevanceScore>,
  agentA: string,
  agentB: string
): RelevanceScore | undefined {
  const key = [agentA, agentB].sort().join(':');
  return matrix.get(key);
}

// ============================================
// Position & Movement
// ============================================

// Zone center positions (percentage-based)
const ZONE_CENTERS: Record<ACPZone, ACPPosition> = {
  'table-db': { x: 15, y: 15 },
  'table-ui': { x: 38, y: 15 },
  'table-api': { x: 61, y: 15 },
  'table-qa': { x: 84, y: 15 },
  'bar': { x: 8, y: 52 },
  'lounge': { x: 77, y: 75 },
  'entrance': { x: 50, y: 93 },
};

// Home zones for each agent (where they work)
const AGENT_HOME_ZONES: Record<string, ACPZone> = {
  sage: 'table-db',    // BAPert - DB Architecture / specs
  forge: 'table-api',  // DotNetPert - API Routes
  pixel: 'table-ui',   // NextPert - UI Components
  nova: 'table-ui',    // NextPertTwo - UI Components (shares with Pixel)
  raven: 'table-qa',   // QAPert - QA Testing
};

/**
 * Get the base position for an agent in a zone.
 * Adds slight offset so agents don't overlap.
 */
export function getZonePosition(zone: ACPZone, agentIndex: number): ACPPosition {
  const center = ZONE_CENTERS[zone];
  // Offset agents slightly so they don't stack
  const offset = (agentIndex % 3) * 4 - 4; // -4, 0, or 4
  return {
    x: center.x + offset,
    y: center.y + (agentIndex > 2 ? 5 : 0),
  };
}

/**
 * Calculate position based on relevance to other agents.
 * High relevance pairs drift toward each other.
 */
export function calculateDriftPosition(
  agent: ACPAgent,
  allAgents: ACPAgent[],
  relevanceMatrix: Map<string, RelevanceScore>
): ACPPosition {
  // Start from current position
  let targetX = agent.position.x;
  let targetY = agent.position.y;

  // Find highest relevance partner
  let maxRelevance = 0;
  let attractorAgent: ACPAgent | null = null;

  for (const other of allAgents) {
    if (other.id === agent.id) continue;

    const score = getRelevance(relevanceMatrix, agent.id, other.id);
    if (score && score.score > maxRelevance && score.score >= PARTY_THRESHOLDS.APPROACH) {
      maxRelevance = score.score;
      attractorAgent = other;
    }
  }

  if (attractorAgent && maxRelevance >= PARTY_THRESHOLDS.APPROACH) {
    // Drift toward the attractor (30% of the way)
    const driftStrength = Math.min(0.3, (maxRelevance - PARTY_THRESHOLDS.APPROACH) / 100);
    targetX = agent.position.x + (attractorAgent.position.x - agent.position.x) * driftStrength;
    targetY = agent.position.y + (attractorAgent.position.y - agent.position.y) * driftStrength;
  }

  return { x: targetX, y: targetY };
}

/**
 * Check if two agents should start mingling based on proximity and relevance.
 */
export function shouldMingle(
  agentA: ACPAgent,
  agentB: ACPAgent,
  relevanceMatrix: Map<string, RelevanceScore>
): boolean {
  const score = getRelevance(relevanceMatrix, agentA.id, agentB.id);
  if (!score || score.score < PARTY_THRESHOLDS.MINGLE) return false;

  // Check proximity (within 15% of each other)
  const dx = Math.abs(agentA.position.x - agentB.position.x);
  const dy = Math.abs(agentA.position.y - agentB.position.y);
  const distance = Math.sqrt(dx * dx + dy * dy);

  return distance < 15;
}

// ============================================
// Mock Signals (for Phase 1 simulation)
// ============================================

/**
 * Generate mock broadcast signals for testing.
 * In Phase 2, these will come from real agent activity.
 */
export function generateMockSignals(): AgentSignal[] {
  const now = new Date();

  return [
    {
      agentId: 'sage',
      agentName: 'BAPert',
      partyName: 'Sage',
      location: 'table-db',
      workingOn: 'Cocktail Party Algorithm spec',
      keywords: ['algorithm', 'coordination', 'relevance', 'spec', 'architecture'],
      needs: ['frontend implementation', 'test scenarios'],
      offers: ['algorithm spec', 'coordination design', 'task breakdown'],
      timestamp: now,
    },
    {
      agentId: 'forge',
      agentName: 'DotNetPert',
      partyName: 'Forge',
      location: 'table-api',
      workingOn: 'Vibe Data Logging API',
      keywords: ['api', 'logging', 'vibe', 'backend', 'endpoints'],
      needs: ['frontend consumer', 'test cases'],
      offers: ['logging endpoints', 'api routes', 'data persistence'],
      timestamp: now,
    },
    {
      agentId: 'pixel',
      agentName: 'NextPert',
      partyName: 'Pixel',
      location: 'table-ui',
      workingOn: 'Admin dashboard components',
      keywords: ['dashboard', 'admin', 'ui', 'components', 'react'],
      needs: ['api endpoints', 'design specs'],
      offers: ['ui components', 'dashboard layout', 'admin screens'],
      timestamp: now,
    },
    {
      agentId: 'nova',
      agentName: 'NextPertTwo',
      partyName: 'Nova',
      location: 'table-ui',
      workingOn: 'ACP party algorithm implementation',
      keywords: ['acp', 'party', 'algorithm', 'frontend', 'animation'],
      needs: ['algorithm spec', 'test data'],
      offers: ['frontend implementation', 'animation system', 'acp ui'],
      timestamp: now,
    },
    {
      agentId: 'raven',
      agentName: 'QAPert',
      partyName: 'Raven',
      location: 'table-qa',
      workingOn: 'Code review backlog',
      keywords: ['review', 'security', 'testing', 'accessibility', 'qa'],
      needs: ['code submissions', 'test coverage'],
      offers: ['code reviews', 'security audit', 'accessibility check'],
      timestamp: now,
    },
  ];
}

/**
 * Simulate agent signal updates over time.
 * Returns updated signals with occasional changes.
 */
export function updateMockSignals(signals: AgentSignal[]): AgentSignal[] {
  const now = new Date();

  // 20% chance each agent updates their signal
  return signals.map(signal => {
    if (Math.random() > 0.2) return signal;

    // Simulate work progress by occasionally shifting keywords
    const updatedSignal = { ...signal, timestamp: now };

    // Sometimes an agent finishes something and offers it
    if (Math.random() > 0.7 && signal.needs.length > 0) {
      const completed = signal.needs[0];
      updatedSignal.needs = signal.needs.slice(1);
      updatedSignal.offers = [...signal.offers, completed];
    }

    return updatedSignal;
  });
}

// ============================================
// Mingle Session Management
// ============================================

let mingleIdCounter = 0;

/**
 * Create a new mingle session between two agents.
 */
export function createMingleSession(
  agentA: ACPAgent,
  agentB: ACPAgent,
  relevanceScore: number
): MingleSession {
  const type: MingleSession['type'] =
    relevanceScore >= PARTY_THRESHOLDS.DEEP_TALK ? 'deep_talk' :
    relevanceScore >= PARTY_THRESHOLDS.CHIT_CHAT ? 'chit_chat' : 'gossip';

  return {
    id: `mingle-${++mingleIdCounter}`,
    agents: [agentA.id, agentB.id],
    type,
    startTime: new Date(),
    outcome: 'pending',
  };
}

/**
 * End a mingle session with an outcome.
 */
export function endMingleSession(
  session: MingleSession,
  outcome: 'useful' | 'not_useful'
): MingleSession {
  return {
    ...session,
    endTime: new Date(),
    outcome,
  };
}

// ============================================
// Zone Assignment
// ============================================

/**
 * Determine which zone an agent should move to based on their state.
 */
export function determineTargetZone(
  agent: ACPAgent,
  relevanceMatrix: Map<string, RelevanceScore>,
  allAgents: ACPAgent[]
): ACPZone {
  // If blocked, go to bar to scan for help
  if (agent.status === 'blocked') {
    return 'bar';
  }

  // If mingling, go to lounge
  if (agent.status === 'mingling') {
    return 'lounge';
  }

  // Check if there's a high-relevance agent to approach
  let highestScore = 0;
  for (const other of allAgents) {
    if (other.id === agent.id) continue;
    const score = getRelevance(relevanceMatrix, agent.id, other.id);
    if (score && score.score > highestScore) {
      highestScore = score.score;
    }
  }

  // If high relevance detected, go to bar first to "sense" the opportunity
  if (highestScore >= PARTY_THRESHOLDS.APPROACH && agent.zone !== 'bar' && agent.zone !== 'lounge') {
    return 'bar';
  }

  // Otherwise, return to home zone for focused work
  return AGENT_HOME_ZONES[agent.character] || 'table-db';
}
