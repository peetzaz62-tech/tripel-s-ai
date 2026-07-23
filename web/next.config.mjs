/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // the UI is a static page in /public — serve it at the site root
    return [{ source: '/', destination: '/index.html' }];
  },
};

export default nextConfig;
