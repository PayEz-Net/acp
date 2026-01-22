// Authentication types for Electron MVP
// Ported from PayEz React Native MVP

export interface User {
  id: string;
  email: string;
  name?: string;
  roles?: string[];
  requiresTwoFactor?: boolean;
  twoFactorSessionVerified?: boolean;
  authenticationMethods?: string[];
}

export interface Session {
  user: User;
  accessToken: string;
  refreshToken?: string;
  sessionToken?: string;
  expiresAt?: string;
  mfaExpiresAt?: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  session: Session | null;
  user: User | null;
  error: string | null;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface TwoFactorVerification {
  code: string;
  method: 'sms' | 'email' | 'authenticator';
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

// Type guards
export function isValidSession(session: Session | null): session is Session {
  return !!(
    session?.user?.id &&
    session?.user?.email &&
    session?.accessToken
  );
}

export function hasCompletedTwoFactor(session: Session | null): boolean {
  if (!isValidSession(session)) return false;
  if (!session.user.requiresTwoFactor) return true;
  return session.user.twoFactorSessionVerified === true;
}

// Auth flow states
export enum AuthFlowState {
  UNAUTHENTICATED = 'unauthenticated',
  AUTHENTICATED = 'authenticated',
  REQUIRES_2FA = 'requires_2fa',
  VERIFYING_2FA = 'verifying_2fa',
  REFRESHING_TOKEN = 'refreshing_token',
  ERROR = 'error'
}
