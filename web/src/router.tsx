import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, createBrowserRouter, Outlet } from "react-router-dom";

import { AccountOnboardingBanner } from "@/components/layout/account-onboarding-banner";
import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { CommandPalette } from "@/components/layout/command-palette";
import { SettingsDrawer } from "@/components/layout/settings-drawer";
import UserLayout from "@/layouts/user-layout";

// 首屏只加载落地页需要的代码；画布工程页（编辑器/Agent 面板）体量最大，改成按需加载。
const AuthPage = lazy(() => import("@/pages/auth"));
const CanvasPage = lazy(() => import("@/pages/canvas"));
const CanvasProjectPage = lazy(() => import("@/pages/canvas/project"));
const NotFound = lazy(() => import("@/pages/not-found"));
const PricingPage = lazy(() => import("@/pages/marketing"));
const CoursesPage = lazy(() => import("@/pages/marketing").then((mod) => ({ default: mod.CoursesPage })));

function withRouteFallback(node: ReactNode) {
    return (
        <Suspense fallback={<div style={{ position: "fixed", inset: 0, background: "#0b0b0d" }} />}>
            {node}
        </Suspense>
    );
}

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
            { path: "/login", element: withRouteFallback(<AuthPage mode="login" />) },
            { path: "/register", element: withRouteFallback(<AuthPage mode="register" />) },
            { path: "/pricing", element: withRouteFallback(<PricingPage />) },
            { path: "/courses", element: withRouteFallback(<CoursesPage />) },
            {
                // AccountOnboardingBanner lives here (not in ClientRootInit) because it needs
                // router context; ClientRootInit renders outside <RouterProvider>.
                element: (
                    <>
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
                    { path: "/canvas", element: withRouteFallback(<CanvasPage />) },
                    { path: "/canvas/:id", element: withRouteFallback(<CanvasProjectPage />) },
                ],
            },
        ],
    },
    { path: "*", element: withRouteFallback(<NotFound />) },
]);
