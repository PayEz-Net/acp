/**
 * IDP Client Configuration Types
 * Shared between main and renderer processes
 */

// IDP Client App identity for ACP Desktop.
// - Wire param on /connect/authorize and /connect/token (Phase B): `app=acp_desktop`
// - Wire param on /api/ExternalAuth/oauth-callback (Phase A — accepted today)
// - Wire header on outbound service-to-service calls: `X-IDP-Client-App: acp_desktop`
// Spec: BAPert/specs/planned/IDP_CLIENT_APP_AUTH_IDENTITY_SPEC.md
export const IDP_CLIENT_APP = 'acp_desktop';
export const IDP_CLIENT_APP_HEADER = 'X-IDP-Client-App';

export interface OAuthProviderConfig {
  provider: string;
  enabled: boolean;
  clientId: string;
  // clientSecret REMOVED (175295) — the desktop no longer performs a
  // provider token exchange (that moved server-side to the IDP's
  // oauth-exchange endpoint), so there is nothing here that should ever
  // read a provider client_secret. The field previously existed only to be
  // mapped in from the IDP's /client-config response and never used
  // again — dead code that still captured a real secret into renderer
  // memory. The IDP's /client-config response including a client_secret at
  // all is a separate, tracked cleanup (BAPert, card 175295 follow-up); this
  // type simply stops accepting it into the desktop's in-memory config.
  scopes?: string;
  additionalParams?: Record<string, string>;
}

export interface AuthSettings {
  require2FA: boolean;
  allowed2FAMethods: string[];
  mfaGracePeriodHours: number;
  sessionTimeoutMinutes: number;
  allowRememberMe: boolean;
  rememberMeDays: number;
}

export interface IDPClientConfig {
  clientId: number;
  clientSlug: string;
  configCacheTtlSeconds: number;
  oauthProviders: OAuthProviderConfig[];
  authSettings: AuthSettings;
}

// OAuth provider authorize URLs
export const OAUTH_ENDPOINTS: Record<string, { authorize: string; token: string }> = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
  },
  facebook: {
    authorize: 'https://www.facebook.com/v18.0/dialog/oauth',
    token: 'https://graph.facebook.com/v18.0/oauth/access_token',
  },
  apple: {
    authorize: 'https://appleid.apple.com/auth/authorize',
    token: 'https://appleid.apple.com/auth/token',
  },
};

// Default scopes per provider
export const DEFAULT_SCOPES: Record<string, string> = {
  google: 'openid email profile',
  microsoft: 'openid email profile User.Read',
  github: 'read:user user:email',
  facebook: 'email public_profile',
  apple: 'name email',
};
