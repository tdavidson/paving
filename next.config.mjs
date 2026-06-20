/** @type {import('next').NextConfig} */

// Set BASE_PATH (e.g. "/paving") to serve the app under a sub-path of a domain.
// Leave it unset to serve at the domain root (e.g. on a subdomain).
const basePath = process.env.BASE_PATH || "";

const nextConfig = {
  reactStrictMode: true,
  basePath: basePath || undefined,
  // Exposed to the client so in-app fetches can prefix the same base path.
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
