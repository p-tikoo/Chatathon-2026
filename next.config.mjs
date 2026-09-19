/** @type {import('next').NextConfig} */
const nextConfig = {
  // The API routes read env vars and talk to Supabase/Gemini at request time,
  // so nothing here should be statically optimized at build time.
  reactStrictMode: true,
};

export default nextConfig;
