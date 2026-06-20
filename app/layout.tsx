import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pittsburgh Paving Schedule Map",
  description:
    "An unofficial map of the City of Pittsburgh milling, paving, and ADA curb-ramp schedule, fed live from the city's published schedule.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
