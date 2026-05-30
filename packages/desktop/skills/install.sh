#!/bin/bash
#
# ACP Agent Skills Installer (Unix/macOS)
# Usage: curl -fsSL https://.../install.sh | bash
#

set -e

SKILLS_VERSION="1.0.0"
SKILLS_REPO="https://github.com/PayEz-Net/acp/raw/main/skills"
COMMANDS_REPO="https://github.com/PayEz-Net/acp/raw/main/.agents/commands"
TARGET_DIR="$HOME/.kimi/skills"
COMMANDS_TARGET_DIR="$HOME/.claude/commands"
BACKUP_DIR="$HOME/.kimi/skills.backup.$(date +%Y%m%d%H%M%S)"

# Claude Code slash commands sourced from acp-desktop/.agents/commands/.
COMMANDS=(
    "agent-docs.md"
    "agent-mail.md"
    "report-aurum.md"
    "report-bapert.md"
    "report-dotnetpert.md"
    "report-nextpert.md"
    "report-qapert.md"
    "vibe-sql.md"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_banner() {
    echo -e "${BLUE}"
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║        ACP Agent Skills Installer v${SKILLS_VERSION}           ║"
    echo "╚════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

check_prerequisites() {
    print_info "Checking prerequisites..."
    
    if ! command -v curl &> /dev/null; then
        print_error "curl is required but not installed"
        exit 1
    fi
    
    print_success "Prerequisites met"
}

backup_existing() {
    if [ -d "$TARGET_DIR" ]; then
        print_warning "Existing skills found. Creating backup..."
        mkdir -p "$BACKUP_DIR"
        cp -r "$TARGET_DIR"/* "$BACKUP_DIR"/ 2>/dev/null || true
        print_success "Backup created at $BACKUP_DIR"
    fi
}

install_skills() {
    print_info "Installing ACP Agent Skills..."
    
    # Create target directory
    mkdir -p "$TARGET_DIR"
    
    # Download and extract skills
    cd "$TARGET_DIR"
    
    # Download each skill
    for skill in agent-onboarding gitnexus-code vibe-sql; do
        print_info "Downloading $skill..."
        mkdir -p "$skill"
        curl -fsSL "${SKILLS_REPO}/${skill}/SKILL.md" -o "${skill}/SKILL.md"
        print_success "Installed $skill"
    done
    
    # Download manifest
    curl -fsSL "${SKILLS_REPO}/acp-skills.json" -o "acp-skills.json"

    print_success "All skills installed to $TARGET_DIR"
}

install_commands() {
    print_info "Installing Claude Code slash commands..."

    mkdir -p "$COMMANDS_TARGET_DIR"

    for command in "${COMMANDS[@]}"; do
        print_info "Downloading $command..."
        if curl -fsSL "${COMMANDS_REPO}/${command}" -o "${COMMANDS_TARGET_DIR}/${command}"; then
            print_success "Installed $command"
        else
            print_error "Failed to download $command"
        fi
    done

    print_success "All commands installed to $COMMANDS_TARGET_DIR"
}

verify_installation() {
    print_info "Verifying installation..."

    local all_good=true

    for skill in agent-onboarding gitnexus-code vibe-sql; do
        if [ -f "$TARGET_DIR/$skill/SKILL.md" ]; then
            print_success "$skill skill present"
        else
            print_error "$skill skill missing"
            all_good=false
        fi
    done

    for command in "${COMMANDS[@]}"; do
        if [ -f "$COMMANDS_TARGET_DIR/$command" ]; then
            print_success "$command command present"
        else
            print_error "$command command missing"
            all_good=false
        fi
    done

    if [ "$all_good" = true ]; then
        return 0
    else
        return 1
    fi
}

print_next_steps() {
    echo ""
    echo -e "${GREEN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║              Installation Complete!                    ║${NC}"
    echo -e "${GREEN}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
    print_info "Next steps:"
    echo ""
    echo "  1. Configure agent-mail CLI:"
    echo "     node ~/.acp/bin/agent-mail.js --init"
    echo ""
    echo "  2. Verify Kimi can see the skills:"
    echo "     kimi --list-skills"
    echo ""
    echo "  3. Start ACP and spawn an agent:"
    echo "     Type 'report as BAPert' in the agent terminal"
    echo ""
    echo "  Need help? Visit: https://docs.idealvibe.online/acp"
    echo ""
}

main() {
    print_banner

    check_prerequisites
    backup_existing
    install_skills
    install_commands

    if verify_installation; then
        print_next_steps
    else
        print_error "Installation verification failed"
        print_info "Check backup at: $BACKUP_DIR"
        exit 1
    fi
}

main "$@"
