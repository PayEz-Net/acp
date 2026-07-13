# Agent Terminal Output — User JWT Capability Refactor Spec

> **Status:** Approved — ready for implementation  
> **Owner:** BAPert  
> **Implementer:** DotNetPert  
> **Related:** [`PAYEZVIBE_AGENT_OUTPUT_API_SPEC.md`](../../PayEz-Core/PayEz.Apis/PayEz.Vibe.Public.Api/docs/PAYEZVIBE_AGENT_OUTPUT_API_SPEC.md)  

---

## 1. Background

DotNetPert’s .NET research for the acp-api document-persistence port surfaced a separate production blocker:

- `PayEz.Vibe.Public.Api.Controllers.V1.AgentOutputController` is gated with `[RequireCapability("agent_terminal_output")]`.
- The user JWTs currently produced by `IdentityBearerTokenService` never include that capability.
- Result: desktop clients that call `POST /v1/agent-output` or `GET /v1/agent-output/stream` get **403 Forbidden** in production.

The root cause is not the controller or the vsql-cache proxy — it is the **hard-coded role-to-capability mapping** in `IdentityBearerTokenService.MapRolesToCapabilities`. That mapping is:

- duplicated across three token-issuance paths (`CorporateUser`, `CorporateProgressive`, `FederatedUser`),
- missing `agent_terminal_output`,
- difficult to extend without a full code redeploy.

## 2. Decision

1. **Add `agent_terminal_output` to the JWT `capabilities` claim for every user who is already allowed to use Vibe agents.**
2. **Refactor the mapping into a single, testable resolver** so the next capability does not require another inline edit.
3. **Keep it config-light:** use a code-first default map plus an optional `AppSettings:RoleCapabilities` override section. No new database tables or admin UI for this iteration.

### 2.1 Role-to-capability mapping (target)

| Role | Capabilities emitted in JWT `capabilities` claim |
|---|---|
| `vibe_agents_user` | `agent_mail`, `agent_terminal_output` |
| `vibe_agent_system_user` | `agent_mail`, `agent_terminal_output` |
| `vibe_app_admin` | `agent_mail`, `vibe_admin`, `agent_terminal_output` |

- `payez_user` and `payez_admin` receive no Vibe capabilities from this map (unchanged).
- The `agent_terminal_output` capability is **not** a role; it is a capability derived from existing agent roles.
- This follows least privilege: only users who already have agent access can stream agent terminal output.

### 2.2 Out of scope for this refactor

- The existing `RequireCapability("admin")` and `RequireCapability("vibe_data")` controllers remain machine-auth / service-account paths for now.
- No changes to `GenerateBearerTokenForAgent` (agent JWTs already receive their capabilities from Vibe).
- No changes to merchant token issuance (it does not emit `capabilities`).

## 3. Proposed implementation

### 3.1 New resolver contract

Create a small capability resolver in `PayEz.Infrastructure`:

```csharp
public interface IRoleCapabilityResolver
{
    IReadOnlyList<string> ResolveCapabilities(IEnumerable<string> roles);
}

public sealed class RoleCapabilityResolver : IRoleCapabilityResolver
{
    private readonly IReadOnlyDictionary<string, IReadOnlyList<string>> _defaults;
    private readonly IReadOnlyDictionary<string, IReadOnlyList<string>> _overrides;

    public RoleCapabilityResolver(IConfiguration? configuration = null)
    {
        _defaults = new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase)
        {
            ["vibe_agents_user"] = new[] { "agent_mail", "agent_terminal_output" },
            ["vibe_agent_system_user"] = new[] { "agent_mail", "agent_terminal_output" },
            ["vibe_app_admin"] = new[] { "agent_mail", "vibe_admin", "agent_terminal_output" },
        };

        _overrides = ReadOverrides(configuration);
    }

    public IReadOnlyList<string> ResolveCapabilities(IEnumerable<string> roles)
    {
        var caps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var role in roles ?? Enumerable.Empty<string>())
        {
            if (_overrides.TryGetValue(role, out var overrideCaps))
            {
                foreach (var c in overrideCaps) caps.Add(c);
            }
            else if (_defaults.TryGetValue(role, out var defaultCaps))
            {
                foreach (var c in defaultCaps) caps.Add(c);
            }
        }
        return caps.ToList();
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> ReadOverrides(IConfiguration? configuration)
    {
        // Optional: AppSettings:RoleCapabilities:MyRole = ["cap1", "cap2"]
        var section = configuration?.GetSection("AppSettings:RoleCapabilities");
        if (section?.Exists() != true)
            return new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase);

        return section.Get<Dictionary<string, IReadOnlyList<string>>>()
               ?? new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase);
    }
}
```

