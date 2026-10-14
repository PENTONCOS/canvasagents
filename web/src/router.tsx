import { Navigate, createBrowserRouter, Outlet } from "react-router-dom";

import { AccountOnboardingBanner } from "@/components/layout/account-onboarding-banner";
import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { CommandPalette } from "@/components/layout/command-palette";
import { OnboardingWizard } from "@/components/layout/onboarding-wizard";
import { SettingsDrawer } from "@/components/layout/settings-drawer";
import UserLayout from "@/layouts/user-layout";
import AuthPage from "@/pages/auth";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import NotFound from "@/pages/not-found";

// Legacy routes (/image /video /assets /prompts /config) intentionally redirect to /canvas
// so old links keep working; the capability now lives inside the canvas (M1 immersive redesign).
export const router = createBrowserRouter([
    {
        element: (
            <>
                <AnalyticsTracker />
                <Outlet />
            </>
        ),
        children: [
            { path: "/login", element: <AuthPage mode="login" /> },
            { path: "/register", element: <AuthPage mode="register" /> },
            {
                // AccountOnboardingBanner lives here (not in ClientRootInit) because it needs
                // router context; ClientRootInit renders outside <RouterProvider>.
                element: (
                    <>
                        <OnboardingWizard />
                        <UserLayout>
                            <Outlet />
                        </UserLayout>
                        <SettingsDrawer />
                        <CommandPalette />
                        <AccountOnboardingBanner />
                    </>
                ),
                children: [
                    { path: "/", element: <Navigate to="/canvas" replace /> },
                    { path: "/image", element: <Navigate to="/canvas" replace /> },
                    { path: "/video", element: <Navigate to="/canvas" replace /> },
                    { path: "/assets", element: <Navigate to="/canvas" replace /> },
                    { path: "/prompts", element: <Navigate to="/canvas" replace /> },
                    { path: "/config", element: <Navigate to="/canvas" replace /> },
                    { path: "/canvas", element: <CanvasPage /> },
                    { path: "/canvas/:id", element: <CanvasProjectPage /> },
                ],
            },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
