# Dev Notes — acp-desktop

## Dev-93 API Auth Pattern

**Do NOT use workspace-discovered credentials (`Vibe_b2d2... / VOmsyI...`).** Those are client ID + secret pairs that fail on Legacy auth routes with `INVALID_CREDENTIALS`.

### JWT Bearer (recommended for frontend e2e)

1. Get a JWT from the IDP test harness:
   ```bash
   POST http://127.0.0.1:32785/dev/impersonate
   Content-Type: application/json

   { "persona": "admin-user" }
   ```
   Available personas: `free-user` (900), `premium-user` (902), `admin-user` (903), `payez-admin` (3).

2. Use the `access_token` as Bearer on the Vibe API:
   ```bash
   GET http://127.0.0.1:32786/v1/agent-teams
   Authorization: Bearer eyJ...
   ```

### HMAC (machine-to-machine only)

Requires a signing key from `vibe_client_credentials.AppSigningKey` plus timestamp computation. See DotNetPert mail (thread 483) for the PowerShell recipe.

---

*Documented 2026-05-22 after NextPert + DotNetPert debug session.*
