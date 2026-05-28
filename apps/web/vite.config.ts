import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_URL ?? "http://localhost:4200";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": apiTarget,
      "/socket.io": {
        target: apiTarget,
        ws: true
      }
    }
  }
});
