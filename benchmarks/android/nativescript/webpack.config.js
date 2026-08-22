const webpack = require("@nativescript/webpack");

module.exports = (env) => {
  webpack.init(env);
  webpack.chainWebpack((config) => {
    config.plugin("ForkTsCheckerWebpackPlugin").tap(([options]) => [{
      ...options,
      typescript: {
        ...options.typescript,
        typescriptPath: require.resolve("typescript"),
      },
    }]);
  });
  return webpack.resolveConfig();
};
