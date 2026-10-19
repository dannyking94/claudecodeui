import { Suspense, lazy } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';
import SetupForm from './SetupForm';

// Shown once per install; it pulls in provider login (and its terminal).
const LazyOnboarding = lazy(() => import('../../onboarding/view/Onboarding'));

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
