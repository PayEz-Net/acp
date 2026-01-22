/**
 * IDP Client Configuration Types
 * Shared between main and renderer processes
 */

export interface OAuthProviderConfig {
  provider: string;
  enabled: boolean;
  clientId: string;
  clientSecret: string;
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
