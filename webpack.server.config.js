const path = require('path');
const webpack = require('webpack');
const CopyPlugin = require('copy-webpack-plugin');

try { require('dotenv').config({ quiet: true }); } catch (_) { /* optional */ }

const isDevBuild = process.env.PROXCHAT_DEV_BUILD === '1';
const cleanOutput = process.env.WEBPACK_CLEAN === '1';

module.exports = {
  mode: isDevBuild ? 'development' : 'production',
  devtool: isDevBuild ? 'source-map' : false,
  cache: {
    type: 'filesystem',
    buildDependencies: {
      config: [__filename],
    },
  },
  entry: {
    background: './src/server/background.ts',
    overlay: './src/server/overlay.ts',
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: {
          loader: 'ts-loader',
          options: { transpileOnly: true },
        },
        exclude: [/node_modules/, /\.test\.ts$/],
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  output: {
    filename: (pathData) => `${pathData.chunk?.name ?? 'chunk'}/${pathData.chunk?.name ?? 'chunk'}.js`,
    path: path.resolve(__dirname, 'dist-server'),
    clean: cleanOutput,
  },
  performance: { hints: false },
  plugins: [
    new webpack.DefinePlugin({
      __DEV_BUILD__: JSON.stringify(isDevBuild),
      __SERVER_BUILD__: JSON.stringify(true),
    }),
    new CopyPlugin({
      patterns: [
        { from: 'src/server/overlay.html', to: 'overlay/' },
        { from: 'src/overlay/overlay.css', to: 'overlay/' },
      ],
    }),
  ],
};
