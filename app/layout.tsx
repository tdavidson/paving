import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pittsburgh Paving and Construction",
  description:
    "An unofficial map of the City of Pittsburgh milling, paving, and ADA curb-ramp schedule plus active street-closure construction permits, fed live from the city's published data.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