### 3.2 Wire-up

- Register `IRoleCapabilityResolver` as a singleton in the application service collection and inject it into `IdentityBearerTokenService`.
- Replace the three `MapRolesToCapabilities(roles)` calls in `IdentityBearerTokenService` with `_roleCapabilityResolver.ResolveCapabilities(roles)`.
- Remove the private `MapRolesToCapabilities` method.

### 3.3 Optional appsettings override schema

```jsonc
{
  "AppSettings": {
    "RoleCapabilities": {
      // Config list completely replaces the code-default list for this role.
      // Omitted capabilities are revoked. Use with care.
      "vibe_app_admin": [ "agent_mail", "vibe_admin", "agent_terminal_output", "some_future_cap" ]
    }
  }
}
```

- If a role is present in config, the config list is the **authoritative full list** for that role and the code default is ignored.
- If a role is absent from config, the code default applies.
- This lets ops change capabilities without a build, but it requires them to specify the complete desired list.

## 4. Token paths that must change

All three user-token paths in `IdentityBearerTokenService` must use the resolver:

- `GenerateBearerTokenForCorporateUser`
- `GenerateBearerTokenForCorporateProgressiveUser`
- `GenerateBearerTokenForFederatedUser`

The `capabilities` claim must continue to be emitted as a JSON array (or comma-separated string) so the existing `RequireCapabilityAttribute` parser still works.

## 5. Rollout and verification

1. **Dev-93 first** (per the existing agent-output spec):
   - Deploy the code change.
   - Verify a user with `vibe_agents_user` receives `agent_terminal_output` in their JWT.
   - Confirm `POST /v1/agent-output` returns 202 instead of 403.
2. **Azure:** promote the same build/config.
3. **acp-desktop:** no desktop code change is required; the desktop already sends the user bearer token.

## 6. Acceptance criteria

- [ ] `AgentOutputController` accepts requests from users who have `vibe_agents_user`, `vibe_agent_system_user`, or `vibe_app_admin`.
- [ ] Users without those roles still get 403 when calling agent-output endpoints.
- [ ] `IdentityBearerTokenService` no longer contains a private `MapRolesToCapabilities` method.
- [ ] New `IRoleCapabilityResolver` has unit tests covering:
  - [ ] default roles,
  - [ ] case-insensitivity for roles and capabilities,
  - [ ] `null` / empty roles input,
  - [ ] unknown roles produce no capabilities,
  - [ ] duplicate roles do not duplicate capabilities,
  - [ ] config override completely replaces the default list for an overridden role,
  - [ ] config override section absent / empty / malformed is handled safely.
- [ ] Integration tests verify the JWT `capabilities` claim contains `agent_terminal_output` for each target role across all three token paths (`CorporateUser`, `CorporateProgressive`, `FederatedUser`).
- [ ] Negative integration test: a user with only `payez_user` receives no `agent_terminal_output` and gets 403 from `AgentOutputController`.
- [ ] Existing `RequireCapability("agent_mail")` behavior is unchanged.
- [ ] Existing `RequireCapability("vibe_admin")` behavior is unchanged.
- [ ] `GenerateBearerTokenForAgent` is untouched.
- [ ] `capabilities` claim continues to be emitted in the same format (JSON array or comma-separated string) that `RequireCapabilityAttribute` already parses.
- [ ] Resolver logs a warning at startup when any `RoleCapabilities` overrides are loaded.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Config override accidentally revokes capabilities because the config list replaces defaults | Document replace semantics explicitly; require ops to specify the complete list; log a warning when overrides load. |
| Case-sensitivity mismatch | Resolver uses `OrdinalIgnoreCase` for both roles and capabilities. |
| `vibe_app_admin` gains more than intended | Only `agent_terminal_output` is added; no new admin capabilities are granted. |

## 8. Open questions

1. Do we need a capability for read-only terminal streaming vs. write-only PTY ingestion? (Current decision: one `agent_terminal_output` capability for both, matching the controller-level gate. Split later if the endpoints diverge.)
2. Should `payez_admin` receive `admin` capability so human platform admins can call the Vibe admin endpoints from a user JWT? **Deferred** — those endpoints currently rely on machine auth.

---

*Approved by QAPert. Work order may be cut to DotNetPert.*
