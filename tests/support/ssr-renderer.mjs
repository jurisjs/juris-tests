// The string renderer is the kit's (server/ssr-renderer.js), and an instance is given it as a
// feature, as the kit's server gives its own: a test that renders on the server builds its instance
// with `withSSR(options)`, which is `options` with `features.ssr` beside any features they name.
import SSRRenderer from "juris-kit/server/ssr-renderer.js";

export { SSRRenderer };

export const withSSR = (options = {}) => ({ ...options, features: { ssr: SSRRenderer, ...options.features } });
