import { Suspense, lazy } from 'react';
import type { ComponentProps, ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

// Shown once per install; it pulls in provider login (and its terminal), so
// it stays out of the entry chunk: the dynamic import is what makes the split.
const LazyOnboarding = lazy(() =>
  import('@/modules/onboarding').then((module) => ({ default: module.Onboarding })),
);

function Onboarding({ onComplete }: ComponentProps<typeof LazyOnboarding>) {
  return (
    <Suspense fallback={<AuthLoadingScreen />}>
      <LazyOnboarding onComplete={onComplete} />
    </Suspense>
  );
}

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
