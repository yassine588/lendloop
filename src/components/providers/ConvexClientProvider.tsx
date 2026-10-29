"use client";

import React, { useMemo } from "react";
import { ClerkProvider, useAuth } from "@clerk/nextjs";
import { ConvexReactClient } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { LiveConvexBoard } from "../LiveConvexBoard";
import { SandboxBoard } from "../SandboxBoard";

const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
const clerkPublishableKey =
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

export const isLiveBackendConfigured =
  convexUrl.startsWith("https://") &&
  !convexUrl.includes("your-deployment") &&
  clerkPublishableKey.startsWith("pk_") &&
  !clerkPublishableKey.includes("replace_me");

export function LendLoopAppRoot() {
  const convexClient = useMemo(() => {
    if (!isLiveBackendConfigured) {
      return null;
    }
    return new ConvexReactClient(convexUrl);
  }, []);

  if (!isLiveBackendConfigured || !convexClient) {
    return <SandboxBoard />;
  }

  return (
    <ClerkProvider publishableKey={clerkPublishableKey}>
      <ConvexProviderWithClerk client={convexClient} useAuth={useAuth}>
        <LiveConvexBoard />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}
