import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  webpack: (config) => {
    // amazon-cognito-identity-js imports { get, remove } from 'js-cookie' as
    // named ESM exports, which no version of js-cookie actually provides.
    // The admin app only uses CognitoUser / CognitoUserPool — never
    // CookieStorage — so aliasing to a no-op shim silences the static
    // named-export error without any behavioral change.
    config.resolve.alias['js-cookie'] = path.resolve(
      __dirname,
      'src/lib/js-cookie-shim.mjs'
    );
    return config;
  },
};

export default nextConfig;
