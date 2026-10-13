import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  base: "./",
  // src/firebase.js is outside the dashboard package root. Keep all Firebase
  // imports on one SDK instance so Firestore objects pass the SDK's type checks.
  resolve: { dedupe: ["firebase"] },
  server: { fs: { allow: [repositoryRoot] } },
});
