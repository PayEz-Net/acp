# Changelog

All notable changes to ACP Agent Skills.

## [1.0.0] - 2026-04-01

### Added
- **agent-onboarding** skill for "report as" workflow
- **gitnexus-code** skill for codebase intelligence
- **vibe-sql** skill for database queries
- Skill manifest (`acp-skills.json`)
- Installation scripts for Unix and Windows
- Comprehensive documentation

### Security
- Removed hardcoded credentials from agent-mail CLI
- Added config-based credential management
- Config stored in `~/.acp/` with user-only permissions

### Features
- Kimi Code CLI support with `--yolo` flag
- Claude Code CLI support with effort levels
- Cloud profile loading from VibeSQL
- Agent mail with HMAC authentication
- Real-time inbox checking

## [Unreleased]

### Planned
- Auto-update mechanism for skills
- Additional agent personas
- Team-wide skill synchronization
- Skill marketplace integration
