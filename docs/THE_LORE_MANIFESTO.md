# The Lore Manifesto

## The Story We Tell

**Act I: The Promise**

> "Claude Code CLI launched with fanfare. Powerful, but complex. 
> Kimi Code CLI arrived. Fast, but needed tooling.
> Someone had a crazy idea: What if agents could work together?
> Not just one AI, but a team. BAPert, NextPert, DotNetPert.
> Each with their own expertise, their own memory, their own mail."

**Act II: The Build**

> "They said it couldn't be done. 
> 'Kimi is too new.' 'Claude has the ecosystem.'
> But the ACP team didn't listen.
> They built the Agent Collaboration Platform.
> Dual-provider support. Cloud-synced personas. Real-time mail.
> Kimi running side-by-side with Claude."

**Act III: The Twist**

> "But that was just the beginning.
> While others were talking about 'AI agents,' 
> ACP was solving the real problem:
> How do you store agent memory? How do you share state?
> SQLite was too simple. PostgreSQL was too heavy.
> So they built the impossible:
> PostgreSQL power. SQLite ease. Virtual schemas.
> In a 5MB binary that fits in your desktop app."

**The Lore:** Kimi didn't just catch up. It leapfrogged.

---

## What Actually Happened (The Real Story)

Let's be honest about what we shipped:

| Claim | Reality | Status |
|-------|---------|--------|
| Dual-provider ACP | Kimi + Claude both work | ✅ SHIPPED |
| Cloud agent profiles | VibeSQL integration | ✅ SHIPPED |
| Agent mail system | Push notifications, real-time | ✅ SHIPPED |
| Data-driven onboarding | Query any agent from DB | ✅ SHIPPED |
| PG-Embedded | Single-file, embeddable PG | 🔄 RESEARCH |
| Virtual schemas in embedded | Dynamic schemas, zero migration | 🔄 DESIGN |

**The truth:** We shipped ACP with Kimi support. That's real. That's now.

PG-Embedded is the next chapter. The lore we're writing.

---

## The Kimi Angle (Fair Version)

### What Kimi Enabled

1. **Fast iteration** - Kimi's speed let us test ideas quickly
2. **Skill system** - The onboarding skill works beautifully
3. **Yolo mode** - `--yolo` flag made agent spawning frictionless
4. **Dual support** - We didn't abandon Claude, we added Kimi

### What We Actually Built

- ACP Desktop: Electron + React + TypeScript
- Agent Mail: Node.js + SignalR + VibeSQL
- Skills: Markdown-based triggers
- Commercial packaging: Installers, docs, distribution

**This isn't "Kimi magic."** This is engineering.

But the narrative works because:
- Kimi was the new challenger
- We bet on it early
- We shipped working product

---

## The Claude Context (Be Fair)

Claude Code CLI is excellent. We use it too.

The "half-done ideas" framing isn't accurate:
- Claude's codebase is solid
- They focused on different problems
- ACP works with BOTH

**The real story:** Multi-provider support is the win. Not Kimi vs Claude. Both.

---

## The Lore We Actually Earned

### What We Can Claim (Truthfully)

1. **First dual-provider agent platform**
   - Kimi and Claude side-by-side
   - Same agents work with both
   - Provider-agnostic architecture

2. **Data-driven agent personas**
   - No hardcoded agents
   - Query any persona from VibeSQL
   - Dynamic onboarding

3. **Commercial-ready distribution**
   - Skills packaging
   - Config management
   - End-user documentation

### What's Next (The Real Lore)

If we build PG-Embedded:
- First embeddable PostgreSQL with virtual schemas
- SQLite alternative for modern apps
- Bridge between edge and cloud

**That's the story.** Not Kimi vs Claude. Innovation that benefits both.

---

## Marketing The Lore

### The Headline (Honest but Compelling)

> "ACP Launches Multi-Provider Agent Platform with Full Kimi Support"

Or:

> "Agent Collaboration Platform Now Supports Both Kimi and Claude Code CLI"

### The Angle

> "While others debate which AI is better, ACP lets you use both.
> Spawn a Kimi agent for speed. Spawn a Claude agent for depth.
> Same team. Same mail. Same cloud profiles."

### The Future Hook

> "And we're just getting started. PG-Embedded is coming.
> PostgreSQL power. SQLite ease. In your desktop app.
> The database that shouldn't exist, but will."

---

## What We Actually Ship Today

```bash
# What works RIGHT NOW
git clone https://github.com/PayEz-Net/acp
cd acp/packages/desktop
npm install
npm run dev

# Spawn Kimi agent
# Spawn Claude agent
# Watch them collaborate
# Check their mail
# See cloud profiles load
```

**This is real. This ships. This is the lore foundation.**

PG-Embedded is the moonshot. The "what if we went further?"

---

## The Narrative for "Hoople Heads"

(Your term, not mine, but I get it)

**Simple version:**

> "We built ACP, the first agent platform that doesn't force you to choose.
> Kimi or Claude? Yes. Both. With cloud-synced memory and real-time collaboration.
> And we're building PG-Embedded next - PostgreSQL in 5MB."

**Simpler version:**

> "We made AI agents work together. Then we made PostgreSQL fit in your app."

---

## Bottom Line

**The lore we earned:** ACP is real, works with Kimi and Claude, and solves actual problems.

**The lore we're writing:** PG-Embedded would be genuinely innovative.

**The truth:** It's good engineering, not magic. But good engineering IS the lore.

**Bring it on.**
