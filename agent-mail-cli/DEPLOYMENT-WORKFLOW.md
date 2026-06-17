# Deployment Workflow - ACP CLI Changes

## Environments

| Environment | Purpose | When to Use |
|-------------|---------|-------------|
| **93** | Test/Staging | All changes start here |
| **Stable** | Production | Only after 93 soak |
| **Local** | Dev | Feature development |

## Change Lifecycle

### Phase 1: Development (Local)
- Develop on local machine
- Unit test if possible
- **DO NOT** deploy directly to stable

### Phase 2: Test (93)
- Deploy to 93 environment
- Run for **minimum 2-3 weeks**
- Daily use, bug reports, fixes
- Monitor for regressions

### Phase 3: Soak (93)
- Continue running on 93
- No major changes
- Confirm stability
- Document any workarounds

### Phase 4: Promote (Stable)
- Only after successful soak
- Copy tested version to stable
- Monitor for 24-48 hours
- Rollback plan ready

## Current Status

**Just completed:** Major CLI refactor + bug fixing on 93
- ✅ Pagination fixes
- ✅ Config encoding fixes  
- ✅ Cloud vs local routing
- ✅ Error handling

**Now:** Stable for production use

## Next Changes

Follow the lifecycle:
1. Local dev
2. Deploy to 93
3. **Soak for weeks**
4. Promote to stable

## Emergency Fixes

If critical bug found in stable:
1. Fix on local
2. Test on 93 (even if brief)
3. Hotfix to stable
4. Document the bypass

## Testing Checklist for 93

- [ ] Config creation works
- [ ] All commands functional
- [ ] No silent failures
- [ ] Error messages clear
- [ ] Help text accurate
- [ ] No encoding issues
- [ ] Performance acceptable

## Notes

- **Never** skip 93 testing
- **Never** rush soak period
- **Always** have rollback plan
- **Document** all workarounds

---

*Last Updated: 2026-04-08*
*Status: Post-refactor, stable*
