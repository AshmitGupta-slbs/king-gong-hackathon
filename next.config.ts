import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * The dev overlay badge sits in the bottom-left corner, which is exactly where the README
   * screenshot needs to be clean. Off by default; `next build` never shows it anyway.
   */
  devIndicators: false,
};

export default nextConfig;
